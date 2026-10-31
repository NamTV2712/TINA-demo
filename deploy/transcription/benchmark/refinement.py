#!/usr/bin/env python3
"""Paired live → second-pass benchmark on cached audio; never restart or reconfigure ASR."""
import collections
import csv
import hashlib
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import time

import httpx
import numpy as np
import psutil
import soundfile as sf

from metrics import normalize, percentile, score
from run import ROOT, RssSampler, get, listener, request, sha

SEED = 20261021


def prepare(cache: Path, output: Path) -> dict:
    rng = random.Random(SEED)
    manifests = [cache / "fleurs-20261019/manifest.json", cache / "multi-corpus-20261020-01/manifest.json",
                 cache / "multi-corpus-20261020-01/commonvoice/manifest.json"]
    fleurs, multi, cv = [json.loads(p.read_text()) for p in manifests]
    samples = []
    groups = [(fleurs, "fleurs_vi", "vi_vn"), (fleurs, "fleurs_en", "en_us"),
              (cv, "commonvoice_vi", "vi_vn"), (multi, "librispeech_other_en", "en_us")]
    for manifest, group, language in groups:
        pool = [s for s in manifest["samples"] if s["role"] == "test" and s["config"] == language]
        for source in rng.sample(pool, 20):
            sample = {k: source[k] for k in ("id", "config", "role", "reference", "path", "duration_s", "sha256")}
            sample.update(group=group, dataset=source.get("dataset", "google/fleurs"), cluster=source["id"])
            samples.append(sample)
    derived = output / "derived-audio"
    derived.mkdir()
    for source in [s for s in multi["samples"] if s["role"] == "replay"]:
        assert sha(source["path"]) == source["sha256"]
        pcm, rate = sf.read(source["path"], frames=16000 * 60, dtype="float32")
        assert rate == 16000 and pcm.ndim == 1 and len(pcm) == 16000 * 60
        target = derived / (source["id"] + "-first60.wav")
        sf.write(target, pcm, rate, subtype="FLOAT")
        words = [w["text"] for w in source["reference_words"] if 0 <= (w["start"] + w["end"]) / 2 < 60]
        samples.append({"id": target.stem, "dataset": "ami", "group": "ami_" + source["condition"],
                        "config": "en_us", "role": "test", "reference": " ".join(words), "path": str(target),
                        "duration_s": 60., "sha256": sha(target), "cluster": source["meeting_group"],
                        "parent_sha256": source["sha256"], "source_start_s": source["source_start_s"]})
    used = {s["id"] for s in samples}
    by_language = {}
    for language in ("vi_vn", "en_us"):
        pool = [s for s in fleurs["samples"] if s["role"] == "test" and s["config"] == language
                and s["id"] not in used and s["duration_s"] <= 12]
        by_language[language] = rng.sample(pool, 4)
    for pair, (vi, en) in enumerate(zip(by_language["vi_vn"], by_language["en_us"])):
        for order in ((vi, en), (en, vi)):
            chunks = []
            for source in order:
                assert sha(source["path"]) == source["sha256"]
                audio, rate = sf.read(source["path"], dtype="float32")
                assert rate == 16000 and audio.ndim == 1
                chunks.append(audio)
            pcm = np.concatenate([chunks[0], np.zeros(4800, dtype="float32"), chunks[1]])
            target = derived / f"transition-{pair}-{order[0]['config']}.wav"
            sf.write(target, pcm, 16000, subtype="FLOAT")
            samples.append({"id": target.stem, "dataset": "derived_fleurs", "group": "synthetic_vi_en_transition",
                            "config": "vi_en_synthetic", "role": "test", "reference": " ".join(s["reference"] for s in order),
                            "path": str(target), "duration_s": len(pcm) / 16000, "sha256": sha(target),
                            "cluster": f"transition-pair-{pair}", "source_ids": [s["id"] for s in order],
                            "parent_sha256": [s["sha256"] for s in order]})
    rng.shuffle(samples)
    controls = json.loads((cache / "rms-fix-20261020-01/manifest.json").read_text())
    samples.extend({**s, "group": "nonspeech_control", "dataset": "synthetic_control", "cluster": s["id"]}
                   for s in controls["samples"] if s["role"] in ("silence", "control"))
    warmup = [s for s in fleurs["samples"] if s["role"] == "warmup"]
    for sample in samples + warmup:
        assert sha(sample["path"]) == sample["sha256"], sample["id"]
        info = sf.info(sample["path"])
        assert info.channels == 1 and info.samplerate == 16000 and abs(info.duration - sample["duration_s"]) < .001
    assert len(samples) == 101 and len({s["id"] for s in samples}) == 101 and len(warmup) == 4
    manifest = {"seed": SEED, "samples": samples, "warmup": warmup,
                "source_manifests": {str(p): sha(p) for p in manifests},
                "design": "Paired same-audio live then actual saved-segment refinement; fixed random clip order. No Apply. Candidate accepts every ready proposal; skips/failures retain live text. Warmup excluded.",
                "limits": "AMI is a fixed 60s excerpt (word midpoint reference), four meeting clusters with two microphone conditions. Synthetic VI/EN concatenation is not natural code switching. No hardware/UI measurement. RSS is not total GPU/unified memory."}
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    return manifest


