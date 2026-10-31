"""Meeting-local speaker identities. Platform IDs bind voices; names alone never merge people."""
from __future__ import annotations

import copy
import re
from datetime import datetime, timezone
from uuid import NAMESPACE_URL, uuid4, uuid5

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator

from .transcript_document import CorrectionConflict, normalize


class SpeakerUpdate(BaseModel):
    expected_revision: StrictInt = Field(ge=1)
    name: str | None = Field(max_length=120)
    model_config = ConfigDict(extra="forbid")

    @field_validator("name")
    @classmethod
    def valid_name(cls, value):
        if value is None:
            return None
        if any(ord(c) < 32 for c in value):
            raise ValueError("Enter a name or choose unknown")
        value = normalize(value)
        if not value:
            raise ValueError("Enter a name or choose unknown")
        return value


def _now():
    return datetime.now(timezone.utc).isoformat()


def _registry(data):
    return copy.deepcopy(data.get("speaker_registry") or {"version": "speaker-registry.v1", "speakers": {}, "bindings": {}, "segments": {}})


def has_source_assignment(entry):
    if not entry:
        return False
    if entry.get("participant_id"):
        return True
    # Naming an acoustic voice does not assign the whole segment to that voice.
    if any(h.get("recording_key") for h in entry.get("history", [])):
        return False
    return bool(entry.get("manual") or entry.get("status") in ("confirmed", "observed"))


def _record(entry, *, name, status, source, actor=None):
    history = entry.setdefault("history", [])
    if len(history) >= 100:
        raise CorrectionConflict("Speaker history limit reached")
    entry.update(name=name, status=status, source=source, revision=entry.get("revision", 0) + 1)
    history.append({"revision": entry["revision"], "name": name, "status": status, "source": source, "participant_id": entry.get("participant_id"), "actor_id": actor, "at": _now()})


def _event(data, meeting, entry):
    event = {"version": "speaker-revision.v1", "type": "speaker.revised", "event_id": str(uuid4()),
             "meeting_id": meeting["id"], "platform": meeting["platform"], "native_meeting_id": meeting.get("native_meeting_id"),
             "speaker_id": entry["speaker_id"], "revision": entry["revision"], "kind": "speaker", "at": _now()}
    data["transcript_outbox"] = [*(data.get("transcript_outbox") or []), event]


def observe(data: dict, meeting: dict, segments: list[dict]) -> bool:
    registry = _registry(data)
    changed = False
    for segment in segments:
        sid = segment.get("segment_id")
        if not sid or segment.get("source") == "chat":
            continue
        participant = segment.get("participant_id")
        trusted = meeting["platform"] == "google_meet" and segment.get("source") == "glow-bound" and isinstance(participant, str) and 0 < len(participant) <= 512
        participant_key = "meet:" + participant if trusted else None
        source_key = str(segment.get("speaker_key") or str(sid).rsplit(":", 1)[0])
        binding = f'{segment.get("session_uid") or "legacy"}:{source_key}'
        speaker_id = registry["segments"].get(sid) or registry["bindings"].get(binding) or (registry["bindings"].get(participant_key) if participant_key else None)
        speaker_id = speaker_id or str(uuid5(NAMESPACE_URL, f'tina:meeting:{meeting["id"]}:{participant_key or binding}'))
        raw_name = normalize(str(segment.get("raw_speaker", segment.get("speaker")) or ""))[:120]
        candidate = raw_name if raw_name and not re.fullmatch(r"(?i)(speaker(?: [a-z0-9]+)?|unknown|ch-\d+)", raw_name) else None
        entry = registry["speakers"].get(speaker_id)
        if entry is None:
            entry = {"speaker_id": speaker_id, "candidate_name": candidate, "participant_id": participant if trusted else None, "manual": False, "history": []}
            _record(entry, name=candidate if trusted else None, status="observed" if trusted and candidate else "unknown", source="meet_dom" if trusted else "unattributed")
            registry["speakers"][speaker_id] = entry
            _event(data, meeting, entry)
            changed = True
        elif trusted and not entry["manual"] and (entry.get("participant_id") != participant or entry.get("candidate_name") != candidate) and len(entry["history"]) < 100:
            entry.update(participant_id=participant, candidate_name=candidate)
            _record(entry, name=candidate, status="observed" if candidate else "unknown", source="meet_dom")
            _event(data, meeting, entry)
            changed = True
        for key in [binding, participant_key]:
            if key and key not in registry["bindings"]:
                registry["bindings"][key] = speaker_id
                changed = True
        if registry["segments"].get(sid) != speaker_id:
            registry["segments"][sid] = speaker_id
            changed = True
        segment.update(raw_speaker=segment.get("raw_speaker", segment.get("speaker")), speaker=entry["name"] or "Unknown speaker",
                       speaker_id=speaker_id, speaker_revision=entry["revision"], speaker_status=entry["status"])
    if changed:
        data["speaker_registry"] = registry
    return changed


def update(data, meeting, speaker_id, command: SpeakerUpdate, actor):
    registry = _registry(data)
    entry = registry["speakers"].get(speaker_id)
    if entry is None:
        raise KeyError(speaker_id)
    if entry["revision"] != command.expected_revision:
        raise CorrectionConflict("Speaker changed; reload before saving")
    entry["manual"] = True
    _record(entry, name=command.name, status="confirmed" if command.name else "unknown", source="manual", actor=actor)
    data["speaker_registry"] = registry
    _event(data, meeting, entry)


def view(data, meeting_id):
    registry = _registry(data)
    counts = {}
    for speaker_id in registry["segments"].values():
        counts[speaker_id] = counts.get(speaker_id, 0) + 1
    job = data.get("transcript_diarization") or {}
    return {"version": "speaker-registry.v1", "meeting_id": meeting_id,
            "speakers": [{**entry, "segment_count": counts.get(sid, 0)} for sid, entry in registry["speakers"].items()
                         if sid in counts or (job.get("applied_at") and any(h.get("job_id") == job.get("id") for h in entry.get("history", [])))]}


def overlay(segments, data):
    registry = _registry(data)
    result = []
    for segment in segments:
        entry = registry["speakers"].get(registry["segments"].get(segment.get("segment_id")))
        result.append({**segment, **({"speaker": entry["name"] or "Unknown speaker", "speaker_id": entry["speaker_id"], "speaker_revision": entry["revision"], "speaker_status": entry["status"]} if entry else {})})
    return result
