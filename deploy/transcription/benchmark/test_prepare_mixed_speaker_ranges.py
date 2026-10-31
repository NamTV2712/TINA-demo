import struct
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prepare_mixed_speaker_ranges import mix_components, parse_pcm_wav_header


class RemoteRangePreparationTests(unittest.TestCase):
    def test_parses_standard_pcm16_header_and_exact_data_offset(self):
        pcm_bytes = 32000
        fmt = struct.pack('<HHIIHH', 1, 1, 16000, 32000, 2, 16)
        header = (b'RIFF' + struct.pack('<I', 36 + pcm_bytes) + b'WAVE' + b'fmt ' +
                  struct.pack('<I', len(fmt)) + fmt + b'data' + struct.pack('<I', pcm_bytes))
        self.assertEqual(parse_pcm_wav_header(header, len(header) + pcm_bytes), {
            'bytes': len(header) + pcm_bytes, 'data_offset': 44, 'data_bytes': pcm_bytes,
            'frames': 16000, 'samplerate': 16000, 'channels': 1, 'etag': None,
            'last_modified': None, 'url': None})

    def test_common_quarter_gain_mixes_without_changing_channel_pcm(self):
        channels = {'A': np.array([400, -400], dtype=np.int16),
                    'B': np.array([800, -800], dtype=np.int16),
                    'C': np.array([1200, -1200], dtype=np.int16),
                    'D': np.array([1600, -1600], dtype=np.int16)}
        tracks, mixed = mix_components(channels)
        self.assertTrue(np.array_equal(tracks['A'], np.array([100, -100], dtype=np.int16)))
        self.assertTrue(np.array_equal(mixed, np.array([1000, -1000], dtype=np.int16)))


if __name__ == '__main__':
    unittest.main()
