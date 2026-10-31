"""Score the fixed-PCM VAD trace, VAD A/B, and mixed-versus-headset studies."""
import hashlib
import json
from collections import defaultdict
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mixed_speaker import interleaving


def annotate_vad_membership(words, spans):
    merged = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    result = []
    for word in words:
        start, end = word['start'], word['end']
        covered = sum(max(0.0, min(end, right) - max(start, left)) for left, right in merged)
        duration = end - start
        result.append({**word,
            'vad_midpoint_covered': any(left <= (start + end) / 2 <= right for left, right in merged),
            'vad_covered_fraction': min(1.0, covered / duration) if duration else 0.0})
    return result


def summarize(rows):
    keys = ('ref_words', 'word_errors', 'substitutions', 'deletions', 'insertions', 'ref_chars', 'char_errors')
    totals = {key: sum(row[key] for row in rows) for key in keys}
    totals['wer'] = totals['word_errors'] / totals['ref_words'] if totals['ref_words'] else None
    totals['cer'] = totals['char_errors'] / totals['ref_chars'] if totals['ref_chars'] else None
    return totals


def headset_decision(summary):
    decisions = []
    repeats = sorted({row['repeat'] for row in summary})
    for repeat in repeats:
        find = lambda stratum, group: [row for row in summary if row['repeat'] == repeat and
            row['stratum'] == stratum and row['channel_group'] == group and row['vad_mode'] == 'fsmn']
        mix_high = find('high-overlap', 'mixed')
        head_high = find('high-overlap', 'active-headset')
        mix_non = find('non-overlap', 'mixed')
        head_non = find('non-overlap', 'active-headset')
        if not all((mix_high, head_high, mix_non, head_non)):
            continue
        mix_high, head_high = summarize(mix_high), summarize(head_high)
        mix_non, head_non = summarize(mix_non), summarize(head_non)
        improvement = 100 * (mix_high['wer'] - head_high['wer'])
        regression = 100 * (head_non['wer'] - mix_non['wer'])
        decisions.append({'repeat': repeat, 'mixed_high': mix_high, 'active_headsets_high': head_high,
            'high_overlap_wer_improvement_pp': improvement, 'non_overlap_wer_regression_pp': regression,
            'passes': improvement >= 10 and head_high['substitutions'] < mix_high['substitutions'] and
                head_high['deletions'] < mix_high['deletions'] and regression <= 2})
    return decisions


def inactive_channel_controls(detail):
    result = []
    groups = sorted({(row['stratum'], row['repeat']) for row in detail if row['channel_group'] == 'inactive-headset' and row['vad_mode'] == 'fsmn'})
    for stratum, repeat in groups:
        rows = [row for row in detail if row['stratum'] == stratum and row['repeat'] == repeat and
                row['channel_group'] == 'inactive-headset' and row['vad_mode'] == 'fsmn']
        by_arm = []
        for arm in sorted({row['arm'] for row in rows}):
            arm_rows = [row for row in rows if row['arm'] == arm]
            by_arm.append({'arm': arm, 'requests': len(arm_rows),
                'requests_with_insertions': sum(row['I'] > 0 for row in arm_rows),
                'insertions': sum(row['I'] for row in arm_rows),
                'other_speaker_reference_hits': sum(row['inactive_other_speaker_hits'] for row in arm_rows)})
        result.append({'stratum': stratum, 'repeat': repeat, 'requests': len(rows),
            'requests_with_insertions': sum(row['I'] > 0 for row in rows),
            'insertions': sum(row['I'] for row in rows),
            'requests_with_other_speaker_hits': sum(row['inactive_other_speaker_hits'] > 0 for row in rows),
            'other_speaker_reference_hits': sum(row['inactive_other_speaker_hits'] for row in rows),
            'by_arm': by_arm})
    return result


