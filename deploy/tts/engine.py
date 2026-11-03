"""One preset VieNeu ONNX CPU voice, exposed in the bot's PCM format."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

MODEL = "vieneu-v3-turbo"
SAMPLE_RATE = 24000
MAX_AUDIO_SECONDS = 120


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
        verify_assets(directory)
        import onnxruntime
        onnxruntime.disable_telemetry_events()
        from vieneu import Vieneu

        self.tts = Vieneu(mode="v3turbo", backend="onnx", device="cpu", threads=2,
                          backbone_repo="pnnbao-ump/VieNeu-TTS-v3-Turbo")

    def synthesize(self, text: str) -> bytes:
        # Preset voice only: never accept an audio reference or user model path.
        audio = self.tts.infer(text, apply_watermark=False)
        return pcm24(audio, self.tts.sample_rate)
