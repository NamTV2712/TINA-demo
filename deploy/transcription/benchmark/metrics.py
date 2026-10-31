"""Explicit accent-preserving scoring shared by direct and digital-replay evaluation."""
import math
import unicodedata

import jiwer


def normalize(text):
    text = unicodedata.normalize("NFC", text).casefold().replace("’", "'")
    characters = []
    for i, char in enumerate(text):
        apostrophe = char == "'" and i > 0 and i + 1 < len(text) and text[i - 1].isalpha() and text[i + 1].isalpha()
        characters.append(char if apostrophe or unicodedata.category(char)[0] not in "PS" else " ")
    return " ".join("".join(characters).split())


def score(reference, hypothesis):
    ref, hyp = normalize(reference), normalize(hypothesis)
    words = jiwer.process_words(ref, hyp)
    chars = jiwer.process_characters(ref.replace(" ", ""), hyp.replace(" ", ""))
    return {"ref_words": words.hits + words.substitutions + words.deletions,
            "word_errors": words.substitutions + words.deletions + words.insertions,
            "substitutions": words.substitutions, "deletions": words.deletions, "insertions": words.insertions,
            "ref_chars": chars.hits + chars.substitutions + chars.deletions,
            "char_errors": chars.substitutions + chars.deletions + chars.insertions,
            "normalized_reference": ref, "normalized_hypothesis": hyp}


def percentile(values, fraction):
    values = sorted(v for v in values if v is not None and math.isfinite(v))
    return values[max(0, math.ceil(len(values) * fraction) - 1)] if values else None


def summarize(rows):
    words = sum(row["score"]["ref_words"] for row in rows)
    chars = sum(row["score"]["ref_chars"] for row in rows)
    audio = sum(row["duration_s"] for row in rows)
    return {"clips": len(rows), "failures": sum(not row["ok"] for row in rows),
            "wer": sum(row["score"]["word_errors"] for row in rows) / words if words else None,
            "cer": sum(row["score"]["char_errors"] for row in rows) / chars if chars else None,
            "reference_words": words, "reference_characters": chars, "audio_seconds": audio,
            "latency_p50_s": percentile([r["latency_s"] for r in rows], .50),
            "latency_p95_s": percentile([r["latency_s"] for r in rows], .95),
            "rtf_aggregate": sum(r["latency_s"] for r in rows) / audio if audio else None,
            "peak_sampled_rss_mib": max((r.get("peak_rss_bytes", 0) for r in rows), default=0) / 1024**2}
