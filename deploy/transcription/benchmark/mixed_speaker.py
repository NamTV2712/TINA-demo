"""Frozen paired native-headset/mixed ASR diagnostic; never edits production transcripts."""
import hashlib
import json
from functools import lru_cache
from pathlib import Path
import random
import sys
import xml.etree.ElementTree as ET
import zipfile

import numpy as np
import soundfile as sf
from metrics import normalize, score, percentile
from quality_ab import aggregate, overlap_seconds

SEED = 20261026
RATE = 16000


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def interleaving(words, hypothesis):
    """Minimum word edit distance over reference orders preserving speaker and time order.

    Every hypothesis token is consumed once. Only reference words overlapping in time may
    exchange order across speakers. CER uses the chosen WER-optimal whole-word order.
    """
    speakers = sorted({w['speaker'] for w in words})
    streams = [[(token, w) for w in words if w['speaker'] == s for token in normalize(w['text']).split()] for s in speakers]
    tokens = normalize(hypothesis).split()
    sizes = tuple(map(len, streams))
    earliest_remaining_end = []
    for stream in streams:
        ends = [float('inf')] * (len(stream) + 1)
        for i in range(len(stream) - 1, -1, -1):
            ends[i] = min(ends[i + 1], stream[i][1]['end'])
        earliest_remaining_end.append(ends)
    choices = {}

    @lru_cache(None)
    def visit(positions, k):
        if positions == sizes and k == len(tokens):
            return (0, 0, 0, 0)  # E, I, D, S: deterministic tie break
        candidates = []
        if k < len(tokens):
            tail = visit(positions, k + 1)
            candidates.append(((tail[0] + 1, tail[1] + 1, tail[2], tail[3]), ('insert', None)))
        for s, pos in enumerate(positions):
            if pos == sizes[s]:
                continue
            token, word = streams[s][pos]
            # A non-overlapping earlier word from another speaker must be consumed first.
            if any(i != s and earliest_remaining_end[i][p] <= word['start'] for i, p in enumerate(positions)):
                continue
            advanced = positions[:s] + (pos + 1,) + positions[s + 1:]
            tail = visit(advanced, k)
            candidates.append(((tail[0] + 1, tail[1], tail[2] + 1, tail[3]), ('delete', s)))
            if k < len(tokens):
                error = int(token != tokens[k])
                tail = visit(advanced, k + 1)
                candidates.append(((tail[0] + error, tail[1], tail[2], tail[3] + error), ('substitute' if error else 'equal', s)))
        assert candidates, 'Reference time/speaker order is inconsistent'
        best = min(candidates, key=lambda x: x[0])
        choices[(positions, k)] = best[1]
        return best[0]

    positions, k = (0,) * len(speakers), 0
    e, ins, dele, sub = visit(positions, k)
    ordered, deleted_words = [], []
    attribution = {s: {'hits': 0, 'substitutions': 0, 'deletions': 0} for s in speakers}
    activity = {g: {'hits': 0, 'substitutions': 0, 'deletions': 0} for g in ('overlap', 'non-overlap')}
    while positions != sizes or k < len(tokens):
        op, s = choices[(positions, k)]
        if op != 'insert':
            token, word = streams[s][positions[s]]
            ordered.append(token)
            if op == 'delete':
                deleted_words.append({**word, 'token': token})
            attribution[speakers[s]][{'equal': 'hits', 'substitute': 'substitutions', 'delete': 'deletions'}[op]] += 1
            activity['overlap' if word.get('overlap') else 'non-overlap'][{'equal': 'hits', 'substitute': 'substitutions', 'delete': 'deletions'}[op]] += 1
            positions = positions[:s] + (positions[s] + 1,) + positions[s + 1:]
        if op != 'delete':
            k += 1
    result = score(' '.join(ordered), hypothesis)
    result.update(word_errors=e, substitutions=sub, deletions=dele, insertions=ins)
    return {k: v for k, v in result.items() if not k.startswith('normalized_')} | {'attribution': attribution, 'reference_activity': activity, 'deleted_words': deleted_words}


