import sys
import json
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from report_vad_factor import annotate_vad_membership, headset_decision, inactive_channel_controls, summarize
from prepare_vad_factor import prepare


class VadFactorReportTests(unittest.TestCase):
    def test_deleted_word_midpoint_and_fraction_use_merged_vad_ranges(self):
        words = [
            {'speaker': 'A', 'text': 'inside', 'start': 1.0, 'end': 2.0},
            {'speaker': 'B', 'text': 'outside', 'start': 3.0, 'end': 4.0},
        ]
        self.assertEqual(annotate_vad_membership(words, [[0.5, 1.4], [1.4, 1.8]]), [
            {**words[0], 'vad_midpoint_covered': True, 'vad_covered_fraction': 0.8},
            {**words[1], 'vad_midpoint_covered': False, 'vad_covered_fraction': 0.0},
        ])

    def test_empty_channel_reports_insertions_without_dividing_by_zero(self):
        summary = summarize([{'ref_words': 0, 'word_errors': 3, 'substitutions': 0, 'deletions': 0,
                              'insertions': 3, 'ref_chars': 0, 'char_errors': 10}])
        self.assertEqual(summary['insertions'], 3)
        self.assertIsNone(summary['wer'])
        self.assertIsNone(summary['cer'])

    def test_headset_gate_requires_high_overlap_gain_and_nonoverlap_guard(self):
        def row(stratum, group, errors, substitutions, deletions, refs):
            return {'repeat': 0, 'stratum': stratum, 'channel_group': group, 'vad_mode': 'fsmn',
                    'ref_words': refs, 'word_errors': errors, 'substitutions': substitutions,
                    'deletions': deletions, 'insertions': 0, 'ref_chars': refs, 'char_errors': errors}
        passing = [row('high-overlap', 'mixed', 30, 20, 10, 100),
                   row('high-overlap', 'active-headset', 15, 10, 5, 100),
                   row('non-overlap', 'mixed', 10, 5, 5, 100),
                   row('non-overlap', 'active-headset', 11, 6, 5, 100)]
        self.assertTrue(headset_decision(passing)[0]['passes'])
        passing[-1]['word_errors'] = 13
        passing[-1]['insertions'] = 2
        self.assertFalse(headset_decision(passing)[0]['passes'])

    def test_inactive_headset_insertions_are_separate_from_active_track_quality(self):
        detail = [
            {'stratum': 'high-overlap', 'repeat': 0, 'channel_group': 'inactive-headset', 'vad_mode': 'fsmn', 'arm': 'headset-A', 'I': 3, 'inactive_other_speaker_hits': 2},
            {'stratum': 'high-overlap', 'repeat': 0, 'channel_group': 'inactive-headset', 'vad_mode': 'fsmn', 'arm': 'headset-B', 'I': 0, 'inactive_other_speaker_hits': 0},
            {'stratum': 'high-overlap', 'repeat': 0, 'channel_group': 'active-headset', 'vad_mode': 'fsmn', 'arm': 'headset-C', 'I': 9, 'inactive_other_speaker_hits': 0},
        ]
        result = inactive_channel_controls(detail)
        self.assertEqual(result[0]['requests'], 2)
        self.assertEqual(result[0]['requests_with_insertions'], 1)
        self.assertEqual(result[0]['insertions'], 3)
        self.assertEqual(result[0]['other_speaker_reference_hits'], 2)

    def test_trace_and_mixed_plus_headset_schedules_match_the_requested_arms(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            parent = root / 'parent'
            parent.mkdir()
            (parent / 'plan.json').write_text(json.dumps({
                'meeting': 'TEST2001x', 'seed': 1, 'repeats': 3, 'asr': {}, 'mapping': {'A': 0, 'B': 1, 'C': 2, 'D': 3},
                'cases': [{'id': 'w', 'role': 'warmup'}, {'id': 'c', 'role': 'test'}]}))
            trace = root / 'trace'
            prepare(parent, trace, 'trace-only')
            trace_plan = json.loads((trace / 'vad-plan.json').read_text())
            self.assertEqual([(x['arm'], x['vad_mode'], x['repeat']) for x in trace_plan['schedule']],
                             [('controlled-mix', 'fsmn', 0)])
            self.assertIn('TEST2001x', trace_plan['selection'])
            paired = root / 'paired'
            prepare(parent, paired, 'mixed-plus-headsets')
            paired_plan = json.loads((paired / 'vad-plan.json').read_text())
            schedule = paired_plan['schedule']
            self.assertEqual(len(schedule), 18)
            self.assertEqual(sum(x['arm'] == 'controlled-mix' and x['vad_mode'] == 'off' for x in schedule), 3)
            self.assertEqual(sum(x['arm'].startswith('headset-') for x in schedule), 12)


if __name__ == '__main__':
    unittest.main()