def production_snapshot():
    meetings = get(8056, "bots")["meetings"]
    return {str(m["id"]): hashlib.sha256(json.dumps(m, sort_keys=True, ensure_ascii=False).encode()).hexdigest() for m in meetings}


def run(output: Path):
    manifest_path = output / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if (output / "pairs.jsonl").exists() or (output / "metadata.json").exists():
        raise RuntimeError("Use a new result directory; measured data is never overwritten")
    if get(8056, "health")["live_sessions"] or get(18000, "status")["queue"]["active"]:
        raise RuntimeError("User capture/ASR is active; no process was changed")
    model = listener(18000)
    if model is None or "funasr" not in " ".join(model.cmdline()):
        raise RuntimeError("Expected the existing FunASR listener")
    for sample in manifest["samples"] + manifest["warmup"]:
        assert sha(sample["path"]) == sample["sha256"]
    sources = ["deploy/transcription/benchmark/replay.mjs", "deploy/transcription/benchmark/refinement.py",
               "deploy/transcription/benchmark/metrics.py", "core/meetings/services/desktop/dist/desktop.js",
               "core/meetings/services/desktop/dist/refinement.js", "core/meetings/services/desktop/dist/transcript-journal.js",
               "core/meetings/modules/gmeet-pipeline/dist/speaker-streams.js",
               "core/meetings/modules/buffer/dist/gmeet-compatible-buffer.js", "deploy/transcription/funasr/server.py"]
    metadata = {"manifest_sha256": sha(manifest_path), "model_pid": model.pid, "model": get(18000, "status")["model"],
                "source_sha256": {p: sha(ROOT / p) for p in sources}, "production_before": production_snapshot(),
                "started_at_unix": time.time(), "available_ram_before_bytes": psutil.virtual_memory().available,
                "rss_note": "RSS incl descendants sampled every 100ms; stage start/peak, not GPU/unified-memory accounting."}
    (output / "metadata.json").write_text(json.dumps(metadata, indent=2))
    with httpx.Client(timeout=180, trust_env=False) as client, (output / "warmup.jsonl").open("x") as warm:
        for sample in manifest["warmup"]:
            result = request(client, 18000, sample, model.pid)
            warm.write(json.dumps(result, ensure_ascii=False) + "\n")
            if not result["ok"]:
                raise RuntimeError("Warmup failed; measured replay not started")
    env = os.environ.copy()
    for key in ("TINA_ADMIN_API_URL", "TINA_INTERNAL_API_SECRET", "TINA_DESKTOP_API_KEY"):
        env.pop(key, None)
    command = ["node", str(ROOT / "deploy/transcription/benchmark/replay.mjs"), str(manifest_path),
               "http://127.0.0.1:18000", str(output / "pairs.jsonl"), "--refinement"]
    process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    samplers = None
    memory = {}

    def finish_stage():
        nonlocal samplers
        if samplers:
            key, asr, node, before = samplers
            asr.__exit__(); node.__exit__()
            memory[key] = {**before, "model_peak_bytes": asr.peak, "node_peak_bytes": node.peak}
            (output / "rss.json").write_text(json.dumps(memory, indent=2))
            samplers = None

    try:
        with (output / "replay.log").open("x") as log:
            for line in process.stdout:
                log.write(line); log.flush()
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(event, dict):
                    continue
                phase, sid = event.get("phase"), event.get("id")
                if phase in ("live-start", "refinement-start"):
                    finish_stage()
                    asr, node = RssSampler(model.pid), RssSampler(process.pid)
                    before = {"model_start_bytes": asr.current(), "node_start_bytes": node.current()}
                    asr.__enter__(); node.__enter__(); samplers = (sid + ":" + phase, asr, node, before)
                elif phase in ("live-end", "refinement-end", "sample-end"):
                    finish_stage()
                if phase in ("replay", "waiting-for-user-capture"):
                    print(json.dumps(event), flush=True)
            if process.wait() != 0:
                raise RuntimeError("Replay process failed; partial rows remain explicitly incomplete")
    finally:
        finish_stage()
        if process.poll() is None:
            process.terminate(); process.wait(timeout=40)
        current_model = listener(18000)
        metadata.update(finished_at_unix=time.time(), production_after=production_snapshot(),
                        available_ram_after_bytes=psutil.virtual_memory().available,
                        same_model_process=current_model is not None and current_model.pid == model.pid)
        (output / "metadata.json").write_text(json.dumps(metadata, indent=2))