def annotations(archive, meeting):
    with zipfile.ZipFile(archive) as z:
        metadata = ET.fromstring(z.read('corpusResources/meetings.xml'))
        node = next(e for e in metadata.iter('meeting') if e.get('observation') == meeting)
        mapping = {e.get('nxt_agent'): int(e.get('channel')) for e in node.iter('speaker')}
        assert len(mapping) == 4 and set(mapping.values()) == {0, 1, 2, 3}
        words = []
        for speaker in sorted(mapping):
            tree = ET.fromstring(z.read(f'words/{meeting}.{speaker}.words.xml'))
            for word in tree.iter('w'):
                if word.get('punc') == 'true' or not normalize(word.text or '') or not word.get('starttime'):
                    continue
                start, end = float(word.get('starttime')), float(word.get('endtime'))
                assert 0 <= start < end
                words.append({'speaker': speaker, 'start': start, 'end': end, 'text': word.text})
    return mapping, sorted(words, key=lambda w: (w['start'], w['speaker']))


def select(words):
    candidates = []
    for tick in range(120, int(max(w['end'] for w in words) * 4) - 40):
        start, end = tick / 4, tick / 4 + 10
        if any(w['start'] < edge + .1 and w['end'] > edge - .1 for w in words for edge in (start, end)):
            continue
        refs = [w for w in words if start <= w['start'] and w['end'] <= end]
        if not 8 <= len(refs) <= 50:
            continue
        speakers = sorted({w['speaker'] for w in refs})
        overlap = overlap_seconds(refs, start, end)
        group = 'non-overlap' if len(speakers) == 1 else 'low-overlap' if 0 < overlap <= .8 else 'high-overlap' if overlap >= .9 else None
        if group:
            candidates.append({'start_s': start, 'end_s': end, 'overlap_s': overlap, 'stratum': group, 'speakers': speakers})
    chosen = []
    for group in ('high-overlap', 'low-overlap', 'non-overlap'):
        pool = [c for c in candidates if c['stratum'] == group]
        pool.sort(key=lambda c: ((-c['overlap_s'] if group == 'high-overlap' else c['overlap_s']), c['start_s']))
        if group == 'non-overlap':
            random.Random(SEED).shuffle(pool)
            # Include distinct available headset speakers before filling the fourth control.
            pool.sort(key=lambda c: c['speakers'])
            buckets = {s: [c for c in pool if c['speakers'] == [s]] for s in 'ABCD'}
            pool = [c for i in range(max(map(len, buckets.values()))) for s in 'ABCD' if i < len(buckets[s]) for c in [buckets[s][i]]]
        count = 0
        for case in pool:
            if all(abs(case['start_s'] - p['start_s']) >= 12 for p in chosen):
                chosen.append(case); count += 1
                if count == 4:
                    break
        assert count == 4, f'Insufficient disjoint {group} windows; do not silently relax selection'
    warmup = next(c for c in sorted(candidates, key=lambda c: c['start_s']) if all(abs(c['start_s'] - p['start_s']) >= 12 for p in chosen))
    return sorted(chosen, key=lambda c: c['start_s']), warmup


