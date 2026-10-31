#!/usr/bin/env python3
"""Compare the frozen baseline with the isolated gate recheck, without replacing baseline data."""
import json
from pathlib import Path
import sys

from metrics import score, summarize
from run import NATIVE, FUNASR, sha


def rows(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def main():
    output = Path(sys.argv[1]).expanduser().resolve()
    metadata = json.loads((output / "metadata.json").read_text())
    baseline = Path(metadata["baseline"])
    original = json.loads((baseline / "metadata.json").read_text())
    for key, path in [("native_binary_sha256", NATIVE), ("funasr_server_sha256", FUNASR),
                      ("funasr_telemetry_sha256", FUNASR.with_name("telemetry.py"))]:
        if sha(path) != original[key]:
            raise RuntimeError(f"ASR implementation changed: {key}")
    for name, expected in metadata["baseline_replay_sha256"].items():
        if sha(baseline / name) != expected:
            raise RuntimeError(f"Baseline changed: {name}")
    table = ["| Backend | Language | Same clips | WER before % | WER after % | CER before % | CER after % |",
             "|---|---|---:|---:|---:|---:|---:|"]
    controls_table = ["| Backend | Controls | Pipeline failures | Nonempty transcripts |",
                      "|---|---:|---:|---:|"]
    summary = {}
    quiet_table = ["| Backend | Quiet clip | Reference tokens | Deleted before | Deleted after | Transcript tokens before / after |",
                   "|---|---|---:|---:|---:|---:|"]
    quiet_ids = {"vi_vn-16723053061344391674", "en_us-7702334162140062110"}
    for backend in metadata["profiles"]:
        before = rows(baseline / f"{backend}-replay.jsonl")
        after = rows(output / f"{backend}-replay.jsonl")
        speech = [r for r in after if r["role"] == "test"]
        controls = [r for r in after if r["role"] in ("silence", "control")]
        if len(before) != 10 or len(speech) != 10 or len(controls) != 5:
            raise RuntimeError(f"Incomplete {backend} comparison")
        if {r["id"] for r in before} != {r["id"] for r in speech}:
            raise RuntimeError("Speech clip IDs differ")
        for row in before + speech:
            row["score"] = score(row["reference"], row.get("text", ""))
        result = {}
        for language in ("vi_vn", "en_us"):
            a = summarize([r for r in before if r["config"] == language])
            b = summarize([r for r in speech if r["config"] == language])
            result[language] = {"before": a, "after": b}
            table.append(f"| {backend} | {language} | 5 | {a['wer']*100:.2f} | {b['wer']*100:.2f} | {a['cer']*100:.2f} | {b['cer']*100:.2f} |")
        for item_id in sorted(quiet_ids):
            a = next(r for r in before if r["id"] == item_id)
            b = next(r for r in speech if r["id"] == item_id)
            quiet_table.append(f"| {backend} | `{item_id}` | {a['score']['ref_words']} | {a['score']['deletions']} | "
                               f"{b['score']['deletions']} | {len(a['score']['normalized_hypothesis'].split())} / {len(b['score']['normalized_hypothesis'].split())} |")
        result["controls"] = {"clips": len(controls), "failures": sum(not r["ok"] for r in controls),
                              "nonempty_outputs": sum(bool(r.get("text", "").strip()) for r in controls)}
        controls_table.append(f"| {backend} | 5 | {result['controls']['failures']} | {result['controls']['nonempty_outputs']} |")
        summary[backend] = result
    (output / "comparison.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    text = ["# TINA — quiet-speech RMS gate recheck / Kiểm tra bản sửa gate RMS", "",
            "Default changed from `0.0025` to `0.0001` in both parity-locked buffers. "
            "Explicit thresholds (including zero) retain their meaning. No ASR model, VAD or audio gain was changed.", "",
            "## Same 10 speech clips / Cùng 10 clip", "", *table, "",
            "WER uses the same accent-preserving whitespace-token scoring as the baseline; lower is better. "
            "HTTP/pipeline failures count as empty hypotheses. This is a focused regression comparison, not a new full FLEURS score.", "",
            "## Quiet clips / Clip tiếng nói nhỏ", "", *quiet_table, "",
            "## Silence and noise controls / Im lặng và nhiễu", "", *controls_table, "",
            "Controls: the original 2/5/10 s digital-silence clips, 5 s alternating PCM16 quantization residue, "
            "and 5 s seeded white noise at RMS approximately 0.0005 (above the new floor, below the old gate). "
            "Nonempty outputs are measured after the complete Desktop pipeline, including backend VAD and the existing phrase filter.", "",
            "## Scope / Giới hạn", "",
            "- Original speech audio, ordering and baseline results remain unchanged; their hashes are recorded in metadata.json.",
            "- Each ASR runs alone. Ephemeral Desktop instances use random loopback ports, preserving the real Desktop meeting store.",
            "- Four original warmup clips are used in this recheck; the baseline warmed through 200 direct cases before replay. "
            "Timing comparisons are exploratory, not an isolated latency-improvement claim.",
            "- These controls do not establish safety for every noise type or ASR backend. The RMS floor is not a speech detector.",
            "- No microphone/system hardware, browser paint, code-switching, timestamp alignment or echo test is included.",
            "- The separate native Sherpa HTTP 502 regression is outside this change.", "",
            "Evidence: metadata.json, manifest.json, *-replay.jsonl, *-runtime.json, restored-sherpa.json. "
            f"Baseline: `{baseline}`.", ""]
    (output / "REPORT.md").write_text("\n".join(text))
    print(output / "REPORT.md")


if __name__ == "__main__":
    main()
