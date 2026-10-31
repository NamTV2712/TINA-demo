import unittest
from quality_ab import overlap_seconds, select_excerpts, scored, audit_requests, aggregate


class QualityAB(unittest.TestCase):
    def test_overlap_counts_distinct_speakers_not_overlapping_words(self):
        words = [{'speaker': 'A', 'start': 0, 'end': 3}, {'speaker': 'A', 'start': 1, 'end': 4},
                 {'speaker': 'B', 'start': 2, 'end': 5}]
        self.assertEqual(overlap_seconds(words, 0, 6), 2)
        self.assertEqual(overlap_seconds(words, 3, 3.5), .5)

    def test_selection_is_disjoint_deterministic_and_independent_of_text(self):
        words = [{'speaker': 'A', 'start': minute * 60 + i / 2, 'end': minute * 60 + i / 2 + .1, 'text': str(i)}
                 for minute in range(6) for i in range(100)]
        selected = select_excerpts(words, 360)
        self.assertEqual([r['start_s'] for r in selected], [0, 60, 240, 300])
        self.assertEqual(selected, select_excerpts([{**w, 'text': 'changed'} for w in words], 360))

    def test_error_counts_do_not_hide_repetition_or_deletion(self):
        result = scored('one two three', 'one one three')
        self.assertEqual(result['word_errors'], 1)
        self.assertAlmostEqual(result['wer'], 1 / 3)

    def test_audio_coverage_and_raw_match_are_distinct_from_final_hits(self):
        words = [{'text': text, 'start': i, 'end': i + .5} for i, text in enumerate(['one', 'two', 'three'])]
        requests = [{'id': 1, 'source_start_sample': 0, 'samples': 32000, 'http_status': 200, 'response': {'text': 'one two'}}]
        audit = audit_requests(words, requests, 'one')
        self.assertEqual(audit['tokens_outside_uniquely_matched_requests'], 1)
        self.assertEqual(audit['tokens_exact_matched_in_some_raw_response_but_not_final'], 1)
        self.assertEqual(audit['tokens_submitted_but_not_exact_matched_in_any_raw_response'], 0)

    def test_aggregate_cannot_align_words_across_disjoint_clips(self):
        result = aggregate([scored('one', ''), scored('two', 'one two')])
        self.assertEqual(result['word_errors'], 2)
        self.assertEqual(result['wer'], 1)


if __name__ == '__main__':
    unittest.main()
