#!/usr/bin/env python3
"""Replay the original frozen clips after the RMS fix; preserve baseline and user's Desktop."""
import json
import os
from pathlib import Path
import subprocess
import sys

import numpy as np
import soundfile as sf

from run import ROOT, NATIVE, get, launch, listener, request, sha, stop


def main():
    cache, baseline, output = (Path(p).expanduser().resolve() for p in sys.argv[1:4])
    output.mkdir(parents=True, exist_ok=False)
    manifest_path = cache / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    original_manifest = json.loads(json.dumps(manifest))
    assert sha(manifest_path) == json.loads((baseline / "metadata.json").read_text())["manifest_sha256"]
    # Exercise a near-zero guard and non-speech above the lowered floor without altering speech audio.
    control_audio = {
        "quantization-noise-5s": np.tile(np.array([-1, 1], dtype="float32") / 32768, 40000),
        "quiet-white-noise-5s": np.random.default_rng(20261020).normal(0, .0005, 80000).astype("float32"),
    }
    for name, pcm in control_audio.items():
        path = output / f"{name}.wav"
        sf.write(path, pcm, 16000, subtype="FLOAT")
        manifest["samples"].append({"id": name, "config": "synthetic_noise", "role": "control", "path": str(path),
                                    "reference": "", "duration_s": 5, "sha256": sha(path)})
    recheck_manifest = output / "manifest.json"
    recheck_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    for sample in original_manifest["samples"]:
        if sha(sample["path"]) != sample["sha256"]:
            raise RuntimeError(f"Speech audio changed: {sample['id']}")
    if get(8056, "health")["live_sessions"]:
        raise RuntimeError("A real capture is active; no ASR process was changed")
    original = listener(18001)
    if original is None or original.cmdline()[0] != str(NATIVE) or listener(18000):
        raise RuntimeError("Expected a single native Sherpa service; no process was changed")
    queue = get(18001, "status")["queue"]
    if queue["active"] or queue["waiting"]:
        raise RuntimeError("The ASR service is busy")
    sources = ["core/meetings/modules/gmeet-pipeline/src/speaker-streams.ts", "core/meetings/modules/buffer/src/gmeet-compatible-buffer.ts",
               "core/meetings/modules/gmeet-pipeline/dist/speaker-streams.js", "core/meetings/modules/buffer/dist/gmeet-compatible-buffer.js",
               "deploy/transcription/benchmark/replay.mjs"]
    metadata = {"baseline": str(baseline), "original_manifest_sha256": sha(manifest_path), "default_rms_before": .0025,
                "default_rms_after": .0001, "profiles": ["sherpa", "funasr"], "controls": "3 original digital-silence clips + quantization residue + quiet white noise",
                "source_sha256": {p: sha(ROOT / p) for p in sources},
                "baseline_replay_sha256": {p.name: sha(p) for p in [baseline / "sherpa-replay.jsonl", baseline / "funasr-replay.jsonl"]},
                "limits": "10 speech clips reused from baseline; warmup history differs, so latency comparisons are exploratory; no real hardware/UI capture"}
    (output / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    current = None
    changed = False
    try:
        stop(original); changed = True
        for backend in metadata["profiles"]:
            current, port, details = launch(backend, output)
            (output / f"{backend}-runtime.json").write_text(json.dumps(details, indent=2) + "\n")
            import httpx
            with httpx.Client(timeout=180, trust_env=False) as client, (output / f"{backend}-warmup.jsonl").open("w") as f:
                for sample in original_manifest["samples"]:
                    if sample["role"] == "warmup":
                        f.write(json.dumps(request(client, port, sample, current.pid), ensure_ascii=False) + "\n")
            print(json.dumps({"phase": "recheck", "backend": backend, "pid": current.pid}), flush=True)
            subprocess.run(["node", str(Path(__file__).with_name("replay.mjs")), str(recheck_manifest),
                            f"http://127.0.0.1:{port}", str(output / f"{backend}-replay.jsonl"), "--controls"], cwd=ROOT, check=True)
            stop(current); current = None
    finally:
        if current is not None:
            stop(current)
        if changed:
            if listener(18000) or listener(18001):
                raise RuntimeError("Unexpected ASR listener; cannot safely restore Sherpa")
            restored, _, details = launch("sherpa", output)
            (output / "restored-sherpa.json").write_text(json.dumps(details, indent=2) + "\n")
            print(json.dumps({"phase": "restored", "pid": restored.pid}), flush=True)


if __name__ == "__main__":
    main()
