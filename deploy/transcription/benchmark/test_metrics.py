import unittest

from metrics import normalize, percentile, score, summarize


class MetricsChecks(unittest.TestCase):
    def test_accents_and_unicode_are_preserved(self):
        self.assertEqual(normalize("  TIẾNG, Việt! "), "tiếng việt")
        self.assertEqual(score("tiếng Việt", "tieng Viet")["word_errors"], 2)
        self.assertEqual(score("Việt", "Vie\u0323\u0302t")["word_errors"], 0)

    def test_edit_counts_empty_audio_and_failure_penalty(self):
        self.assertEqual(score("a b c", "a x c d")["word_errors"], 2)
        self.assertEqual(score("a b", "")["deletions"], 2)
        self.assertEqual(score("", "hello")["insertions"], 1)
        row = {"score": score("a b", ""), "ok": False, "duration_s": 2, "latency_s": 1}
        self.assertEqual(summarize([row])["wer"], 1)
        self.assertEqual(summarize([row])["failures"], 1)

    def test_percentiles_are_nearest_rank(self):
        self.assertIsNone(percentile([], .95))
        self.assertEqual(percentile([1, 3, 2, None], .5), 2)
        self.assertEqual(normalize("Don’t!"), "don't")


if __name__ == "__main__":
    unittest.main()
