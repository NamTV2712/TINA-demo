#!/usr/bin/env python3
"""Counterbalanced same-audio vocabulary pilot. Direct ASR quality/RTF, not live UI latency."""
import collections
import json
from pathlib import Path
import random
import subprocess
import sys
import time

import httpx
import soundfile as sf

from metrics import normalize, score, summarize
from run import ROOT, get, listener, sha


def prepare(manifest, output):
    output.mkdir(exist_ok=False, parents=True)
    vocab = json.loads((ROOT / 'deploy/transcription/benchmark/glossary.json').read_text())
    frozen = json.loads(manifest.read_text())
    samples = frozen['samples']
    synthetic = [
        ('Linh', 'vi', 'Nguyễn Minh và Quang đang phát triển dự án TINA.'),
        ('Linh', 'vi', 'Dự án TINA dùng FunASR để nhận dạng tiếng nói.'),
        ('Linh', 'vi', 'Quang kiểm tra API và database trước khi deploy backend.'),
        ('Linh', 'vi', 'TINA hỗ trợ Google Meet và Microsoft Teams.'),
        ('Samantha', 'en', 'Quang and Nguyen Minh are developing TINA with Qwen and FunASR.'),
        ('Samantha', 'en', 'The TINA backend exposes an API and stores meetings in a database.'),
        ('Samantha', 'en', 'We use GitHub, OpenAI, Google Meet and Microsoft Teams.'),
        ('Samantha', 'en', 'Compare Silero and FSMN VAD before deploying the speech pipeline.'),
    ]
    for i, (voice, lang, text) in enumerate(synthetic):
        aiff = output / f'tts-{i}.aiff'; target = output / f'tts-{i}.wav'
        subprocess.run(['say', '-v', voice, '-o', str(aiff), text], check=True)
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(aiff), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_f32le', str(target)], check=True)
        aiff.unlink()
        samples.append({'id': f'synthetic-domain-{i}', 'path': str(target), 'sha256': sha(target), 'reference': text,
                        'duration_s': sf.info(target).duration, 'group': f'synthetic_domain_{lang}', 'voice': voice})
    frozen.update(samples=samples, glossary=vocab, source_manifest_sha256=sha(manifest),
                  limits='Direct whole-clip ASR. Public controls are unchanged; domain clips are macOS TTS, not human speech or natural code switching. Vocabulary is fixed domain knowledge, not full reference transcripts. No production Apply/settings changes. AMI 60s files are not the production bounded segment refinement path.')
    for s in samples:
        assert sha(s['path']) == s['sha256']
    (output / 'manifest.json').write_text(json.dumps(frozen, ensure_ascii=False, indent=2))


def run(output):
    manifest = json.loads((output / 'manifest.json').read_text())
    result = output / 'results.jsonl'
    if result.exists():
        raise RuntimeError('Use a fresh output directory; results are never overwritten')
    model = listener(18000)
    if not model or 'funasr' not in ' '.join(model.cmdline()):
        raise RuntimeError('Expected existing FunASR model; no services were changed')
    before = get(8056, 'bots')
    metadata = {'started_unix': time.time(), 'asr': get(18000, 'status')['model'], 'model_pid': model.pid,
                'manifest_sha256': sha(output / 'manifest.json'), 'source_sha256': sha(__file__),
                'design': 'Seeded pair order alternates no-context/vocabulary; same waveform, all cases retained, failures scored empty. Warmups excluded.'}
    rng = random.Random(20261021)
    cases = list(manifest['samples']); rng.shuffle(cases)
    with httpx.Client(timeout=120, trust_env=False) as client, result.open('x') as log:
        for sample in manifest.get('warmup', []):
            client.post('http://127.0.0.1:18000/v1/audio/transcriptions', data={'model': 'custom'}, files={'file': ('warmup.wav', Path(sample['path']).read_bytes(), 'audio/wav')}).raise_for_status()
        for index, sample in enumerate(cases):
            while get(8056, 'health')['live_sessions'] or get(18000, 'status')['queue']['active']:
                print('Waiting for user capture/ASR', flush=True); time.sleep(2)
            assert sha(sample['path']) == sample['sha256']
            audio = Path(sample['path']).read_bytes()
            order = ['baseline', 'glossary'] if index % 2 == 0 else ['glossary', 'baseline']
            row = {k: sample.get(k) for k in ['id', 'group', 'reference', 'duration_s', 'sha256']}; row['order'] = order
            for condition in order:
                fields = {'model': 'custom', 'response_format': 'json'}
                if condition == 'glossary': fields['prompt'] = 'Vocabulary: ' + ', '.join(manifest['glossary']['terms'])
                started = time.perf_counter()
                try:
                    response = client.post('http://127.0.0.1:18000/v1/audio/transcriptions', data=fields, files={'file': ('clip.wav', audio, 'audio/wav')})
                    response.raise_for_status(); text = response.json().get('text', ''); ok = True
                    error = None
                except Exception as exc:
                    text = ''; ok = False; error = type(exc).__name__
                row[condition] = {'text': text, 'ok': ok, 'error': error, 'latency_s': time.perf_counter() - started,
                                  'duration_s': sample['duration_s'], 'score': score(sample['reference'], text)}
            log.write(json.dumps(row, ensure_ascii=False) + '\n'); log.flush()
            print(f'{index+1}/{len(cases)} {sample["id"]}', flush=True)
    metadata.update(finished_unix=time.time(), completed=len(cases), same_model_process=listener(18000).pid == model.pid,
                    production_unchanged=get(8056, 'bots') == before)
    (output / 'metadata.json').write_text(json.dumps(metadata, indent=2))
    report(output)


