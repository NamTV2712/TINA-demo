"""FSMN detects speech; Gipformer decodes each interval on its original sample clock."""
from __future__ import annotations

import hashlib
import io
import json
import math
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

MODEL = 'g-group-ai-lab/gipformer1.5-68M-rnnt'
RATE = 16000
MAX_SECONDS = 90
HERE = Path(__file__).resolve().parent
class AudioInputError(ValueError):
    pass


def read_audio(content):
    with sf.SoundFile(io.BytesIO(content)) as file:
        if not 1 <= file.channels <= 8 or not 8000 <= file.samplerate <= 192000 or not 0 < file.frames <= MAX_SECONDS * file.samplerate or file.frames * file.channels > 16_000_000:
            raise AudioInputError('Expected 0–90 seconds of audio, 1–8 channels, 8–192 kHz')
        rate, duration = file.samplerate, file.frames / file.samplerate
        pcm = file.read(dtype='float32', always_2d=True).mean(axis=1)
    if not np.isfinite(pcm).all():
        raise AudioInputError('Audio contains non-finite samples')
    if rate != RATE:
        factor = math.gcd(rate, RATE)
        pcm = resample_poly(pcm, RATE // factor, rate // factor).astype(np.float32)
    return np.ascontiguousarray(pcm), duration


def speech_ranges(result, count):
    if not isinstance(result, list) or len(result) != 1 or not isinstance(result[0], dict) or not isinstance(result[0].get('value'), list):
        raise RuntimeError('FSMN returned invalid speech ranges')
    intervals, previous_end = [], 0
    for pair in result[0]['value']:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2 or any(type(v) not in (int, float) or not math.isfinite(v) for v in pair) or pair[0] < 0 or pair[1] <= pair[0] or pair[1] > max(count, 3200) / 16 + 50:
            raise RuntimeError('FSMN returned invalid speech times')
        start, end = math.floor(pair[0] * 16), min(count, math.ceil(pair[1] * 16))
        if start >= count:
            continue  # Discard speech belonging only to temporary short-input padding.
        if start < previous_end:
            raise RuntimeError('FSMN returned overlapping speech ranges')
        for offset in range(start, end, 30 * RATE):
            # shortcut: bound long speech to 30-second windows; add validated overlap decoding before raising the cap.
            intervals.append((offset, min(end, offset + 30 * RATE)))
        previous_end = end
    if len(intervals) > 512:
        raise RuntimeError('Too many speech intervals')
    return intervals


class GipformerEngine:
    def __init__(self, vad, recognizer):
        self.vad, self.recognizer = vad, recognizer

    @classmethod
    def load(cls, directory):
        import torch
        import sherpa_onnx
        from funasr import AutoModel

        directory = Path(directory)
        manifest = json.loads((HERE / 'model-assets.json').read_text())
        for group, base in [('files', directory), ('vad_files', directory / 'fsmn-vad')]:
            for name, expected in manifest[group].items():
                if hashlib.sha256((base / name).read_bytes()).hexdigest() != expected:
                    raise ValueError(f'Model asset checksum mismatch: {name}')
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        vad = AutoModel(model=str(directory / 'fsmn-vad'), device='cpu', disable_update=True, disable_pbar=True, disable_log=True)
        recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=str(directory / 'encoder.int8.onnx'), decoder=str(directory / 'decoder.int8.onnx'),
            joiner=str(directory / 'joiner.int8.onnx'), tokens=str(directory / 'tokens.txt'),
            num_threads=2, sample_rate=RATE, feature_dim=80, decoding_method='greedy_search', provider='cpu',
        )
        return cls(vad, recognizer)

    def transcribe(self, content, silence_ms=800):
        pcm, duration = read_audio(content)
        if not np.any(pcm):
            return {'text': '', 'duration': duration, 'segments': []}
        # Match the existing FSMN wrapper's minimum analysis frame, without changing source time.
        temporary = np.pad(pcm, (0, max(0, 3200 - len(pcm))))
        result = self.vad.generate(input=temporary, cache={}, is_final=True, fs=RATE,
                                   max_end_silence_time=silence_ms, disable_pbar=True)
        segments = []
        for start, end in speech_ranges(result, len(pcm)):
            stream = self.recognizer.create_stream()
            stream.accept_waveform(RATE, pcm[start:end])
            self.recognizer.decode_streams([stream])
            text = stream.result.text.strip()
            if not text:
                continue
            if len(text) > 10000:
                raise ValueError('ASR output exceeds limit')
            segments.append({'start': start / RATE, 'end': min(duration, end / RATE), 'text': text})
        text = ' '.join(s['text'] for s in segments)
        if len(text) > 100000:
            raise RuntimeError('ASR response exceeds limit')
        return {'text': text, 'duration': duration, 'segments': segments}
