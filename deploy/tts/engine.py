"""One preset VieNeu ONNX CPU voice, exposed in the bot's PCM format."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from speech_text import spoken_text, default_pronunciations

MODEL = "vieneu-v3-turbo"
SAMPLE_RATE = 24000
MAX_AUDIO_SECONDS = 120
PRESET_VOICE = "Trúc Ly"
ACK_TEXT = "Dạ, em nghe."


def verify_assets(directory: Path) -> None:
    """Check pinned snapshots before the offline SDK is allowed to load them."""
    from huggingface_hub import snapshot_download

    manifest = json.loads(Path(__file__).with_name("model-assets.json").read_text())
    for repo in manifest["repos"]:
        snapshot = Path(snapshot_download(repo["repo"], revision=repo["revision"],
                                         allow_patterns=[f["path"] for f in repo["files"]],
                                         cache_dir=str(directory / "hub"), local_files_only=True))
        for entry in repo["files"]:
            path = snapshot / entry["path"]
            data = path.read_bytes()
            if "sha256" in entry:
                actual = hashlib.sha256(data).hexdigest()
                expected = entry["sha256"]
            else:
                actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
                expected = entry["git_blob"]
            if actual != expected:
                raise RuntimeError("TTS asset verification failed: " + entry["path"])
        # SDK requests main; the isolated offline cache must resolve only this pinned snapshot.
        ref = directory / "hub" / ("models--" + repo["repo"].replace("/", "--")) / "refs/main"
        if ref.read_text().strip() != repo["revision"]:
            raise RuntimeError("TTS offline cache reference does not match the manifest")


def pcm24(samples, rate: int) -> bytes:
    import numpy as np
    from scipy.signal import resample_poly
    from math import gcd

    audio = np.asarray(samples, dtype=np.float32)
    if (audio.ndim != 1 or not audio.size or not np.isfinite(audio).all()
            or rate <= 0 or audio.size > rate * MAX_AUDIO_SECONDS):
        raise ValueError("Invalid or oversized synthesized audio")
    if rate != SAMPLE_RATE:
        divisor = gcd(rate, SAMPLE_RATE)
        audio = resample_poly(audio, SAMPLE_RATE // divisor, rate // divisor)
    return np.rint(np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()


class Engine:
    def __init__(self, directory: Path):
        self.pronunciations = default_pronunciations()
        verify_assets(directory)
        import onnxruntime
        onnxruntime.disable_telemetry_events()
        from vieneu import Vieneu

        self.tts = Vieneu(mode="v3turbo", backend="onnx", device="cpu", threads=2,
                          backbone_repo="pnnbao-ump/VieNeu-TTS-v3-Turbo")

    def synthesize(self, text: str, meeting_id: int | None = None) -> bytes:
        # Preset voice only: never accept an audio reference or user model path.
        if text == ACK_TEXT and getattr(self, '_ack_pcm', None) is not None:
            return self._ack_pcm
        glossary = getattr(self, 'pronunciations', default_pronunciations()).for_meeting(meeting_id)
        speech_text = text if text == ACK_TEXT else spoken_text(text, glossary)
        audio = self.tts.infer(speech_text, voice=PRESET_VOICE, apply_watermark=False)
        pcm = pcm24(audio, self.tts.sample_rate)
        if text == ACK_TEXT: self._ack_pcm = pcm
        return pcm

    def stream(self, text: str, meeting_id: int | None = None):
        import numpy as np
        import soxr
        if text == ACK_TEXT and getattr(self, '_ack_pcm', None) is not None:
            yield self._ack_pcm
            return
        glossary = self.pronunciations.for_meeting(meeting_id)
        speech = text if text == ACK_TEXT else spoken_text(text, glossary)
        rate = self.tts.sample_rate
        resampler = soxr.ResampleStream(rate, SAMPLE_RATE, 1, dtype='float32', quality='HQ') if rate != SAMPLE_RATE else None
        chunks = self.tts.infer_stream(speech, voice=PRESET_VOICE, apply_watermark=False)
        samples = 0
        try:
            for chunk in chunks:
                audio = np.asarray(chunk, dtype=np.float32)
                if audio.ndim != 1 or not np.isfinite(audio).all(): raise ValueError('Invalid audio chunk')
                samples += audio.size
                if samples > rate * MAX_AUDIO_SECONDS: raise ValueError('Speech exceeds audio budget')
                if not audio.size: continue
                output = resampler.resample_chunk(audio) if resampler else audio
                if output.size:
                    yield np.rint(np.clip(output, -1, 1) * 32767).astype('<i2').tobytes()
            if resampler:
                output = resampler.resample_chunk(np.array([], dtype=np.float32), last=True)
                if output.size: yield np.rint(np.clip(output, -1, 1) * 32767).astype('<i2').tobytes()
        finally:
            chunks.close()
