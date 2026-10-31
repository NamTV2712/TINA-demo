"""Freeze cached VI/EN clips, execute real MPS token callbacks, and report a paired pilot."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request

import numpy as np
import psutil
import soundfile as sf

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'deploy/transcription/benchmark'))
from metrics import percentile, score
from run import RssSampler

REVISION = '5eb144179a02acc5e5ba31e748d22b0cf3e303b0'


def write_json(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def production():
    result = {}
    for port, path in [(8056, 'health'), (18000, 'status')]:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/{path}', timeout=4) as response:
            data = json.load(response)
        if data.get('live_sessions', 0) or data.get('queue', {}).get('active', 0) or data.get('queue', {}).get('waiting', 0):
            raise RuntimeError('Wait until Desktop and the existing ASR are idle')
        pid = subprocess.check_output(['lsof', '-t', f'-iTCP:{port}', '-sTCP:LISTEN'], text=True).strip()
        if not pid.isdigit():
            raise RuntimeError('Expected exactly one production listener')
        result[str(port)] = {'pid': int(pid), 'started': psutil.Process(int(pid)).create_time(), 'model': data.get('model')}
    return result


def prepare(cache, output, before):
    dataset = json.loads((cache / 'manifest.json').read_text())
    selected = []
    for language in ['vi_vn', 'en_us']:
        available = sorted((s for s in dataset['samples'] if s['role']=='test' and s['config']==language and s['duration_s']<=15), key=lambda s:s['selection_index'])
        if len(available)<3:
            raise ValueError('Need three cached test clips per language under 15 seconds')
        selected.extend({**item, 'group': language} for item in available[:3])
    # Concatenation controls are not natural bilingual/code-switching recordings.
    pairs = [next(s for s in sorted(dataset['samples'], key=lambda s:s.get('selection_index',999))
                  if s['role']=='test' and s.get('config')==language and s['duration_s']<=(15-.3)/2) for language in ['vi_vn','en_us']]
    for reverse in [False, True]:
        ordered = list(reversed(pairs)) if reverse else pairs
        audios = []
        for sample in ordered:
            audio, rate = sf.read(sample['path'], dtype='float32'); assert rate==16000 and audio.ndim==1
            audios.extend([audio, np.zeros(4800, dtype='float32')])
        path = output / ('en-vi.wav' if reverse else 'vi-en.wav')
        sf.write(path, np.concatenate(audios[:-1]), 16000, subtype='PCM_16')
        selected.append({'id':path.stem,'path':str(path),'reference':' '.join(s['reference'] for s in ordered),
                         'group':'concatenation_control','duration_s':sf.info(path).duration,
                         'sha256':hashlib.sha256(path.read_bytes()).hexdigest(), 'source_ids':[s['id'] for s in ordered]})
    silence = output / 'silence.wav'; sf.write(silence, np.zeros(32000), 16000, subtype='PCM_16')
    selected.append({'id':'silence','path':str(silence),'reference':'','group':'silence','duration_s':2,
                     'sha256':hashlib.sha256(silence.read_bytes()).hexdigest()})
    for sample in selected:
        if sample['duration_s']>15 or hashlib.sha256(Path(sample['path']).read_bytes()).hexdigest()!=sample['sha256']:
            raise ValueError('Fixture checksum/duration mismatch')
    cases = []
    for i, sample in enumerate(selected):
        # Alternate full-file order; paced variants always follow, so warm-history remains a limitation.
        modes = ['batch','tokens'] if i%2==0 else ['tokens','batch']
        for mode in [*modes, 'paced-1s', 'paced-2s']:
            cases.append({**sample,'mode':mode})
    warmup = next(s['path'] for s in dataset['samples'] if s['role']=='warmup' and s['config']=='vi_vn' and s['duration_s']<=15)
    checkpoint = Path.home()/'.cache/huggingface/hub/models--Qwen--Qwen3-ASR-0.6B/snapshots'/REVISION
    if not (checkpoint/'config.json').is_file():
        raise ValueError('Pinned Qwen checkpoint is not cached; this PoC does not download weights')
    manifest = {'checkpoint':str(checkpoint),'revision':REVISION,'dataset_manifest':str(cache/'manifest.json'),
                'warmup':warmup,'samples':selected,'cases':cases,'max_utterance_s':15,'max_new_tokens':256,
                'production_before':before,
                'source_sha256':{name:hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in ['decoder.py','worker.py','run.py']}}
    write_json(output/'input.json', manifest)
    return manifest


def report(output, manifest, peak_rss, before, after):
    rows = [json.loads(line) for line in (output/'results.jsonl').read_text().splitlines()]
    expected = {(s['id'],s['mode']) for s in manifest['cases']}
    if {(r['id'],r['mode']) for r in rows}!=expected or len(rows)!=len(expected):
        raise RuntimeError('Incomplete experiment; no complete benchmark report can be published')
    references = {s['id']:s['reference'] for s in manifest['samples']}
    groups = {s['id']:s['group'] for s in manifest['samples']}
    for row in rows:
        row['score'] = score(references[row['id']], row['text'] if row['ok'] else '')
    summary = {'production_unchanged':before==after,'worker_peak_rss_mib':peak_rss/1024**2,'groups':{}}
    lines = ['# Local Qwen token-streaming pilot','',
      'Real decoder callbacks on MPS; no production service/settings changes. Three cached human-recorded clips per language; concatenations are controls, not natural code switching. No VAD, hardware capture, browser paint or native incremental audio encoder is measured.','',
      '| Group | Mode | Clips | Failures | WER % | CER % | First visible p50/p95 s | Wall p50/p95 s | Final tail p50/p95 s |',
      '|---|---|---:|---:|---:|---:|---|---|---|']
    for group in ['vi_vn','en_us','concatenation_control','silence']:
        for mode in ['batch','tokens','paced-1s','paced-2s']:
            batch=[r for r in rows if groups[r['id']]==group and r['mode']==mode]
            words=sum(r['score']['ref_words'] for r in batch); chars=sum(r['score']['ref_chars'] for r in batch)
            entry={'clips':len(batch),'failures':sum(not r['ok'] for r in batch),
              'wer':sum(r['score']['word_errors'] for r in batch)/words if words else None,
              'cer':sum(r['score']['char_errors'] for r in batch)/chars if chars else None,
              'first_text_p50_s':percentile([r.get('first_text_s') for r in batch],.5),
              'first_text_p95_s':percentile([r.get('first_text_s') for r in batch],.95),
              'first_token_p50_s':percentile([r.get('first_token_s') for r in batch],.5),
              'first_token_p95_s':percentile([r.get('first_token_s') for r in batch],.95),
              'wall_p50_s':percentile([r['wall_s'] for r in batch],.5),'wall_p95_s':percentile([r['wall_s'] for r in batch],.95),
              'tail_p50_s':percentile([r.get('finalization_tail_s') for r in batch],.5),'tail_p95_s':percentile([r.get('finalization_tail_s') for r in batch],.95),
              'visible_events':sum(r.get('visible_events',0) for r in batch),'during_generate_events':sum(r.get('during_generate_events',0) for r in batch),
              'tail_replacements':sum(r.get('replacements',0) for r in batch),
              'nonempty_outputs':sum(bool(r.get('text','').strip()) for r in batch),
              'final_eligible':sum(r.get('eligible',False) for r in batch)}
            summary['groups'][group+':'+mode]=entry
            number=lambda n:'—' if n is None else f'{n:.3f}'
            lines.append(f"| {group} | {mode} | {len(batch)} | {entry['failures']} | {number(entry['wer']*100 if words else None)} | {number(entry['cer']*100 if chars else None)} | {number(entry['first_text_p50_s'])} / {number(entry['first_text_p95_s'])} | {number(entry['wall_p50_s'])} / {number(entry['wall_p95_s'])} | {number(entry['tail_p50_s'])} / {number(entry['tail_p95_s'])} |")
    speech=[r for r in rows if r['mode']=='tokens' and groups[r['id']] in ('vi_vn','en_us')]
    summary['decoder_stream_proven']=all(r['ok'] and r.get('during_generate_events',0)>1 and r['first_text_s']<r['wall_s'] for r in speech)
    summary['full_file_text_matches_batch']=all(next(r for r in rows if r['id']==s['id'] and r['mode']=='tokens')['text']==next(r for r in rows if r['id']==s['id'] and r['mode']=='batch')['text'] for s in manifest['samples'])
    summary['max_observed_post_window_mps_driver_mib']=max((w['mps_driver_mib'] for r in rows for w in r.get('windows',[])),default=0)
    lines.extend(['',f"- Decoder streaming proven: {summary['decoder_stream_proven']}; full-file text matches batch: {summary['full_file_text_matches_batch']}.",
      f'- Worker peak sampled RSS: {peak_rss/1024**2:.1f} MiB. MPS driver allocation is a post-window snapshot, not a true GPU peak; do not add RSS and Metal allocations as disjoint RAM.',
      '- First-visible latency for paced modes includes simulated audio arrival. Batch/tokens modes receive the complete clip first. Wall time is not microphone-to-screen latency.',
      '- Percentiles are descriptive (three clips/language); paced chunk hypotheses reuse accumulating audio and rollback five prefix tokens after the first two chunks. No encoder/KV reuse across audio chunks is claimed.',
      '- Keep the production backend until a larger accuracy/concurrency test validates the streaming adapter.'])
    write_json(output/'scored-results.json',rows);write_json(output/'summary.json',summary)
    (output/'report.md').write_text('\n'.join(lines)+'\n')
    return summary


def main():
    os.umask(0o077)
    cache, output = [Path(arg).expanduser().resolve() for arg in sys.argv[1:3]]
    if output==ROOT or ROOT in output.parents:
        raise ValueError('Keep audio/transcripts/results outside the repository')
    before=production(); output.mkdir(parents=True,exist_ok=False,mode=0o700)
    write_json(output/'production-before.json',before)
    manifest=prepare(cache,output,before)
    command=[str(ROOT/'.venv/funasr/bin/python'),str(Path(__file__).with_name('worker.py')),str(output/'input.json')]
    if '--show-events' in sys.argv: command.append('--show-events')
    with (output/'worker.log').open('x') as log:
        process=subprocess.Popen(command,stderr=log)
        with RssSampler(process.pid) as rss: code=process.wait()
    try: after=production()
    except Exception as error: after={'unavailable':type(error).__name__}
    write_json(output/'production-check.json',{'before':before,'after':after})
    source_unchanged=all(hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()==digest for name,digest in manifest['source_sha256'].items())
    if code or before!=after or not source_unchanged:
        raise RuntimeError('Experiment incomplete or production identity changed; inspect worker.log, no full score claimed')
    summary=report(output,manifest,rss.peak,before,after)
    print(json.dumps({'report':str(output/'report.md'),'decoder_stream_proven':summary['decoder_stream_proven'],
                      'full_file_text_matches_batch':summary['full_file_text_matches_batch'],'peak_rss_mib':summary['worker_peak_rss_mib']}))


if __name__ == '__main__': main()
