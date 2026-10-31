import sys
import unittest
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vad_range_parser import ranges as vad_ranges


class VadProbeTests(unittest.TestCase):
    def test_extracts_only_time_pairs_without_text_or_audio(self):
        result = [{'value': [[100, 350, 'audio.wav'], [900, 1230]]}, {'key': 'x', 'value': [[2400, 2800]]}]
        self.assertEqual(vad_ranges(result), [[.1, .35], [.9, 1.23], [2.4, 2.8]])

    def test_empty_invalid_and_zero_length_ranges_are_ignored(self):
        self.assertEqual(vad_ranges(None), [])
        self.assertEqual(vad_ranges([{'text': 'private transcript', 'value': [[10, 10], ['x', 30], [40]]}]), [])

    def test_numpy_fsmn_sample_indices_are_kept_as_ranges(self):
        self.assertEqual(vad_ranges([{'value': [[np.int64(400), np.int64(1200)]]}]), [[.4, 1.2]])


if __name__ == '__main__':
    unittest.main()
