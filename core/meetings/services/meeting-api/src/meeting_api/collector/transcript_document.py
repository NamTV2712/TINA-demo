"""Owner review data. Corrections are an overlay; the collector's ASR rows stay untouched."""
from __future__ import annotations

import unicodedata
from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, StrictInt


class Correction(BaseModel):
    expected_revision: StrictInt = Field(ge=0)
    text: Optional[str] = Field(max_length=10000)
    model_config = ConfigDict(extra="forbid")


class CorrectionConflict(ValueError):
    pass


def normalize(text: str) -> str:
    return " ".join(unicodedata.normalize("NFC", text).split())


def corrected(records: dict, segment_id: str, raw: str, update: Correction, actor: int, provenance: dict | None = None) -> dict:
    previous = records.get(segment_id) or {"raw_text": raw, "history": []}
    history = list(previous["history"])
    if len(history) != update.expected_revision:
        raise CorrectionConflict("Transcript changed; reload before saving")
    text = previous["raw_text"] if update.text is None else normalize(update.text)
    if update.text is not None and (not text or len(text) > 10000):
        raise ValueError("Transcript must contain 1–10000 characters")
    if len(history) >= 100:
        raise CorrectionConflict("Segment revision limit reached")
    history.append({"revision": len(history) + 1, "text": text,
                    "kind": "restore" if update.text is None else "manual", **(provenance or {}),
                    "at": datetime.now(timezone.utc).isoformat(), "actor_id": actor})
    return {"raw_text": previous["raw_text"], "history": history}


def canonical(raw: str, record: dict | None = None) -> dict:
    record = record or {}
    history = record.get("history") or []
    return {"raw_text": record.get("raw_text", raw), "text": history[-1]["text"] if history else raw,
            "revision": len(history)}


def overlay(segments: list[dict], records: dict) -> list[dict]:
    return [{**segment, **{k: v for k, v in canonical(segment.get("text", ""), records.get(segment.get("segment_id"))).items() if k != "raw_text"}}
            for segment in segments]


def document(doc: dict, records: dict, sessions: dict | None = None) -> dict:
    segments = []
    for segment in doc.get("segments", []):
        sid = segment.get("segment_id")
        if not sid:
            continue
        record = records.get(sid) or {}
        history = record.get("history") or []
        segments.append({"segment_id": sid, "speaker": segment.get("speaker") or "",
                         "start_ms": float(segment.get("start", segment.get("start_time", 0))) * 1000,
                         "end_ms": float(segment.get("end", segment.get("end_time", 0))) * 1000,
                         **canonical(segment.get("text", ""), record),
                         "normalized_text": normalize(record.get("raw_text", segment.get("text", ""))),
                         "history": history, "audio": recording_spans(segment, doc.get("recordings") or [], (sessions or {}).get(sid))})
    # A mixed recording is available for listening; no word/channel alignment is asserted here.
    recordings = [{"recording_id": r["id"], "playback_url": (r.get("playback_url") or {}).get("audio") if isinstance(r.get("playback_url"), dict) else r.get("playback_url"),
                   "session_id": r.get("session_uid"), "status": r.get("status")}
                  for r in (doc.get("recordings") or []) if isinstance(r, dict) and r.get("id")]
    return {"version": "transcript-document.v1", "meeting_id": doc["id"], "status": doc.get("status", "unknown"),
            "archive_error": None, "segments": segments, "recordings": recordings}


def recording_spans(segment: dict, recordings: list, session: str | None) -> list:
    """Map the producer clock to an explicitly anchored recording; never guess legacy origins."""
    import math
    try:
        start, end = float(segment.get("start", 0)), float(segment.get("end", 0))
    except (TypeError, ValueError):
        return []
    if not all(math.isfinite(x) for x in (start, end)) or end <= start:
        return []
    spans = []
    for recording in recordings:
        origin = recording.get("audio_start_ms")
        if recording.get("status") != "completed" or not isinstance(origin, (int, float)) or not math.isfinite(origin):
            continue
        if session and recording.get("session_uid") != session:
            continue
        # Current bot segments use epoch seconds. Relative legacy clocks lack a verified anchor.
        if start < 1e9:
            continue
        left, right = start * 1000 - origin, end * 1000 - origin
        if left < 0 or right <= left:
            continue
        if not any(m.get("type") == "audio" for m in recording.get("media_files", [])):
            continue
        spans.append({"kind": "recording-span", "recording_id": recording["id"],
                      "session_id": recording.get("session_uid"), "start_ms": left, "end_ms": right})
    return spans
