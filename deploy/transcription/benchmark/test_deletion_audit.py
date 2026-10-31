import unittest
from deletion_audit import trace


class DeletionAudit(unittest.TestCase):
    def test_raw_publication_and_unsubmitted_are_separate(self):
        words = [{'text': text, 'start': i, 'end': i + .8, 'speaker': 'A'} for i, text in enumerate(['alpha', 'beta', 'gamma'])]
        requests = [{'id': 1, 'source_start_sample': 0, 'samples': 32000, 'http_status': 200, 'response': {'text': 'alpha beta'}}]
        report = trace(words, requests, 'alpha')
        self.assertEqual(report['deletions'], 2)
        self.assertEqual([r['category'] for r in report['rows']], ['raw-match-not-final', 'not-submitted'])

    def test_midpoint_coverage_does_not_prove_full_word_audio(self):
        words = [{'text': 'beta', 'start': 1, 'end': 2, 'speaker': 'A'}]
        requests = [{'id': 1, 'source_start_sample': 20000, 'samples': 8000, 'http_status': 200, 'response': {'text': ''}}]
        report = trace(words, requests, '')
        self.assertEqual(report['categories'], {'no-exact-raw-match': 1})
        self.assertEqual(report['never_whole_word'], 1)
        self.assertFalse(report['rows'][0]['overlap'])


if __name__ == '__main__':
    unittest.main()
