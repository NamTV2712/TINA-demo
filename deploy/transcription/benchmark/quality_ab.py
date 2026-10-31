"""Freeze annotation-selected AMI excerpts, then compare direct HTTP and live Desktop output."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

import jiwer
import soundfile as sf
from metrics import normalize, score


def overlap_seconds(words, start, end):
    events = []
    for word in words:
        left, right = max(start, word['start']), min(end, word['end'])
        if left < right:
            events.extend([(left, word['speaker'], 1), (right, word['speaker'], -1)])
    active, previous, overlap = {}, start, 0
    for at, speaker, delta in sorted(events):
        if sum(value > 0 for value in active.values()) > 1:
            overlap += at - previous
        active[speaker] = active.get(speaker, 0) + delta
        previous = at
    return overlap


def select_excerpts(words, duration):
    candidates = []
    for start in range(0, int(duration) - 59, 60):
        selected = [w for w in words if start <= (w['start'] + w['end']) / 2 < start + 60]
        if len(selected) >= 100:
            candidates.append({'start_s': start, 'end_s': start + 60, 'reference_words': len(selected),
                               'overlap_s': overlap_seconds(words, start, start + 60)})
    assert len(candidates) >= 4, 'Need four disjoint speech-rich excerpts'
    ordered = sorted(candidates, key=lambda row: (row['overlap_s'], row['start_s']))
    return sorted([{**c, 'condition': label} for label, rows in [('low-overlap', ordered[:2]), ('high-overlap', ordered[-2:])]
                   for c in rows], key=lambda row: row['start_s'])


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def prepare(base, output):
    base, output = Path(base), Path(output)
    assert not output.exists(), 'Never overwrite a frozen experiment'
    parent = json.loads((base / 'acceptance.json').read_text())
    audio = Path(parent['audio_path'])
    assert digest(audio) == parent['audio_sha256']
    reference_file = Path(parent['reference_path'])
    words = json.loads(reference_file.read_text())['words']
    pcm, rate = sf.read(audio, dtype='int16')
    assert rate == 16000 and pcm.ndim == 1
    output.mkdir(mode=0o700, parents=True)
    clips = []
    for selected in select_excerpts(words, len(pcm) / rate):
        start, end = selected['start_s'], selected['end_s']
        name = f'EN2002c-{start:04d}-{end:04d}'
        wav = output / f'{name}.wav'
        sf.write(wav, pcm[start * rate:end * rate], rate, subtype='PCM_16')
        refs = [{**w, 'start': w['start'] - start, 'end': w['end'] - start}
                for w in words if start <= (w['start'] + w['end']) / 2 < end]
        manifest = {**selected, 'purpose': 'smoke', 'meeting_id': name, 'audio_path': str(wav.resolve()),
                    'audio_sha256': digest(wav), 'source_seconds': 60, 'reference': refs,
                    'boundary_crossing_words': sum(w['start'] < 0 or w['end'] > 60 for w in refs)}
        path = output / f'{name}.json'
        path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
        clips.append(str(path.resolve()))
    plan = {'selection': 'Two lowest and two highest annotated overlap among disjoint 60 s bins with >=100 words; ties by source start. No ASR outputs used.',
            'reference_rule': 'Words whose annotation midpoint lies inside the excerpt; boundary crossings disclosed.',
            'audio_sha256': parent['audio_sha256'], 'reference_sha256': digest(reference_file), 'clips': clips,
            'direct_window_seconds': 15, 'language': 'en', 'model': 'custom', 'endpoint': 'http://127.0.0.1:18000',
            'limits': ['Diagnostic extremes, not a representative quality estimate or new acceptance run.',
                       'Live run includes the same halfway reconnect as the baseline; direct windows have no continuity prompt.']}
    (output / 'plan.json').write_text(json.dumps(plan, indent=2) + '\n')
    print(json.dumps({'clips': clips, 'total_seconds': 240}))


def scored(reference, hypothesis):
    result = score(reference, hypothesis)
    result = {k: v for k, v in result.items() if not k.startswith('normalized_')}
    return {**result, 'wer': result['word_errors'] / result['ref_words'], 'cer': result['char_errors'] / result['ref_chars']}


def examples(reference, hypothesis):
    alignment = jiwer.process_words(normalize(reference), normalize(hypothesis))
    refs, hyps = alignment.references[0], alignment.hypotheses[0]
    return [{'kind': b.type, 'reference': ' '.join(refs[b.ref_start_idx:b.ref_end_idx]),
             'hypothesis': ' '.join(hyps[b.hyp_start_idx:b.hyp_end_idx])}
            for b in alignment.alignments[0] if b.type != 'equal'][:12]


def exact_reference_hits(reference, hypothesis):
    alignment = jiwer.process_words(reference, normalize(hypothesis))
    return {i for b in alignment.alignments[0] if b.type == 'equal' for i in range(b.ref_start_idx, b.ref_end_idx)}


def aggregate(scores):
    counts = {key: sum(row[key] for row in scores) for key in
              ['ref_words', 'word_errors', 'substitutions', 'deletions', 'insertions', 'ref_chars', 'char_errors']}
    return {**counts, 'wer': counts['word_errors'] / counts['ref_words'], 'cer': counts['char_errors'] / counts['ref_chars']}


def audit_requests(words, requests, final_text):
    tokens = [(token, w) for w in words for token in normalize(w['text']).split()]
    reference = ' '.join(token for token, _ in tokens)
    final_hits = exact_reference_hits(reference, final_text)
    submitted, raw_hits, details = set(), set(), []
    for request in requests:
        start = request['source_start_sample']
        if start is None:
            continue
        left, right = start / 16000, (start + request['samples']) / 16000
        indices = [i for i, (_, w) in enumerate(tokens) if left <= (w['start'] + w['end']) / 2 < right]
        submitted.update(indices)
        raw_text = request.get('response', {}).get('text', '')
        if not indices:
            continue
        ref = ' '.join(tokens[i][0] for i in indices)
        raw_hits.update(indices[i] for i in exact_reference_hits(ref, raw_text))
        details.append({'request_id': request['id'], 'start_s': left, 'end_s': right,
                        'http_status': request['http_status'], 'score': scored(ref, raw_text)})
    lost = sorted(raw_hits - final_hits)
    return {'reference_tokens': len(tokens), 'tokens_outside_uniquely_matched_requests': len(tokens) - len(submitted),
            'tokens_submitted_but_not_exact_matched_in_any_raw_response': len(submitted - raw_hits),
            'tokens_exact_matched_in_some_raw_response_but_not_final': len(lost),
            'examples_lost_after_some_raw_match': [{'token': tokens[i][0], 'start_s': tokens[i][1]['start'],
                                                   'end_s': tokens[i][1]['end']} for i in lost[:12]],
            'requests': details,
            'interpretation': 'Selective string-alignment diagnostic. Repeated/overlapping words can align ambiguously; raw partial matches do not prove a finalization bug.'}


def report(output):
    output = Path(output)
    assert json.loads((output / 'run.json').read_text())['status'] == 'complete'
    plan = json.loads((output / 'plan.json').read_text())
    rows = []
    for path in plan['clips']:
        clip = json.loads(Path(path).read_text()); name = clip['meeting_id']
        summary = json.loads((output / name / 'summary.json').read_text())
        assert summary['status'] == 'complete'
        direct = json.loads((output / f'{name}-direct.json').read_text())
        text_direct = ' '.join(w['result']['text'] for w in direct)
        with sqlite3.connect(f'file:{output}/{name}/journal/transcripts.sqlite?mode=ro', uri=True) as db:
            meeting = json.loads(db.execute('SELECT document FROM meetings').fetchone()[0])
        text_live = ' '.join(s['text'] for s in sorted(meeting['segments'], key=lambda s: (s['start'], s['segment_id'])))
        reference = ' '.join(w['text'] for w in clip['reference'])
        requests = [json.loads(line) for line in (output / f'{name}-requests.jsonl').read_text().splitlines()]
        live_requests = [r for r in requests if r['path'] == 'live']
        row = {k: clip[k] for k in ['meeting_id', 'condition', 'start_s', 'overlap_s', 'boundary_crossing_words']}
        row.update(direct=scored(reference, text_direct), live=scored(reference, text_live),
                   live_requests=len(live_requests), live_request_audio_s=sum(r['samples'] / 16000 for r in live_requests),
                   live_unmatched_audio_requests=sum(r['source_start_sample'] is None for r in live_requests),
                   http_failures=sum(r['http_status'] >= 400 for r in requests),
                   direct_errors=examples(reference, text_direct), live_errors=examples(reference, text_live),
                   request_audit=audit_requests(clip['reference'], live_requests, text_live))
        rows.append(row)
    result = {'kind': 'paired-quality-diagnostic', 'plan': plan, 'rows': rows,
              'aggregate': {mode: aggregate([row[mode] for row in rows]) for mode in ['direct', 'live']},
              'limits': plan['limits'] + ['Different window boundaries/prompts/confirmation. A WER difference alone does not identify a causal component.',
                                         'Mixed overlapping reference scored chronologically, not official AMI/cpWER.']}
    (output / 'report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    table = ['# Paired AMI quality diagnostic', '', '| Excerpt | Overlap (s) | Direct WER / CER | Live WER / CER |', '|---|---:|---:|---:|']
    for row in rows:
        table.append(f"| {row['meeting_id']} | {row['overlap_s']:.2f} | {row['direct']['wer']:.2%} / {row['direct']['cer']:.2%} | {row['live']['wer']:.2%} / {row['live']['cer']:.2%} |")
    table += ['', 'Aggregate sums errors and reference counts per excerpt; words cannot align across excerpt boundaries.', '',
              json.dumps(result['aggregate'], indent=2), '', *result['limits']]
    (output / 'REPORT.md').write_text('\n'.join(table) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k not in ['plan', 'rows']}, ensure_ascii=False))


if __name__ == '__main__':
    if sys.argv[1] == 'prepare':
        prepare(*sys.argv[2:])
    else:
        assert sys.argv[1] == 'report'
        report(sys.argv[2])