def prepare(source, output):
    source, output = Path(source).expanduser().resolve(), Path(output).expanduser().resolve()
    repo = Path(__file__).resolve().parents[3]
    assert output != repo and repo not in output.parents, 'Benchmark audio must stay outside the checkout'
    assert not output.exists(), 'Never overwrite a frozen experiment'
    metadata = json.loads((source.parent / 'source-manifest.json').read_text())
    for row in metadata['files']:
        assert sha(row['path']) == row['sha256']
    meeting = metadata['meeting']
    mapping, words = annotations(source / 'ami_public_manual_1.6.2.zip', meeting)
    chosen, warmup = select(words)
    files = {s: sf.read(source / f'{meeting}.Headset-{channel}.wav', dtype='int16') for s, channel in mapping.items()}
    official, rate = sf.read(source / f'{meeting}.Mix-Headset.wav', dtype='int16')
    assert rate == RATE and official.ndim == 1
    assert all(r == RATE and x.ndim == 1 and len(x) == len(official) for x, r in files.values()), 'Native streams must be synchronized mono PCM16/16 kHz'
    output.mkdir(mode=0o700); (output / 'audio').mkdir(mode=0o700)
    cases = []
    for i, c in enumerate([warmup] + chosen):
        start, end = int(c['start_s'] * RATE), int(c['end_s'] * RATE)
        assert end <= len(official)
        components = {s: np.rint(x[start:end].astype(np.float64) / 4).astype(np.int16) for s, (x, _) in files.items()}
        mix = sum(x.astype(np.int32) for x in components.values())
        assert mix.min() >= -32768 and mix.max() <= 32767, 'No clipping or hidden limiter allowed'
        arms = {'official-mix': official[start:end], 'controlled-mix': mix.astype(np.int16), **{'headset-' + s: x for s, x in components.items()}}
        refs = [{**w, 'start': w['start'] - c['start_s'], 'end': w['end'] - c['start_s']} for w in words if c['start_s'] <= w['start'] and w['end'] <= c['end_s']]
        row = {**c, 'id': f'{meeting}-{start}-{end}', 'role': 'warmup' if i == 0 else 'test', 'reference': refs, 'start_sample': start, 'end_sample': end, 'arms': {}}
        for arm, pcm in arms.items():
            path = output / 'audio' / f'{row["id"]}-{arm}.wav'
            sf.write(path, pcm, RATE, subtype='PCM_16')
            samples = pcm.astype(np.float64) / 32768
            wire = np.floor(np.where(samples < 0, samples * 32768, samples * 32767) + .5).astype('<i2')
            row['arms'][arm] = {'path': str(path.resolve()), 'sha256': sha(path), 'wire_pcm_sha256': hashlib.sha256(wire.tobytes()).hexdigest(), 'rms': float(np.sqrt(np.mean(samples ** 2))), 'peak': float(np.max(np.abs(samples)))}
        cases.append(row)
    rng = random.Random(SEED); schedule = []
    for rep in range(3):
        blocks = [c for c in cases if c['role'] == 'test']; rng.shuffle(blocks)
        for c in blocks:
            arms = list(c['arms']); rng.shuffle(arms)
            schedule.extend({'case': c['id'], 'arm': a, 'repeat': rep} for a in arms)
    plan = {'version': 1, 'meeting': meeting, 'seed': SEED, 'source': metadata, 'mapping': mapping, 'gain': .25, 'duration_s': 10, 'repeats': 3,
            'selection': '4 disjoint windows/stratum; grid 250ms, >=100ms annotation silence at edges, 8..50 words; high overlap>=0.9s/10s (relative, not majority overlap), low 0<overlap<=0.8s; non-overlap one speaker; 12s start separation; no ASR-based selection.',
            'scoring': 'Mixed: minimum word edit distance over speaker-order/time-preserving reference interleavings, each hypothesis token once; CER at deterministic WER-optimal whole-word ordering. Not official AMI/cpWER. Headsets: each channel against its own reference; active-channel totals primary, inactive-channel insertions separate. No hypothesis reuse across speakers.',
            'asr': {'url': 'http://127.0.0.1:18000', 'model': 'custom', 'language': 'en', 'prompt': None, 'max_speech_duration_s': 15, 'min_silence_duration_ms': 100},
            'decision': 'Diagnostic support for source separation only if high-overlap active-headset micro WER improves >=10 percentage points over controlled-mix oracle WER in all repeats, S/D both decrease, and non-overlap micro WER regresses <=2 points. Descriptive within one meeting; never a release gate waiver.',
            'limits': ['Native close-talk channels may contain crosstalk; not algorithmic separation or perfectly isolated voices.', 'One scenario meeting; repeated requests are repeatability checks, not independent meetings.', 'Official mixed processing is unknown: controlled sum/headset comparison holds component gain and quantization fixed.', 'Fixed-window finalization check cannot exonerate live scheduling/multi-window dedup/revision paths.'], 'cases': cases, 'schedule': schedule}
    (output / 'plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'cases': [(c['role'], c['stratum'], c['start_s'], c['overlap_s']) for c in cases], 'requests': len(schedule)}))


def report(directory):
    root = Path(directory); plan = json.loads((root / 'plan.json').read_text()); run = json.loads((root / 'run.json').read_text())
    assert run['status'] == 'complete'
    assert len(run['rows']) == len(plan['schedule'])
    cases = {c['id']: c for c in plan['cases']}; detailed = []; totals = {}
    for row in run['rows']:
        c = cases[row['case']]
        words = [{**w, 'overlap': any(o['speaker'] != w['speaker'] and o['start'] <= (w['start'] + w['end']) / 2 < o['end'] for o in c['reference'])} for w in c['reference']]
        speaker = row['arm'].removeprefix('headset-') if row['arm'].startswith('headset-') else None
        refs = [w for w in words if w['speaker'] == speaker] if speaker else words
        raw = interleaving(refs, row['raw']['text'])
        final = interleaving(refs, row['final_text']) if row['finalization_comparable'] else None
        active = speaker is None or speaker in c['speakers']
        arm = 'active-headsets' if speaker and active else 'inactive-headsets' if speaker else row['arm']
        key = (c['stratum'], row['repeat'], arm)
        totals.setdefault(key, []).append(raw)
        detailed.append({k: row[k] for k in ('case', 'repeat', 'arm', 'http_ms', 'finalize_ms')} | {'stratum': c['stratum'], 'active': active, 'raw_score': raw, 'final_score': final, 'raw_text': row['raw']['text'], 'final_text': row['final_text'], 'client_text': row['decoded']['text']})
    summary = [{'stratum': g, 'repeat': rep, 'arm': arm, **aggregate(rows)} for (g, rep, arm), rows in sorted(totals.items()) if arm != 'inactive-headsets']
    negatives = [{'stratum': g, 'repeat': rep, 'insertions': sum(s['insertions'] for s in rows), 'requests': len(rows)} for (g, rep, arm), rows in sorted(totals.items()) if arm == 'inactive-headsets']
    decisions = []
    for rep in range(3):
        get = lambda g, arm: next(r for r in summary if r['stratum'] == g and r['repeat'] == rep and r['arm'] == arm)
        m, h = get('high-overlap', 'controlled-mix'), get('high-overlap', 'active-headsets')
        n, p = get('non-overlap', 'controlled-mix'), get('non-overlap', 'active-headsets')
        decisions.append({'repeat': rep, 'high_overlap_wer_improvement_pp': 100 * (m['wer'] - h['wer']), 'non_overlap_regression_pp': 100 * (p['wer'] - n['wer']), 'passes': m['wer'] - h['wer'] >= .10 and h['substitutions'] < m['substitutions'] and h['deletions'] < m['deletions'] and p['wer'] - n['wer'] <= .02})
    per_speaker = []
    for group in ('non-overlap', 'low-overlap', 'high-overlap'):
        for rep in range(3):
            for speaker in plan['mapping']:
                rows = [r['raw_score'] for r in detailed if r['arm'] == 'headset-' + speaker and r['active'] and r['stratum'] == group and r['repeat'] == rep]
                if rows:
                    per_speaker.append({'stratum': group, 'repeat': rep, 'speaker': speaker, **aggregate(rows)})
    cost = []
    source_seconds = sum(c['role'] == 'test' for c in plan['cases']) * plan['duration_s'] * plan['repeats']
    for arm in ('official-mix', 'controlled-mix', 'all-headsets'):
        rows = [r for r in run['rows'] if r['arm'].startswith('headset-') == (arm == 'all-headsets') and (arm == 'all-headsets' or r['arm'] == arm)]
        times = [r['http_ms'] for r in rows]
        cost.append({'arm': arm, 'requests': len(rows), 'submitted_audio_s': len(rows) * plan['duration_s'], 'http_total_s': sum(times) / 1000, 'http_p50_ms': percentile(times, .5), 'http_p95_ms': percentile(times, .95), 'serial_http_seconds_per_source_second': sum(times) / 1000 / source_seconds, 'max_pre_post_sampled_rss_bytes': max(r['sampled_rss_bytes'] for r in rows)})
    preservation = {'source_pcm_changed': sum(not r['source_pcm_unchanged'] for r in run['rows']), 'reference_words_crossing_request_edges': sum(not (0 <= w['start'] < w['end'] <= plan['duration_s']) for c in cases.values() for w in c['reference']),
                    'non_equivalent_finalization_requests': sum(not r['finalization_comparable'] for r in run['rows']), 'raw_to_client_text_changes': sum(normalize(r['raw']['text']) != normalize(r['decoded']['text']) for r in run['rows']), 'client_to_final_text_changes': sum(normalize(r['decoded']['text']) != normalize(r['final_text']) for r in run['rows'] if r['finalization_comparable'])}
    result = {'summary': summary, 'per_speaker': per_speaker, 'inactive_channel_controls': negatives, 'decision': decisions, 'source_separation_support': all(d['passes'] for d in decisions), 'cost': cost, 'preservation': preservation, 'rows': detailed, 'limits': plan['limits']}
    target = root / 'report.json'; assert not target.exists(); target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'summary': summary, 'decision': decisions, 'source_separation_support': result['source_separation_support']}))


if __name__ == '__main__':
    {'prepare': prepare, 'report': report}[sys.argv[1]](*sys.argv[2:])
