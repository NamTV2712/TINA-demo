#!/usr/bin/env python3
"""Paired local system comparison; one ASR process at a time, restored in finally."""
import csv
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import sys
import threading
import time
import uuid

import httpx
import psutil

from metrics import score, summarize

ROOT = Path(__file__).resolve().parents[3]
NATIVE = ROOT / "core/meetings/services/native-asr/target/release/tina-native-asr"
PYTHON = ROOT / ".venv/funasr/bin/python"
FUNASR = ROOT / "deploy/transcription/funasr/server.py"
QWEN_REVISION = "5eb144179a02acc5e5ba31e748d22b0cf3e303b0"


def get(port, path):
    return httpx.get(f"http://127.0.0.1:{port}/{path}", timeout=5).raise_for_status().json()


def sha(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def listener(port):
    p = subprocess.run(["lsof", "-nP", "-t", f"-iTCP:{port}", "-sTCP:LISTEN"], capture_output=True, text=True)
    ids = set(p.stdout.split())
    if len(ids) > 1:
        raise RuntimeError(f"Multiple listeners at {port}")
    return psutil.Process(int(ids.pop())) if ids else None


def stop(process):
    if isinstance(process, subprocess.Popen):
        if process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            raise RuntimeError("ASR did not exit cleanly; refusing to load another model")
        return
    if process is None or not process.is_running():
        return
    process.terminate()
    try:
        process.wait(timeout=30)
    except (psutil.TimeoutExpired, subprocess.TimeoutExpired):
        raise RuntimeError("ASR did not exit cleanly; refusing to load another model")


class RssSampler:
    """Observed RSS only; this is not total Apple GPU/unified memory accounting."""
    def __init__(self, pid):
        self.process = psutil.Process(pid)
        self.peak = 0
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.collect, daemon=True)

    def current(self):
        try:
            return self.process.memory_info().rss + sum(p.memory_info().rss for p in self.process.children(recursive=True) if p.is_running())
        except psutil.Error:
            return 0

    def collect(self):
        while not self.stop_event.wait(.1):
            self.peak = max(self.peak, self.current())

    def __enter__(self):
        self.peak = self.current()
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.peak = max(self.peak, self.current())
        self.stop_event.set()
        self.thread.join()