def paired_summary(rows):
    ref_words = sum(r["live_score"]["ref_words"] for r in rows)
    ref_chars = sum(r["live_score"]["ref_chars"] for r in rows)
    live_errors = sum(r["live_score"]["word_errors"] for r in rows)
    candidate_errors = sum(r["refined_score"]["word_errors"] for r in rows)
    clusters = collections.defaultdict(list)
    for r in rows:
        clusters[r.get("cluster", r["id"])].append(r)
    totals = np.array([[sum(r["refined_score"]["word_errors"] - r["live_score"]["word_errors"] for r in group),
                        sum(r["live_score"]["ref_words"] for r in group)] for group in clusters.values()])
    rng = np.random.default_rng(SEED)
    bootstrap = totals[rng.integers(0, len(totals), size=(2000, len(totals)))].sum(axis=1)
    delta_ci = np.quantile(100 * bootstrap[:, 0] / np.maximum(1, bootstrap[:, 1]), [.025, .975]).tolist()
    items = [item for r in rows for item in r.get("refinement", {}).get("items", [])]
    return {"clips": len(rows), "clusters": len(clusters), "reference_words": ref_words,
            "live_wer_pct": 100 * live_errors / max(1, ref_words),
            "candidate_wer_pct": 100 * candidate_errors / max(1, ref_words),
            "delta_wer_pp": 100 * (candidate_errors - live_errors) / max(1, ref_words),
            "delta_wer_bootstrap95_pp": delta_ci,
            "live_cer_pct": 100 * sum(r["live_score"]["char_errors"] for r in rows) / max(1, ref_chars),
            "candidate_cer_pct": 100 * sum(r["refined_score"]["char_errors"] for r in rows) / max(1, ref_chars),
            "clips_better": sum(r["refined_score"]["word_errors"] < r["live_score"]["word_errors"] for r in rows),
            "clips_worse": sum(r["refined_score"]["word_errors"] > r["live_score"]["word_errors"] for r in rows),
            "clips_equal_wer": sum(r["refined_score"]["word_errors"] == r["live_score"]["word_errors"] for r in rows),
            "normalized_text_identical": sum(normalize(r.get("text", "")) == normalize(r.get("refined_text", r.get("text", ""))) for r in rows),
            "live_failures": sum(not r["ok"] for r in rows),
            "refinement_request_failures": sum(bool(r.get("refinement_error")) for r in rows),
            "segment_states": dict(collections.Counter(item["state"] for item in items)),
            "first_text_p50_s": percentile([r.get("first_text_s") for r in rows], .5),
            "final_tail_p50_s": percentile([r.get("finalization_delay_s") for r in rows], .5),
            "refinement_p50_s": percentile([r.get("refinement_s") for r in rows], .5),
            "refinement_p95_s": percentile([r.get("refinement_s") for r in rows], .95),
            "refinement_rtf": sum(r.get("refinement_s", 0) for r in rows) / sum(r["duration_s"] for r in rows),
            "external_capture_overlap": sum(bool(r.get("external_capture_after_live")) for r in rows)}