def analyze(directory):
    root = Path(directory)
    plan = json.loads((root / 'vad-plan.json').read_text())
    run = json.loads((root / 'vad-run.json').read_text())
    plan_sha = hashlib.sha256((root / 'vad-plan.json').read_bytes()).hexdigest()
    assert run['status'] == 'complete' and run['plan_sha256'] == plan_sha
    assert len(run['rows']) == len(plan['schedule'])
    cases = {case['id']: case for case in plan['cases']}
    metrics, by_window, detail = defaultdict(list), {}, []

    for row in run['rows']:
        case = cases[row['case']]
        reference = [{**word, 'overlap': any(other['speaker'] != word['speaker'] and
            other['start'] <= (word['start'] + word['end']) / 2 < other['end']
            for other in case['reference'])} for word in case['reference']]
        speaker = row['arm'].removeprefix('headset-') if row['arm'].startswith('headset-') else None
        active = speaker is None or speaker in case['speakers']
        scored_reference = [word for word in reference if speaker is None or word['speaker'] == speaker]
        score = interleaving(scored_reference, row['raw']['text'])
        other_speaker_alignment = None
        if speaker is not None and not active:
            other_speaker_alignment = interleaving(reference, row['raw']['text'])
        other_speaker_hits = (sum(value['hits'] for value in other_speaker_alignment['attribution'].values())
                              if other_speaker_alignment else 0)
        spans = row.get('vad_ranges') or []
        deleted_words = annotate_vad_membership(score['deleted_words'], spans)
        calls = row.get('vad_probe_calls') or []
        decoder_calls = sum('text' in call.get('row_keys', []) for call in calls)
        fsmn_calls = sum(call.get('is_fsmn', False) for call in calls)
        channel_group = 'mixed' if speaker is None else 'active-headset' if active else 'inactive-headset'
        key = (case['stratum'], row['repeat'], channel_group, row['arm'], row['vad_mode'])
        metrics[key].append(score)
        detail.append({
            'case': row['case'], 'stratum': case['stratum'], 'repeat': row['repeat'],
            'arm': row['arm'], 'channel_group': channel_group, 'vad_mode': row['vad_mode'],
            'active_speakers': case['speakers'], 'reference_words': score['ref_words'],
            'S': score['substitutions'], 'D': score['deletions'], 'I': score['insertions'],
            'word_errors': score['word_errors'], 'WER': score['word_errors'] / score['ref_words'] if score['ref_words'] else None,
            'CER': score['char_errors'] / score['ref_chars'] if score['ref_chars'] else None,
            'deleted_words': deleted_words, 'vad_ranges': spans,
            'inactive_other_speaker_hits': other_speaker_hits,
            'inactive_alignment_by_speaker': other_speaker_alignment['attribution'] if other_speaker_alignment else None,
            'vad_audio_s': sum(end - start for start, end in spans),
            'FSMN_model_calls': fsmn_calls, 'Qwen_decoder_calls': decoder_calls,
            'PCM_sha256': row['pcm_sha256'], 'HTTP_ms': row['http_ms'], 'raw_text': row['raw']['text']})
        by_window.setdefault((row['case'], row['arm'], row['repeat']), {})[row['vad_mode']] = {
            'score': score, 'pcm_sha256': row['pcm_sha256'],
            'FSMN_model_calls': fsmn_calls, 'Qwen_decoder_calls': decoder_calls}

    paired = []
    for (case_id, arm, repeat), modes in sorted(by_window.items()):
        on, off = modes.get('fsmn'), modes.get('off')
        def counts(result):
            if result is None:
                return None
            score = result['score']
            return {'S': score['substitutions'], 'D': score['deletions'], 'I': score['insertions'],
                    'word_errors': score['word_errors']}
        paired.append({
            'case': case_id, 'stratum': cases[case_id]['stratum'], 'arm': arm, 'repeat': repeat,
            'same_wire_pcm': on['pcm_sha256'] == off['pcm_sha256'] if on and off else None,
            'FSMN': counts(on), 'no_VAD': counts(off),
            'FSMN_model_calls': on['FSMN_model_calls'] if on else 0,
            'FSMN_decoder_calls': on['Qwen_decoder_calls'] if on else 0,
            'no_VAD_decoder_calls': off['Qwen_decoder_calls'] if off else 0,
            'D_off_minus_on': off['score']['deletions'] - on['score']['deletions'] if on and off else None,
            'E_off_minus_on': off['score']['word_errors'] - on['score']['word_errors'] if on and off else None})

    scope = plan['scope']
    if scope in ('mixed-only', 'mixed-plus-headsets', 'all-sources'):
        expected_pairs = len(cases) * plan['repeats']
        assert sum(p['arm'] == 'controlled-mix' and p['FSMN'] is not None and p['no_VAD'] is not None for p in paired) == expected_pairs
        assert all(p['same_wire_pcm'] for p in paired if p['arm'] == 'controlled-mix' and p['no_VAD'] is not None)
    if scope == 'trace-only':
        assert len(detail) == len(cases) and all(row['arm'] == 'controlled-mix' and row['vad_mode'] == 'fsmn' for row in detail)

    summary = [{'stratum': stratum, 'repeat': repeat, 'channel_group': group, 'arm': arm, 'vad_mode': mode,
                **summarize(rows)} for (stratum, repeat, group, arm, mode), rows in sorted(metrics.items())]
    decision = headset_decision(summary) if scope == 'mixed-plus-headsets' else []
    deletion_coverage = []
    for row in detail:
        if row['vad_mode'] != 'fsmn':
            continue
        words = row['deleted_words']
        deletion_coverage.append({'case': row['case'], 'stratum': row['stratum'], 'arm': row['arm'],
            'repeat': row['repeat'], 'deleted_tokens': len(words),
            'midpoint_in_vad': sum(word['vad_midpoint_covered'] for word in words),
            'midpoint_outside_vad': sum(not word['vad_midpoint_covered'] for word in words),
            'deleted_words': words})

    report = {
        'scope': scope, 'Qwen_CPU_probe': run.get('probe_model'),
        'Qwen_snapshot': plan['qwen_hf_cache_revision'], 'FSMN_snapshot': plan['fsmn_vad_cache_revision'],
        'baseline_MPS_started_at_ms': run.get('production_started_at_ms'),
        'summary': summary, 'paired_windows': paired, 'headset_decision': decision,
        'source_separation_support': bool(decision) and all(row['passes'] for row in decision),
        'inactive_channel_controls': inactive_channel_controls(detail),
        'deleted_word_vad_coverage': deletion_coverage,
        'detail': detail,
        'VAD_span_interpretation': 'A word midpoint inside a returned VAD interval is not proof that the entire word or exact Qwen slice was preserved. Ranges are the service VAD output, not independent phonetic ground truth.',
        'H1/H2_reading': 'Compare FSMN-on/off only on the same mixed PCM. A VAD-on/off effect is a service-path effect that includes segmentation and the resulting Qwen calls; it does not isolate acoustic boundary accuracy or prove the ASR model is the sole cause.',
        'H3_reading': 'Fixed windows do not test TINA live multi-window merging, SQLite/revision workers, or UI.',
        'limits': plan['limitations']}
    dest = root / 'vad-report.json'
    assert not dest.exists(), 'Never overwrite a report or partial experiment'
    dest.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'scope': scope, 'requests': len(detail), 'paired_windows': sum(p['no_VAD'] is not None for p in paired),
        'summary_rows': len(summary), 'source_separation_support': report['source_separation_support'], 'report': str(dest)}))


if __name__ == '__main__':
    analyze(sys.argv[1])
