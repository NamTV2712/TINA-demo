#!/usr/bin/env python3
"""Freeze a small public FLEURS test sample; audio and downloads stay outside Git."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import random
import subprocess
import sys

import pyarrow.parquet as pq
import soundfile as sf

DATASET = "google/fleurs"
SOURCE_REVISION = "70bb2e84b976b7e960aa89f1c648e09c59f894dd"
PARQUET_REVISION = "168de341b3db6859a9bac1c50a2ef5e3b47647e0"
SEED = 20261019
FILES = {
    "vi_vn": (691128728, "65325be18bef84bb97b5bad1145958ae752919bb0b6696e7cfa8409ef5c46c77"),
    "en_us": (401722686, "6428a4d04d3aac29e16b45e039bb1470a8bd7aa334cf92f7984c9c520d1f234d"),
}


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def prepare_language(cache, config):
    target = cache / "source" / (config + "-test.parquet")
    target.parent.mkdir(parents=True, exist_ok=True)
    expected_size, expected_hash = FILES[config]
    url = f"https://huggingface.co/datasets/{DATASET}/resolve/{PARQUET_REVISION}/{config}/test/0000.parquet"
    if not target.exists():
        partial = target.with_suffix(".parquet.part")
        subprocess.run(["curl", "--fail", "--location", "--retry", "3", "--continue-at", "-",
                        "--output", str(partial), url], check=True)
        if partial.stat().st_size != expected_size or sha256(partial) != expected_hash:
            raise ValueError(f"FLEURS source checksum mismatch: {config}")
        partial.replace(target)
    if target.stat().st_size != expected_size or sha256(target) != expected_hash:
        raise ValueError(f"Cached FLEURS source checksum mismatch: {config}")
    parquet = pq.ParquetFile(target)
    metadata = parquet.read(columns=["id", "path", "num_samples", "transcription", "gender"]).to_pylist()
    metadata.sort(key=lambda row: (row["path"], row["id"]))
    selected = random.Random(f"{SEED}:{config}").sample(metadata, 102)
    selected_paths = {row["path"]: (i, row) for i, row in enumerate(selected)}
    if len(selected_paths) != 102:
        raise ValueError("Source paths are not unique")
    samples = []
    # Decode at most four rows at a time, rather than retaining a language's audio in RAM.
    for batch in parquet.iter_batches(batch_size=4, columns=["path", "audio"]):
        for row in batch.to_pylist():
            selection = selected_paths.get(row["path"])
            if selection is None:
                continue
            index, reference = selection
            item_id = f"{config}-{Path(row['path']).stem}"
            audio = row["audio"]["bytes"]
            if not audio:
                raise ValueError(f"Missing embedded audio: {item_id}")
            output = cache / "audio" / f"{item_id}.wav"
            output.parent.mkdir(exist_ok=True)
            output.write_bytes(audio)
            info = sf.info(output)
            if info.samplerate != 16000 or info.channels != 1 or info.frames != reference["num_samples"]:
                raise ValueError(f"Unexpected FLEURS audio format: {item_id}")
            samples.append({"id": item_id, "config": config, "split": "test", "role": "test" if index < 100 else "warmup",
                            "path": str(output), "source_path": row["path"], "source_id": reference["id"],
                            "reference": reference["transcription"], "gender": reference["gender"],
                            "duration_s": info.duration, "sha256": sha256(output), "selection_index": index})
    if len(samples) != 102:
        raise ValueError(f"Incomplete extraction for {config}")
    print(f"Prepared {config}: 100 test + 2 disjoint warmup clips", flush=True)
    return {"config": config, "url": url, "bytes": expected_size, "sha256": expected_hash,
            "test_population": len(metadata)}, samples


def main():
    cache = Path(sys.argv[1]).expanduser().resolve()
    repo = Path(__file__).resolve().parents[3]
    if cache == repo or repo in cache.parents:
        raise SystemExit("Choose an external cache directory; benchmark audio must stay outside Git")
    cache.mkdir(parents=True, exist_ok=True)
    manifest = cache / "manifest.json"
    if manifest.exists():
        data = json.loads(manifest.read_text())
        if data.get("seed") != SEED or data.get("parquet_revision") != PARQUET_REVISION:
            raise ValueError("An incompatible manifest already exists; use another cache")
        for sample in data["samples"]:
            if sha256(sample["path"]) != sample["sha256"]:
                raise ValueError(f"Audio checksum mismatch: {sample['id']}")
        print("Existing frozen manifest verified", flush=True)
        return
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        prepared = list(pool.map(lambda cfg: prepare_language(cache, cfg), FILES))
    samples = [sample for _, rows in prepared for sample in rows]
    samples.sort(key=lambda row: row["id"])
    random.Random(SEED).shuffle(samples)
    # Public synthetic zero-PCM controls, kept separate from the speech error-rate denominator.
    for seconds in (2, 5, 10):
        path = cache / "audio" / f"silence-{seconds}s.wav"
        import numpy as np
        sf.write(path, np.zeros(seconds * 16000, dtype="float32"), 16000, subtype="PCM_16")
        samples.append({"id": path.stem, "config": "silence", "role": "silence", "path": str(path),
                        "reference": "", "duration_s": seconds, "sha256": sha256(path)})
    data = {"dataset": DATASET, "source_revision": SOURCE_REVISION, "parquet_revision": PARQUET_REVISION,
            "license": "CC-BY-4.0", "source": "https://huggingface.co/datasets/google/fleurs",
            "seed": SEED, "sampling": "100 random test utterances per language; 2 additional warmup utterances per language; frozen shared order",
            "source_files": [source for source, _ in prepared], "samples": samples}
    partial = manifest.with_suffix(".json.part")
    partial.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    partial.replace(manifest)
    print(f"Frozen manifest: {manifest}", flush=True)


if __name__ == "__main__":
    main()
