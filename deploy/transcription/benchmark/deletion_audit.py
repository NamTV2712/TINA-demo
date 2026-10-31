"""Trace scored deletions to exact submitted PCM ranges and raw hypotheses; no inference or edits."""
import json
from pathlib import Path
import sqlite3
import sys
from collections import Counter

import jiwer
from metrics import normalize


def trace(words, requests, final_text):
    tokens = [(token, word) for word in words for token in normalize(word['text']).split()]
    alignment = jiwer.process_words(' '.join(t for t, _ in tokens), normalize(final_text))
    deleted = [i for block in alignment.alignments[0] if block.type == 'delete'
               for i in range(block.ref_start_idx, block.ref_end_idx)]
    windows, hits = [], {}
    for request in requests:
        start = request.get('source_start_sample')
        if start is None or request['http_status'] != 200:
            continue
        left, right = start / 16000, (start + request['samples']) / 16000
        indices = [i for i, (_, w) in enumerate(tokens) if left <= (w['start'] + w['end']) / 2 < right]
        window = {'id': request['id'], 'start_s': left, 'end_s': right,
                  'text': request.get('response', {}).get('text', '')}
        windows.append(window)
        if not indices:
            continue
        raw = jiwer.process_words(' '.join(tokens[i][0] for i in indices), normalize(window['text']))
        for block in raw.alignments[0]:
            if block.type == 'equal':
                for index in range(block.ref_start_idx, block.ref_end_idx):
                    hits.setdefault(indices[index], []).append(window['id'])
    rows = []
    for index in deleted:
        token, word = tokens[index]
        midpoint = (word['start'] + word['end']) / 2
        submitted = [w for w in windows if w['start_s'] <= midpoint < w['end_s']]
        whole = [w for w in submitted if w['start_s'] <= word['start'] and w['end_s'] >= word['end']]
        category = 'not-submitted' if not submitted else 'raw-match-not-final' if index in hits else 'no-exact-raw-match'
        rows.append({'reference_index': index, 'token': token, 'start_s': word['start'], 'end_s': word['end'],
                     'speaker': word.get('speaker'), 'category': category,
                     'overlap': any(w.get('speaker') != word.get('speaker') and w['start'] < word['end'] and w['end'] > word['start'] for w in words),
                     'filler': token in {'uh', 'um', 'mm', 'hmm', 'mhm'},
                     'whole_word_in_any_request': bool(whole),
                     'best_min_side_context_s': max((min(word['start'] - w['start_s'], w['end_s'] - word['end']) for w in whole), default=None),
                     'longest_covering_request_s': max((w['end_s'] - w['start_s'] for w in submitted), default=None),
                     'raw_match_request_ids': hits.get(index, []), 'covering_requests': submitted})
    assert len(rows) == alignment.deletions
    return {'deletions': len(rows), 'categories': dict(Counter(r['category'] for r in rows)),
            'overlap_deletions': sum(r['overlap'] for r in rows), 'filler_deletions': sum(r['filler'] for r in rows),
            'never_whole_word': sum(not r['whole_word_in_any_request'] for r in rows),
            'rows': rows}


def main(directory, output):
    root, output = Path(directory), Path(output)
    assert not output.exists(), 'Never overwrite diagnostic evidence'
    assert json.loads((root / 'run.json').read_text())['status'] == 'complete'
    clips = []
    for file in json.loads((root / 'plan.json').read_text())['clips']:
        clip = json.loads(Path(file).read_text()); name = clip['meeting_id']
        with sqlite3.connect(f'file:{root}/{name}/journal/transcripts.sqlite?mode=ro', uri=True) as db:
            meeting = json.loads(db.execute('SELECT document FROM meetings').fetchone()[0])
        text = ' '.join(s['text'] for s in sorted(meeting['segments'], key=lambda s: (s['start'], s['segment_id'])))
        requests = [json.loads(s) for s in (root / f'{name}-requests.jsonl').read_text().splitlines() if json.loads(s)['path'] == 'live']
        clips.append({'clip': name, **trace(clip['reference'], requests, text)})
    result = {'clips': clips, 'limits': ['Chronological mixed-reference alignment; overlap/repeated words can align ambiguously.',
                                      'A raw match missing from final can be an earlier hypothesis later revised, not necessarily a publication bug.',
                                      'AMI word intervals are reference annotations, not independent phonetic boundary accuracy.']}
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps([{k: v for k, v in c.items() if k != 'rows'} for c in clips]))


if __name__ == '__main__':
    main(*sys.argv[1:])