def report(output: Path):
    manifest = json.loads((output / "manifest.json").read_text())
    rows = [json.loads(line) for line in (output / "pairs.jsonl").read_text().splitlines() if line.strip()]
    expected = {s["id"] for s in manifest["samples"]}
    if len(rows) != len(expected) or {r["id"] for r in rows} != expected:
        raise RuntimeError("Incomplete/mismatched paired data; refusing to label it a completed benchmark")
    memory = json.loads((output / "rss.json").read_text())
    for row in rows:
        row["live_score"] = score(row["reference"], row.get("text", ""))
        row["refined_score"] = score(row["reference"], row.get("refined_text", row.get("text", "")))
    summary = {group: paired_summary([r for r in rows if r["group"] == group])
               for group in sorted({r["group"] for r in rows if r["role"] == "test"})}
    controls = [r for r in rows if r["role"] != "test"]
    summary["controls"] = {"clips": len(controls), "live_nonempty": sum(bool(r.get("text", "").strip()) for r in controls),
                           "candidate_nonempty": sum(bool(r.get("refined_text", r.get("text", "")).strip()) for r in controls)}
    summary["rss_mib"] = {stage: {key.removesuffix("_bytes") + "_mib": max((v[key] for k, v in memory.items() if k.endswith(stage)), default=0) / 1024**2
                                  for key in ("model_start_bytes", "model_peak_bytes", "node_start_bytes", "node_peak_bytes")}
                          for stage in ("live-start", "refinement-start")}
    metadata = json.loads((output / "metadata.json").read_text())
    if metadata["manifest_sha256"] != sha(output / "manifest.json"):
        raise RuntimeError("Frozen manifest changed after measurement")
    summary["preservation"] = {"same_asr_process": metadata["same_model_process"],
                               "original_meetings_unchanged": all(metadata["production_after"].get(k) == v for k, v in metadata["production_before"].items()),
                               "before_count": len(metadata["production_before"]), "after_count": len(metadata["production_after"])}
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    with (output / "per-clip.csv").open("w") as f:
        fields = ["id", "group", "duration_s", "live_wer_pct", "candidate_wer_pct", "delta_wer_pp", "refinement_s", "first_text_s"]
        writer = csv.DictWriter(f, fields); writer.writeheader()
        for row in rows:
            words = max(1, row["live_score"]["ref_words"])
            writer.writerow({**{k: row.get(k) for k in fields if k in row},
                             "live_wer_pct": 100 * row["live_score"]["word_errors"] / words,
                             "candidate_wer_pct": 100 * row["refined_score"]["word_errors"] / words,
                             "delta_wer_pp": 100 * (row["refined_score"]["word_errors"] - row["live_score"]["word_errors"]) / words})
    table = ["| Nhóm | Clip | Live WER % | Đề xuất WER % | Δ điểm % | Live CER % | Đề xuất CER % | Refinement p50 / p95 s |",
             "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for group in sorted({r["group"] for r in rows if r["role"] == "test"}):
        s = summary[group]
        table.append(f"| {group} | {s['clips']} | {s['live_wer_pct']:.2f} | {s['candidate_wer_pct']:.2f} | {s['delta_wer_pp']:+.2f} | {s['live_cer_pct']:.2f} | {s['candidate_cer_pct']:.2f} | {s['refinement_p50_s']:.2f} / {s['refinement_p95_s']:.2f} |")
    text = "# TINA — benchmark live so với refinement\n\n" + "\n".join(table)
    text += "\n\nΔ âm là tốt hơn. Đề xuất là giả lập chấp nhận mọi proposal ready; skipped/failed giữ nguyên live. Không Apply vào transcript thực. Hai nhánh dùng cùng audio và model; live luôn chạy trước vì refinement phụ thuộc segment live, nên thời gian không phải A/B độc lập.\n"
    text += "\nWER tiếng Việt theo token cách nhau bằng khoảng trắng; CER giữ dấu, bỏ khoảng trắng; cùng NFC/casefold và chuẩn hóa dấu câu. Lỗi không có output được chấm hypothesis rỗng; partial transcript nếu có vẫn được chấm đầy đủ, không bỏ khỏi mẫu. Refinement chỉ sửa segment đã phát hiện; không cứu được lời nói chưa có segment.\n"
    text += "\nĐây là pilot trên mẫu cố định, không phải điểm chính thức toàn dataset. AMI gồm 4 meeting với 2 điều kiện mic, reference sắp theo thời gian kể cả overlap; không phải diarization score. Mẫu ghép VI–EN không phải code-switching tự nhiên. Bootstrap trong summary.json lấy theo cặp/cluster, không phải CI cho quần thể người nói.\n"
    text += "\nRSS lấy mẫu 100 ms gồm process và descendants; không phải toàn bộ Apple GPU/unified memory. Xem rss_mib trong summary.json. Latency là replay số, không gồm microphone, system capture hay UI paint.\n"
    text += "\n## So sánh từng cặp\n\n| Nhóm | Tốt hơn / WER bằng nhau / Tệ hơn | Bootstrap 95% của Δ WER (điểm %) |\n|---|---:|---:|\n"
    for group in summary:
        s = summary[group]
        if "delta_wer_pp" in s:
            lo, hi = s["delta_wer_bootstrap95_pp"]
            text += f"| {group} | {s['clips_better']} / {s['clips_equal_wer']} / {s['clips_worse']} | [{lo:.2f}, {hi:.2f}] |\n"
    speech = [r for r in rows if r["role"] == "test"]
    text += f"\n## Thời gian và RAM\n\nTrên {len(speech)} clip có lời nói: first text p50 **{percentile([r.get('first_text_s') for r in speech], .5):.2f} s**; live finalization tail p50 **{percentile([r.get('finalization_delay_s') for r in speech], .5):.2f} s**. Refinement là phần chạy thêm sau phiên: p50 **{percentile([r.get('refinement_s') for r in speech], .5):.2f} s**, p95 **{percentile([r.get('refinement_s') for r in speech], .95):.2f} s**; không phải thời gian cho một cuộc họp dài bất kỳ.\n"
    text += "\n| Giai đoạn | Peak RSS model MiB | Peak RSS Desktop MiB |\n|---|---:|---:|\n"
    for stage, rss in summary["rss_mib"].items():
        text += f"| {stage} | {rss['model_peak_mib']:.2f} | {rss['node_peak_mib']:.2f} |\n"
    text += "\nĐây là các peak quan sát theo giai đoạn, không phải ước lượng RAM tăng thêm do refinement. Không đo đầy đủ Metal/GPU memory.\n"
    states = collections.Counter(i["state"] for r in rows for i in r.get("refinement", {}).get("items", []))
    text += f"\n## Độ bao phủ và bảo toàn\n\nSegment states: `{dict(states)}`. Nonspeech controls: `{summary['controls']}`. Bảo toàn: `{summary['preservation']}`.\n"
    text += "\n## Nguồn phương pháp\n\nThiết kế cặp, đóng băng mẫu và giữ các điều kiện cùng meeting trong cluster có tham khảo skill experimental-design thuộc Scientific Agent Skills: Kassis, T., Agarwal, V., He, Y., Patel, D., & Brueckner, A. M. (2026). [Scientific Agent Skills: A Library of Procedural Knowledge for Research Agents](https://doi.org/10.48550/arXiv.2609.00065). Bài mô tả thư viện, không xác nhận chất lượng ASR hay kết quả benchmark này.\n"
    (output / "REPORT.md").write_text(text)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    action, *args = sys.argv[1:]
    if action == "prepare":
        cache, output = (Path(p).expanduser().resolve() for p in args)
        output.mkdir(parents=True, exist_ok=True)
        prepare(cache, output)
    elif action in ("run", "report"):
        {"run": run, "report": report}[action](Path(args[0]).expanduser().resolve())
    else:
        raise SystemExit("Usage: refinement.py prepare CACHE OUTPUT | run OUTPUT | report OUTPUT")
