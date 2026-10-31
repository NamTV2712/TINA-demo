#!/usr/bin/env python3
"""Render the complete paired run; never present a partial sample as the full benchmark."""
import csv
import hashlib
import json
from pathlib import Path
import shutil
import sys

import numpy as np
import soundfile as sf

from metrics import percentile, score, summarize


def load_rows(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def number(value, scale=1):
    return "—" if value is None else f"{value * scale:.2f}"


def main():
    output = Path(sys.argv[1]).expanduser().resolve()
    metadata = json.loads((output / "metadata.json").read_text())
    manifest = json.loads(Path(metadata["dataset_manifest"]).read_text())
    expected = {s["id"] for s in manifest["samples"] if s["role"] == "test"}
    summary, direct, replay = {}, {}, {}
    table = ["| Backend | Language | Clips | Failed requests | WER % | CER % | p50 s | p95 s | Aggregate RTF | Observed peak RSS MiB |",
             "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    all_csv = []
    for backend in metadata["profile_order"]:
        rows = load_rows(output / f"{backend}-direct.jsonl")
        test = [r for r in rows if r["role"] == "test"]
        if len(test) != 200 or {r["id"] for r in test} != expected:
            raise ValueError(f"{backend} has an incomplete or mismatched test sample")
        direct[backend] = {r["id"]: r for r in test}
        runtime = json.loads((output / f"{backend}-runtime.json").read_text())
        by_language = {}
        for language in ["vi_vn", "en_us"]:
            group = [r for r in test if r["config"] == language]
            result = summarize(group)
            by_language[language] = result
            table.append(f"| {backend} | {language} | {result['clips']} | {result['failures']} | "
                         f"{number(result['wer'], 100)} | {number(result['cer'], 100)} | "
                         f"{number(result['latency_p50_s'])} | {number(result['latency_p95_s'])} | "
                         f"{number(result['rtf_aggregate'])} | {number(result['peak_sampled_rss_mib'])} |")
        controls = [r for r in rows if r["role"] == "silence"]
        summary[backend] = {"runtime": runtime, "direct": by_language,
            "silence": {"clips": len(controls), "failures": sum(not r["ok"] for r in controls),
                        "nonempty_outputs": sum(bool(r["text"].strip()) for r in controls)},
            "invalid_segment_intervals": sum(r.get("invalid_segment_intervals", 0) for r in rows)}
        for row in test:
            scores = row["score"]
            all_csv.append({"backend": backend, "language": row["config"], "id": row["id"], "ok": row["ok"],
                            "duration_s": row["duration_s"], "latency_s": row["latency_s"],
                            "wer": scores["word_errors"] / max(1, scores["ref_words"]),
                            "cer": scores["char_errors"] / max(1, scores["ref_chars"]),
                            "substitutions": scores["substitutions"], "deletions": scores["deletions"],
                            "insertions": scores["insertions"], "peak_rss_mib": row["peak_rss_bytes"] / 1024**2})
        rrows = load_rows(output / f"{backend}-replay.jsonl")
        if len(rrows) != 10 or len({r["id"] for r in rrows}) != 10:
            raise ValueError(f"{backend} replay is incomplete")
        for row in rrows:
            row["score"] = score(row["reference"], row.get("text", ""))
        replay[backend] = rrows
    if {r["id"] for r in replay["sherpa"]} != {r["id"] for r in replay["funasr"]}:
        raise ValueError("Replay clip IDs differ across backends")
    replay_table = ["| Backend | Language | Clips | Failed | WER % | CER % | First text p50 s | First text p95 s | Finalization p50 s | Finalization p95 s |",
                    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    paired_table = ["| Backend | Language | Same clips | Direct WER % | Replay WER % | Change (percentage points) |",
                    "|---|---|---:|---:|---:|---:|"]
    for backend, rows in replay.items():
        summary[backend]["replay"] = {}
        for language in ["vi_vn", "en_us"]:
            group = [r for r in rows if r["config"] == language]
            result = {key: value for key, value in summarize(group).items()
                      if key not in ("rtf_aggregate", "peak_sampled_rss_mib", "latency_p50_s", "latency_p95_s")}
            result.update({"first_text_p50_s": percentile([r.get("first_text_s") for r in group], .5),
                           "first_text_p95_s": percentile([r.get("first_text_s") for r in group], .95),
                           "finalization_p50_s": percentile([r.get("finalization_delay_s") for r in group], .5),
                           "finalization_p95_s": percentile([r.get("finalization_delay_s") for r in group], .95)})
            summary[backend]["replay"][language] = result
            matched = summarize([direct[backend][r["id"]] for r in group])
            result["matched_direct_wer"] = matched["wer"]
            result["wer_change_percentage_points"] = (result["wer"] - matched["wer"]) * 100
            paired_table.append(f"| {backend} | {language} | {len(group)} | {number(matched['wer'],100)} | "
                                f"{number(result['wer'],100)} | {number(result['wer_change_percentage_points'])} |")
            replay_table.append(f"| {backend} | {language} | {result['clips']} | {result['failures']} | "
                                f"{number(result['wer'],100)} | {number(result['cer'],100)} | "
                                f"{number(result['first_text_p50_s'])} | {number(result['first_text_p95_s'])} | "
                                f"{number(result['finalization_p50_s'])} | {number(result['finalization_p95_s'])} |")
    source_samples = {s["id"]: s for s in manifest["samples"]}
    levels = {}
    for row in replay["sherpa"]:
        pcm, _ = sf.read(source_samples[row["id"]]["path"], dtype="float32")
        levels[row["id"]] = float(np.sqrt(np.mean(pcm.astype("float64") ** 2)))
    quiet_table = ["| Backend | Clip ID | Full-clip RMS | Direct WER % | Replay WER % | Deleted reference tokens in replay |",
                   "|---|---|---:|---:|---:|---:|"]
    for backend, rows in replay.items():
        for row in rows:
            if levels[row["id"]] >= .0025:
                continue
            d = direct[backend][row["id"]]["score"]
            s = row["score"]
            quiet_table.append(f"| {backend} | `{row['id']}` | {levels[row['id']]:.6f} | "
                               f"{number(d['word_errors']/max(1,d['ref_words']),100)} | "
                               f"{number(s['word_errors']/max(1,s['ref_words']),100)} | {s['deletions']} / {s['ref_words']} |")
    summary["quiet_replay_audio_rms"] = levels
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    with (output / "clips.csv").open("w") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(all_csv[0]))
        writer.writeheader(); writer.writerows(all_csv)
    text = ["# TINA ASR benchmark — FLEURS pilot / Đánh giá sơ bộ", "",
            "## Scope / Phạm vi", "",
            "100 human-recorded Vietnamese test clips + 100 English test clips, paired across both configurations. "
            "Four disjoint warmup clips and three zero-PCM controls are excluded from speech WER/CER. "
            "No code-switching test set was available in this run. This is not the full official FLEURS benchmark.", "",
            f"Dataset: [{manifest['dataset']}]({manifest['source']}), CC-BY-4.0, attribution: Google/FLEURS contributors. "
            "[FLEURS paper](https://arxiv.org/abs/2205.12446).", "",
            f"Source revision: `{manifest['source_revision']}`; converted Parquet revision: `{manifest['parquet_revision']}`. "
            f"Seed: `{manifest['seed']}`. Manifest SHA-256: `{metadata['manifest_sha256']}`.", "",
            "Machine: " + " · ".join(metadata["host"]) + "; " + metadata["machine"] + ". "
            "Host fields are CPU model, installed RAM in bytes, and logical CPU count.", "",
            "## Direct local API / Gọi ASR trực tiếp", "", *table, "",
            "WER aggregates edit counts over reference whitespace tokens (Vietnamese syllable-style tokenization); "
            "CER removes whitespace. Lower is better. Both keep Vietnamese diacritics. Digits are not verbalized. "
            "HTTP failures count as empty hypotheses, hence deletions, and are also listed separately. "
            "RTF = sum of local request seconds / sum of audio seconds; RTF < 1 means faster than audio duration for these clips.", "",
            "Latency is whole-WAV request→response, not live speech endpointing delay. "
            "The p50/p95 columns use nearest-rank percentiles. All 200 test clips use auto language, no prompt, one request at a time.", "",
            "## Digital realtime replay / Replay qua Desktop", "", *replay_table, "",
            "Five fixed clips per language are fed as capture.v1 float32 packets at real-time speed, 100 ms per packet, "
            "into ephemeral Desktop instances on random loopback ports. First text is the first nonempty pending or confirmed "
            "WebSocket transcript, measured from the start of audio replay. Finalization delay is measured after audio input ends. "
            "These measurements exclude macOS hardware capture and actual browser/Tauri paint latency. "
            "The existing user's Desktop store and meetings are not reset.", "",
            "### Same-clip direct vs replay / So sánh cùng clip", "", *paired_table, "",
            "This comparison uses exactly the same 5 clips per language, rather than comparing a 5-clip replay "
            "against the full 100-clip direct mean. Any increase describes the complete live-window/confirmation "
            "path; it does not by itself identify which stage caused an omission or duplication.", "",
            "### Quiet speech / Tiếng nói nhỏ", "", *quiet_table, "",
            "The deployed SpeakerStreamManager defaults to a fixed RMS silence threshold of 0.0025 "
            "(`core/meetings/modules/gmeet-pipeline/src/speaker-streams.ts`). Replay logs contain SILENT-SKIP "
            "events for low-level windows. The English quiet clip is empty in both replay paths, although "
            "direct ASR returns text. Full-clip RMS is descriptive; the actual gate operates on each submitted "
            "window. This identifies quiet-speech gating as a follow-up target, not an isolated VAD-model score. "
            "The waveform was not gain-normalized to hide this behavior.", "",
            "## Runtime / Tài nguyên", ""]
    for backend in metadata["profile_order"]:
        result = summary[backend]; runtime = result["runtime"]
        text += [f"- **{backend}**: `{runtime['model']['asr_model']}` + `{runtime['model']['vad_model']}`; "
                 f"reported device `{runtime['model']['device']}`. Process launch→healthy: {runtime['startup_seconds']:.2f} s. "
                 f"Startup sampled peak RSS: {runtime['startup_peak_sampled_rss_bytes']/1024**2:.1f} MiB. "
                 f"Silent controls with text: {result['silence']['nonempty_outputs']}/{result['silence']['clips']}. "
                 f"Structurally invalid segment intervals: {result['invalid_segment_intervals']}."]
    text += ["", "## Limits / Giới hạn", "",
             "- This compares deployed configurations. Runtime, quantization, VAD, chunk limits and CPU/MPS execution differ; "
             "it does not isolate a causal Silero-vs-FSMN effect.",
             "- RSS is sampled every 100 ms from the ASR process and descendants. It can miss short peaks and exclude "
             "some GPU/unified-memory allocations. Do not treat the RSS difference as a full Apple system-memory saving.",
             "- Startup is one observation with OS/model file caches available, not a cold machine boot. "
             "Only one profile order/pass was run; background workload and thermal state can affect timing.",
             "- The small random sample is a pilot, not a speaker-independent statistical claim. "
             "FLEURS read speech does not represent all accents, noisy meetings, overlapped speakers, echo, or English–Vietnamese code switching.",
             "- Segment interval checks validate bounds only. There is no timestamp alignment ground truth in this evaluation.", "",
             "- Startup recovery history: " + ("A FunASR registry-name launch correction was applied before any FunASR scored request; completed Sherpa measurements were preserved. See metadata.json and run-initial.py." if metadata.get("resume_history") else "No resumed profile."), "",
             "## Evidence / Bằng chứng", "",
             "- `metadata.json`: manifest fingerprint, host/configuration and source hashes.",
             "- `provenance.json`: model/cache checksums, FunASR package versions and direct-phase request-ID log audit (collected after the run).",
             "- `*-direct.jsonl`: one outcome per warmup/test/control request, including transcript, edit counts, timings and observed RSS.",
             "- `*-replay.jsonl`: raw isolated pipeline results and timing evidence.",
             "- `summary.json`, `clips.csv`: machine-readable summaries and per-clip comparisons.",
             "- `restored-sherpa.json`: original serving profile restored after measurement.",
             "- `runner-snapshot/`: the benchmark source used for this run.", ""]
    diagnostic = output / "sherpa-502-diagnostic.json"
    if diagnostic.exists():
        row = json.loads(diagnostic.read_text())
        text += ["## HTTP 502 diagnostic / Kiểm tra riêng", "",
                 f"Clip `{row['id']}` was repeated once after restoring a fresh Sherpa process: "
                 f"HTTP {row.get('http_status', 'unavailable')}. This diagnostic is excluded from the benchmark; "
                 "the original failed clip remains scored as an empty hypothesis. See `sherpa-502-diagnostic.json`.", ""]
    (output / "REPORT.md").write_text("\n".join(text))
    snapshots = output / "runner-snapshot"
    snapshots.mkdir(exist_ok=True)
    for name in ["prepare.py", "metrics.py", "run.py", "replay.mjs", "report.py", "test_metrics.py", "requirements.txt", "README.md"]:
        source = Path(__file__).with_name(name)
        if source.exists():
            shutil.copy2(source, snapshots / name)
    print(output / "REPORT.md")


if __name__ == "__main__":
    main()