def report(output):
    manifest = json.loads((output / 'manifest.json').read_text())
    rows = [json.loads(line) for line in (output / 'results.jsonl').read_text().splitlines()]
    assert len(rows) == len(manifest['samples']) and len({r['id'] for r in rows}) == len(rows), 'Incomplete pilot'
    groups = collections.defaultdict(list)
    for row in rows: groups[row['group']].append(row)
    entity_results = {}
    terms = manifest['glossary']['terms']
    contains = lambda text, term: ' ' + normalize(term) + ' ' in ' ' + normalize(text) + ' '
    for condition in ['baseline', 'glossary']:
        domain = [r for r in rows if r['group'].startswith('synthetic_domain')]
        targets = [(r, term) for r in domain for term in terms if contains(r['reference'], term)]
        entity_results[condition] = {'target_mentions': len(targets), 'exact_mentions_recovered': sum(contains(r[condition]['text'], term) for r, term in targets),
                                     'extra_vocabulary_mentions': sum(contains(r[condition]['text'], term) and not contains(r['reference'], term) for r in domain for term in terms)}
    (output / 'entity-metrics.json').write_text(json.dumps(entity_results, ensure_ascii=False, indent=2))
    results = {}
    lines = ['# Vocabulary pilot', '', manifest['limits'], '', '| Group | Clips | No glossary WER | Glossary WER | Better / worse / equal |', '|---|---:|---:|---:|---:|']
    for name, group in sorted(groups.items()):
        before = summarize([r['baseline'] for r in group]); after = summarize([r['glossary'] for r in group])
        diff = [r['glossary']['score']['word_errors'] - r['baseline']['score']['word_errors'] for r in group]
        results[name] = {'baseline': before, 'glossary': after, 'better': sum(d < 0 for d in diff), 'worse': sum(d > 0 for d in diff), 'equal': sum(d == 0 for d in diff)}
        b, a = before['wer'], after['wer']
        lines.append(f'| {name} | {len(group)} | {100*b:.2f}% | {100*a:.2f}% | {sum(d<0 for d in diff)} / {sum(d>0 for d in diff)} / {sum(d==0 for d in diff)} |' if b is not None else f'| {name} | {len(group)} | non-speech | non-speech | {sum(d<0 for d in diff)} / {sum(d>0 for d in diff)} / {sum(d==0 for d in diff)} |')
    (output / 'summary.json').write_text(json.dumps(results, indent=2))
    lines += ['', 'Synthetic domain exact vocabulary mentions: ' + '; '.join(f'{k}: {v["exact_mentions_recovered"]}/{v["target_mentions"]}, extra terms {v["extra_vocabulary_mentions"]}' for k, v in entity_results.items()), '', 'Vocabulary remains opt-in. This small pilot cannot establish accuracy for the user\'s proper names or real Vietnamese-English switching. No live pipeline settings were changed.']
    (output / 'REPORT.md').write_text('\n'.join(lines) + '\n')


if __name__ == '__main__':
    action, *args = sys.argv[1:]
    if action == 'prepare': prepare(Path(args[0]), Path(args[1]))
    elif action == 'run': run(Path(args[0]))
    elif action == 'report': report(Path(args[0]))
    else: raise SystemExit('prepare MANIFEST OUTPUT | run OUTPUT | report OUTPUT')
