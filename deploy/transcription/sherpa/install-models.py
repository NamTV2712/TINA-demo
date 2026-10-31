#!/usr/bin/env python3
"""Download pinned upstream ONNX assets; never load both ASR runtimes here."""
import hashlib
import pathlib
import subprocess
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[3]
CACHE = ROOT / "deploy/transcription/models/sherpa"
MODEL = "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25"
ASSETS = {
    MODEL + ".tar.bz2": "393f8a14e2f5fb96746aaab342997a40641001fbd5bf9592a080a8329178ee96",
    "silero_vad.onnx": "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
}
CACHE.mkdir(parents=True, exist_ok=True)
for name, expected in ASSETS.items():
    target = CACHE / name
    if not target.exists():
        partial = target.with_suffix(target.suffix + ".part")
        subprocess.run(["curl", "--fail", "--location", "--retry", "3", "--continue-at", "-",
                        "--output", str(partial),
                        "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/" + name], check=True)
        partial.replace(target)
    with target.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != expected:
        raise SystemExit(f"Checksum mismatch: {name}. Remove this cached asset and retry.")
    if name.endswith(".tar.bz2") and not (CACHE / MODEL / "decoder.int8.onnx").exists():
        with tarfile.open(target) as archive:
            archive.extractall(CACHE, filter="data")
    print(f"Verified {name}")
print(f"Model directory: {CACHE / MODEL}")