def launch(name, output):
    if listener(18000) or listener(18001):
        raise RuntimeError("Another ASR listener is present; refusing to load two models")
    env = os.environ.copy()
    if name == "sherpa":
        command, port = [str(NATIVE)], 18001
    else:
        command, port = [str(PYTHON), str(FUNASR)], 18000
        env.update(FUNASR_DEVICE="mps", FUNASR_PORT="18000", HF_HUB_OFFLINE="1", PYTHONUNBUFFERED="1")
        # Freeze the cached HF checkpoint rather than following a mutable remote main ref.
        hf = Path.home() / ".cache/huggingface/hub/models--Qwen--Qwen3-ASR-0.6B"
        revision = (hf / "refs/main").read_text().strip()
        if revision != QWEN_REVISION:
            raise RuntimeError("The cached Qwen checkpoint revision changed")
        # FunASR's registry needs the model name; HF offline mode fixes it to the checked cache ref.
        env["FUNASR_MODEL"] = "Qwen/Qwen3-ASR-0.6B"
    logfile = output / f"{name}-service.log"
    started = time.perf_counter()
    with logfile.open("ab", buffering=0) as log:
        process = subprocess.Popen(command, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                                   stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    sampler = RssSampler(process.pid)
    with sampler:
        for _ in range(600):
            if process.poll() is not None:
                raise RuntimeError(f"{name} exited {process.returncode}; see {logfile}")
            try:
                get(port, "health")
                status = get(port, "status")
                return process, port, {"startup_seconds": time.perf_counter() - started,
                    "startup_peak_sampled_rss_bytes": sampler.peak, "model": status["model"], "pid": process.pid}
            except (httpx.HTTPError, ValueError):
                time.sleep(.2)
    stop(process)
    raise RuntimeError(f"{name} readiness exceeded 120s")


def request(client, port, sample, pid):
    request_id = str(uuid.uuid4())
    started = time.perf_counter()
    row = {"id": sample["id"], "config": sample["config"], "role": sample["role"], "request_id": request_id,
           "reference": sample["reference"], "duration_s": sample["duration_s"], "ok": False, "text": ""}
    with RssSampler(pid) as rss:
        try:
            with Path(sample["path"]).open("rb") as wav:
                r = client.post(f"http://127.0.0.1:{port}/v1/audio/transcriptions",
                    files={"file": ("benchmark.wav", wav, "audio/wav")},
                    data={"model": "custom", "response_format": "verbose_json"},
                    headers={"X-ASR-Source": "unknown", "X-ASR-Request-ID": request_id})
            row["http_status"] = r.status_code
            r.raise_for_status()
            body = r.json()
            if not isinstance(body.get("text"), str):
                raise ValueError("Transcription has no text field")
            row.update(ok=True, text=body["text"], segments=body.get("segments", []))
            timing = dict(re.findall(r"(asr_\w+);dur=([0-9.]+)", r.headers.get("Server-Timing", "")))
            row["server_timing_ms"] = {k: float(v) for k, v in timing.items()}
            row["invalid_segment_intervals"] = sum(
                not (isinstance(s.get("start"), (int, float)) and isinstance(s.get("end"), (int, float)) and
                     0 <= s["start"] <= s["end"] <= sample["duration_s"] + .05)
                for s in row["segments"])
        except (httpx.HTTPError, ValueError, TypeError) as e:
            row["error"] = str(e)[:500]
    row["latency_s"] = time.perf_counter() - started
    row["peak_rss_bytes"] = rss.peak
    row["score"] = score(sample["reference"], row["text"])
    return row


def main():
    cache, output = (Path(p).expanduser().resolve() for p in sys.argv[1:3])
    resume = sys.argv[3:] == ["--resume"]
    if sys.argv[3:] and not resume:
        raise SystemExit("Only --resume is supported after CACHE OUTPUT")
    output.mkdir(parents=True, exist_ok=resume)
    manifest_path = cache / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    for sample in manifest["samples"]:
        if sha(sample["path"]) != sample["sha256"]:
            raise ValueError(f"Audio checksum changed: {sample['id']}")
    if get(8056, "health")["live_sessions"]:
        raise RuntimeError("A live Desktop capture is active; finish it before benchmarking")
    original = listener(18001)
    if original is None or original.cmdline()[0] != str(NATIVE):
        raise RuntimeError("Expected the current native Sherpa service; no process was changed")
    if listener(18000):
        raise RuntimeError("FunASR is already running; no process was changed")
    queue = get(18001, "status")["queue"]
    if queue["active"] or queue["waiting"]:
        raise RuntimeError("ASR is busy; no process was changed")
    metadata = {"dataset_manifest": str(manifest_path), "manifest_sha256": sha(manifest_path),
        "dataset_revision": manifest["source_revision"], "parquet_revision": manifest["parquet_revision"],
        "seed": manifest["seed"], "machine": platform.platform(),
        "host": subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string", "hw.memsize", "hw.ncpu"], text=True).splitlines(),
        "profile_order": ["sherpa", "funasr"], "language_hint": "auto", "concurrency": 1,
        "normalization": "NFC, casefold, punctuation/symbols to spaces except apostrophes inside words; preserve accents and digits; CER removes whitespace",
        "metrics_environment": {name: importlib.metadata.version(name) for name in ["jiwer", "rapidfuzz", "psutil", "httpx", "pyarrow"]},
        "native_binary_sha256": sha(NATIVE), "native_lock_sha256": sha(NATIVE.parents[2] / "Cargo.lock"),
        "funasr_checkpoint_revision": QWEN_REVISION,
        "funasr_server_sha256": sha(FUNASR), "funasr_telemetry_sha256": sha(FUNASR.with_name("telemetry.py")),
        "notes": ["Pilot sample, not a full official FLEURS score", "Configurations differ in runtime, VAD, quantization, chunking and CPU/MPS device",
                  "RSS sampled at 100ms; excludes some GPU/unified-memory allocations and is not total system RAM",
                  "No code-switching accuracy or ground-truth timestamp alignment claim", "No automatic retries; failed requests score as empty hypotheses"]}
    metadata_path = output / "metadata.json"
    if resume:
        previous = json.loads(metadata_path.read_text())
        for field in ("manifest_sha256", "native_binary_sha256", "native_lock_sha256", "funasr_server_sha256", "funasr_telemetry_sha256", "host"):
            if metadata[field] != previous[field]:
                raise RuntimeError(f"Cannot resume: {field} changed")
        previous.setdefault("resume_history", []).append({"at_unix": time.time(), "reason": "FunASR name registry requires named model, using the verified HF offline cache; completed profile results preserved"})
        previous["funasr_checkpoint_revision"] = QWEN_REVISION
        metadata = previous
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    processes = []
    initial_stopped = False
    try:
        stop(original)
        initial_stopped = True
        for name in metadata["profile_order"]:
            direct_path, replay_path = output / f"{name}-direct.jsonl", output / f"{name}-replay.jsonl"
            if resume and direct_path.exists() and replay_path.exists():
                direct_rows = [json.loads(line) for line in direct_path.read_text().splitlines() if line]
                replay_rows = [json.loads(line) for line in replay_path.read_text().splitlines() if line]
                expected = {s["id"] for s in manifest["samples"] if s["role"] == "test"}
                if len(direct_rows) == len(manifest["samples"]) and {r["id"] for r in direct_rows if r["role"] == "test"} == expected and len(replay_rows) == 10:
                    print(json.dumps({"phase": "resume_preserved", "backend": name, "direct_rows": len(direct_rows), "replay_rows": len(replay_rows)}), flush=True)
                    continue
            if direct_path.exists() or replay_path.exists():
                raise RuntimeError(f"Incomplete {name} results exist; preserve them and use a new result directory")
            process, port, details = launch(name, output)
            processes.append(process)
            (output / f"{name}-runtime.json").write_text(json.dumps(details, indent=2) + "\n")
            print(json.dumps({"phase": "started", "backend": name, **details}), flush=True)
            rows = []
            ordered = [s for s in manifest["samples"] if s["role"] == "warmup"] + [s for s in manifest["samples"] if s["role"] != "warmup"]
            with httpx.Client(timeout=180, trust_env=False) as client, (output / f"{name}-direct.jsonl").open("w") as stream:
                for index, sample in enumerate(ordered, 1):
                    row = request(client, port, sample, process.pid)
                    stream.write(json.dumps(row, ensure_ascii=False) + "\n")
                    stream.flush()
                    rows.append(row)
                    print(json.dumps({"phase": "direct", "backend": name, "done": index, "total": len(ordered),
                                      "id": row["id"], "ok": row["ok"], "latency_s": round(row["latency_s"], 3)}), flush=True)
            summary = {cfg: summarize([r for r in rows if r["role"] == "test" and r["config"] == cfg]) for cfg in ["vi_vn", "en_us"]}
            summary["silence"] = {"clips": 3, "nonempty_outputs": sum(bool(r["text"].strip()) for r in rows if r["role"] == "silence")}
            (output / f"{name}-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
            # This runner creates ephemeral Desktop instances, leaving the user's RAM store alone.
            subprocess.run(["node", str(Path(__file__).with_name("replay.mjs")), str(manifest_path),
                            f"http://127.0.0.1:{port}", str(output / f"{name}-replay.jsonl")], cwd=ROOT, check=True)
            stop(process)
            processes.remove(process)
    finally:
        for process in processes:
            stop(process)
        if initial_stopped:
            if listener(18001) is None and listener(18000) is None:
                restored, _, details = launch("sherpa", output)
                if (output / "restored-sherpa.json").exists():
                    previous_restore = output / "restored-sherpa-before-resume.json"
                    if previous_restore.exists():
                        previous_restore = output / f"restored-sherpa-{time.time_ns()}.json"
                    (output / "restored-sherpa.json").rename(previous_restore)
                (output / "restored-sherpa.json").write_text(json.dumps(details, indent=2) + "\n")
                print(json.dumps({"phase": "restored", "backend": "sherpa", "pid": restored.pid}), flush=True)
            else:
                raise RuntimeError("Another ASR listener appeared; cannot safely restore the original service")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    main()
