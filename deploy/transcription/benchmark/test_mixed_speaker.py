import unittest
import contextlib
import io
import json
from pathlib import Path
import tempfile
import itertools
import random
from mixed_speaker import interleaving, select, report
from metrics import score


def w(text, speaker='A', start=0, end=1):
    return {'text': text, 'speaker': speaker, 'start': start, 'end': end}


class MixedSpeakerTests(unittest.TestCase):
    def test_single_speaker_matches_standard_error_count(self):
        refs = [w('We', start=0, end=.2), w('send', start=.3, end=.5), w('tomorrow', start=.6, end=.9)]
        for text in ['We send tomorrow.', 'We sent it tomorrow', '', 'No']:
            self.assertEqual(interleaving(refs, text)['word_errors'], score('We send tomorrow', text)['word_errors'])

    def test_overlap_allows_order_but_never_double_credits_hypothesis(self):
        refs = [w('hello', 'A'), w('yes', 'B')]
        self.assertEqual(interleaving(refs, 'yes hello')['word_errors'], 0)
        result = interleaving([w('yes', 'A'), w('yes', 'B')], 'yes')
        self.assertEqual(result['deletions'], 1)
        self.assertEqual(sum(s['hits'] for s in result['attribution'].values()), 1)

    def test_nonoverlapping_cross_speaker_order_is_not_free(self):
        refs = [w('early', 'A', 0, .5), w('later', 'B', 1, 1.5)]
        self.assertEqual(interleaving(refs, 'early later')['word_errors'], 0)
        self.assertGreater(interleaving(refs, 'later early')['word_errors'], 0)

    def test_oracle_matches_independent_exhaustive_reference_orders(self):
        refs = [w('yes', 'A', 0, 2), w('go', 'A', 1, 1.2), w('yes', 'B', 1.5, 2.5), w('now', 'B', 3, 4), w('okay', 'C', .1, .5), w('then', 'C', 2, 3)]
        allowed = []
        for order in itertools.permutations(range(len(refs))):
            pos = {word: i for i, word in enumerate(order)}
            if all(pos[i] < pos[j] for i, a in enumerate(refs) for j, b in enumerate(refs) if i != j and ((a['speaker'] == b['speaker'] and i < j) or (a['speaker'] != b['speaker'] and a['end'] <= b['start']))):
                allowed.append(' '.join(refs[i]['text'] for i in order))
        self.assertTrue(allowed)
        rng = random.Random(26)
        for hyp in [allowed[0], 'yes now go okay then', ''] + [' '.join(rng.choices(['yes', 'go', 'now', 'extra'], k=6)) for _ in range(8)]:
            self.assertEqual(interleaving(refs, hyp)['word_errors'], min(score(ref, hyp)['word_errors'] for ref in allowed))

    def test_empty_channel_is_an_insertion_control(self):
        self.assertEqual(interleaving([], 'heard another voice')['insertions'], 3)
        self.assertEqual(interleaving([], '')['word_errors'], 0)

    def test_report_keeps_inactive_bleed_separate_and_charges_all_channels(self):
        cases = []; rows = []
        for group in ('non-overlap', 'low-overlap', 'high-overlap'):
            refs = [w('hello', 'A')]
            if group != 'non-overlap':
                refs.append(w('world', 'B'))
            speakers = [r['speaker'] for r in refs]
            cases.append({'id': group, 'role': 'test', 'stratum': group, 'reference': refs, 'speakers': speakers})
            for rep in range(3):
                for arm in ('official-mix', 'controlled-mix', 'headset-A', 'headset-B', 'headset-C', 'headset-D'):
                    text = ' '.join(r['text'] for r in refs if not arm.startswith('headset-') or r['speaker'] == arm[-1])
                    if not text:
                        text = 'bleed'
                    rows.append({'case': group, 'repeat': rep, 'arm': arm, 'http_ms': 100, 'finalize_ms': 1, 'raw': {'text': text}, 'decoded': {'text': text}, 'final_text': text, 'finalization_comparable': True, 'source_pcm_unchanged': True, 'sampled_rss_bytes': 1000})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'plan.json').write_text(json.dumps({'cases': cases, 'schedule': rows, 'duration_s': 10, 'repeats': 3, 'mapping': {s: i for i, s in enumerate('ABCD')}, 'limits': []}))
            (root / 'run.json').write_text(json.dumps({'status': 'complete', 'rows': rows}))
            with contextlib.redirect_stdout(io.StringIO()):
                report(root)
            result = json.loads((root / 'report.json').read_text())
        cost = {r['arm']: r for r in result['cost']}
        self.assertEqual(cost['all-headsets']['requests'], 4 * cost['controlled-mix']['requests'])
        self.assertAlmostEqual(cost['controlled-mix']['serial_http_seconds_per_source_second'], .01)
        high = [r for r in result['summary'] if r['stratum'] == 'high-overlap' and r['arm'] == 'active-headsets']
        self.assertTrue(all(r['ref_words'] == 2 and r['word_errors'] == 0 for r in high))
        self.assertTrue(all(r['insertions'] == 2 for r in result['inactive_channel_controls'] if r['stratum'] == 'high-overlap'))

    def test_selection_is_frozen_disjoint_and_stratified(self):
        refs = []
        for i in range(4):
            for group, origin in [('high', 50 + i * 20), ('low', 200 + i * 20), ('none', 400 + i * 20)]:
                refs.extend(w(str(j), 'A', origin + .5 + j * .4, origin + .9 + j * .4) for j in range(9))
                if group == 'high':
                    refs.extend(w(str(j), 'B', origin + .6 + j * .4, origin + .95 + j * .4) for j in range(9))
                if group == 'low':
                    refs.extend(w(str(j), 'B', origin + 3.9 + j * .4, origin + 4.2 + j * .4) for j in range(9))
        refs.extend(w(str(j), 'C', 600 + j * .4, 600.3 + j * .4) for j in range(9))
        refs.append(w('tail', 'D', 650, 650.2))
        chosen, warmup = select(refs)
        self.assertEqual(chosen, select(refs)[0]); self.assertEqual(len(chosen), 12)
        for group in ('non-overlap', 'low-overlap', 'high-overlap'):
            self.assertEqual(sum(c['stratum'] == group for c in chosen), 4)
        for i, case in enumerate(chosen):
            self.assertTrue(all(abs(case['start_s'] - other['start_s']) >= 12 for other in chosen[:i] + [warmup]))


if __name__ == '__main__':
    unittest.main()
