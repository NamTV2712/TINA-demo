"""Owner-triggered word alignment over saved bot audio; raw ASR and audio remain immutable."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import io
import json
import logging
import math
import os
import re
import tempfile
import wave
from contextlib import AsyncExitStack
from datetime import datetime, timezone
from uuid import uuid4, uuid5, NAMESPACE_URL

import httpx
from .diarization import word_attribution
from .refinement import ACTIVE, TERMINAL
from .speakers import has_source_assignment
from .transcript_document import CorrectionConflict

logger = logging.getLogger(__name__)


def _tokens(text: str) -> list[str]:
    return re.findall(r"\S+", text.strip()) if text.strip() else []


def _duration_ms(audio: bytes) -> float:
    with wave.open(io.BytesIO(audio), "rb") as wav:
        if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (16000, 1, 2):
            raise ValueError("Alignment audio must be mono 16 kHz PCM16 WAV")
        return wav.getnframes() * 1000 / 16000


def validate_result(result: dict, audio: bytes, text: str) -> dict:
    """Validate worker output at the trust boundary and keep every raw token exactly once."""
    duration = _duration_ms(audio)
    expected = _tokens(text)
    if (not isinstance(result, dict)
            or result.get("audio_sha256") != hashlib.sha256(audio).hexdigest()
            or result.get("text_sha256") != hashlib.sha256(text.encode("utf-8")).hexdigest()):
        raise ValueError("Alignment worker returned a different source")
    model, words = result.get("model"), result.get("words")
    if not isinstance(model, str) or not model or len(model) > 256 or not isinstance(words, list) or len(words) != len(expected):
        raise ValueError("Invalid alignment result")
    clean = []
    previous_start = previous_end = -1.0
    for index, (word, raw) in enumerate(zip(words, expected)):
        if not isinstance(word, dict) or word.get("index") != index or word.get("text") != raw or type(word.get("aligned")) is not bool:
            raise ValueError("Alignment must preserve every source token in order")
        start, end = word.get("start_ms"), word.get("end_ms")
        if word["aligned"]:
            if (type(start) not in (int, float) or type(end) not in (int, float)
                    or not math.isfinite(start) or not math.isfinite(end)
                    or not (0 <= start < end <= duration + 1)
                    or start < previous_start or end < previous_end):
                raise ValueError("Invalid word time")
            previous_start, previous_end = start, end
            clean.append({"index": index, "text": raw, "start_ms": round(start, 2),
                          "end_ms": round(end, 2), "aligned": True})
        else:
            if start is not None or end is not None:
                raise ValueError("Unaligned words cannot claim timestamps")
            clean.append({"index": index, "text": raw, "start_ms": None,
                          "end_ms": None, "aligned": False})
    return {"model": model, "duration_ms": duration,
            "audio_sha256": result["audio_sha256"],
            "text_sha256": result["text_sha256"], "words": clean}


def attribute_alignment(mid, doc, live_segments, speaker_entries, diarization, job):
    """Shared owner-review/canonical attribution over one caller-provided snapshot."""
    review_segments = {s["segment_id"]: s for s in doc.get("segments", [])}
    if not diarization or diarization.get("status") != "completed" or not diarization.get("applied_at"):
        diarization = None
    recordings = {r["recording_id"]: r for r in (diarization or {}).get("recordings", [])}
    recording_keys = {i["segment_id"]: i.get("recording_key") for i in (diarization or {}).get("items", [])}
    for item in job.get("items", []):
        item["phrases"] = []
        segment = review_segments.get(item.get("segment_id"))
        live = live_segments.get(item.get("segment_id"), {})
        if not segment or item.get("state") != "aligned":
            continue
        if hashlib.sha256(segment["raw_text"].encode("utf-8")).hexdigest() != item.get("text_sha256"):
            item["state"] = "stale"
            item["reason"] = "Raw transcript changed; rerun alignment."
            continue
        spans = segment.get("audio") or []
        if len(spans) != 1 or spans[0].get("recording_id") != item.get("recording_id") or abs(spans[0]["start_ms"] - item.get("recording_start_ms", -1)) > 1 or abs(spans[0]["end_ms"] - item.get("recording_end_ms", -1)) > 1:
            item["state"] = "stale"
            item["reason"] = "Source recording changed; rerun alignment."
            continue
        segment_id = item["segment_id"]
        assigned_id = live.get("speaker_id")
        assigned = speaker_entries.get(assigned_id)
        fixed_assignment = has_source_assignment(assigned)
        offset = recordings.get(item.get("recording_id"), {}).get("offset_ms")
        key = recording_keys.get(segment_id)
        relevant = [t for t in (diarization or {}).get("turns", []) if offset is not None and t["start_ms"] < offset + spans[0]["end_ms"] and t["end_ms"] > offset + spans[0]["start_ms"]]
        for word in item.get("words", []):
            speaker_id = None
            source = "unknown"
            cluster = None
            if fixed_assignment:
                speaker_id = assigned_id
                source = "confirmed"
            elif diarization and offset is not None and key and word["aligned"]:
                cluster = word_attribution(offset + spans[0]["start_ms"] + word["start_ms"],
                                           offset + spans[0]["start_ms"] + word["end_ms"], relevant)
                if cluster is not None:
                    candidate = str(uuid5(NAMESPACE_URL, f"tina:meeting:{mid}:diarization:{key}:{cluster}"))
                    if candidate in speaker_entries:
                        speaker_id = candidate
                        source = "diarization"
            entry = speaker_entries.get(speaker_id)
            fallback_name = f"Speaker {cluster + 1}" if source == "diarization" and cluster is not None else "Unknown speaker"
            word.update(speaker_id=speaker_id,
                        speaker_name=(entry.get("name") or ("Unknown speaker" if entry.get("manual") else entry.get("candidate_name") or fallback_name)) if entry else fallback_name,
                        speaker_source=source)
        item["phrases"] = _phrases(item.get("words", []))


class BotAligner:
    def __init__(self, store, refiner):
        self.store, self.refiner = store, refiner
        self.active = None
        self.task = None
        self.lock = refiner.lock
        self.url = os.getenv("ALIGNMENT_SERVICE_URL", "").strip()
        self.token = os.getenv("ALIGNMENT_SERVICE_TOKEN", "")

    async def current(self, user, mid):
        if self.active and self.active[:2] == (user, mid):
            job = copy.deepcopy(self.active[2])
        else:
            job = await self.store.get_alignment(user, mid)
            if job and job["status"] in ACTIVE:
                job.update(status="interrupted", error="Worker restarted; run alignment again for unfinished segments.")
                await self.store.save_alignment(user, mid, job)
        if job and job.get("status") == "completed" and any(i.get("state") == "aligned" for i in job.get("items", [])):
            await self._attribute(user, mid, job)
        return {"version": "transcript-alignment.v1", "available": bool(self.url and self.token), "job": job}

    async def _attribute(self, user, mid, job):
        doc = await self.store.get_transcript_document(user, mid)
        if not doc:
            return
        transcript = await self.store.get_transcript_by_id(user, mid)
        live_segments = {s["segment_id"]: s for s in (transcript or {}).get("segments", [])}
        speakers = await self.store.get_speakers(user, mid) or {}
        speaker_entries = {s["speaker_id"]: s for s in speakers.get("speakers", [])}
        diarization = await self.store.get_diarization(user, mid)
        attribute_alignment(mid, doc, live_segments, speaker_entries, diarization, job)

    async def start(self, user, mid):
        if not self.url or not self.token:
            raise ValueError("Configure the self-hosted Vietnamese alignment worker first")
        async with self.lock:
            if (self.active or self.refiner.active or getattr(getattr(self, "diarizer", None), "active", None)
                    or await self.store.refinement_live()):
                raise CorrectionConflict("Wait for live meetings and current audio processing to stop")
            doc = await self.store.get_transcript_document(user, mid)
            if not doc or doc["status"] not in TERMINAL:
                raise CorrectionConflict("Stop the meeting before word alignment")
            if not doc["segments"] or len(doc["segments"]) > 2000:
                raise ValueError("Word alignment requires 1–2000 transcript segments")
            transcript = await self.store.get_transcript_by_id(user, mid)
            live_segments = {s["segment_id"]: s for s in (transcript or {}).get("segments", [])}
            items = []
            total_tokens = 0
            for segment in doc["segments"]:
                spans = segment.get("audio") or []
                text = segment.get("raw_text", "")
                duration = spans[0]["end_ms"] - spans[0]["start_ms"] if len(spans) == 1 else 0
                if not text.strip() or not 0 < duration <= 30_000 or len(text) > 10000:
                    continue
                token_count = len(_tokens(text))
                if token_count > 2000:
                    raise ValueError("A transcript segment is limited to 2000 alignment tokens")
                total_tokens += token_count
                items.append({"segment_id": segment["segment_id"], "state": "pending",
                              "expected_revision": segment["revision"],
                              "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                              "recording_id": spans[0]["recording_id"],
                              "recording_start_ms": spans[0]["start_ms"],
                              "recording_end_ms": spans[0]["end_ms"],
                              "speaker_id": live_segments.get(segment["segment_id"], {}).get("speaker_id")})
            if not items:
                raise ValueError("No unambiguous saved audio segments of 30 seconds or less")
            if total_tokens > 20000:
                raise ValueError("Word alignment is limited to 20000 source tokens per meeting")
            await self.current(user, mid)
            previous = await self.store.get_alignment(user, mid)
            if previous and previous.get("status") in ACTIVE:
                raise CorrectionConflict("An alignment job is already running")
            job = {"version": "transcript-alignment.v1", "id": str(uuid4()), "status": "running",
                   "backend": "mfa", "model": "vietnamese_mfa", "created_at": _now(),
                   "items": items}
            previous_job = await self.store.get_alignment(user, mid)
            await self.store.save_alignment(user, mid, job, expected_job_id=previous_job["id"] if previous_job else None)
            self.active = (user, mid, job)
            self.task = asyncio.create_task(self.run(user, mid, doc, job))
            return {"version": "transcript-alignment.v1", "available": True, "job": copy.deepcopy(job)}

    async def run(self, user, mid, doc, job):
        try:
            segments = {s["segment_id"]: s for s in doc["segments"]}
            async with AsyncExitStack() as stack:
                directory = stack.enter_context(tempfile.TemporaryDirectory(prefix="tina-alignment-job-"))
                client = await stack.enter_async_context(httpx.AsyncClient(timeout=600, follow_redirects=False))
                cache = {"directory": directory}
                total_audio_ms = 0.0
                failed_items = 0
                for offset in range(0, len(job["items"]), 20):
                    while await self.store.refinement_live() and job["status"] != "cancelling":
                        job["status"] = "paused"
                        await self.store.save_alignment(user, mid, job)
                        await asyncio.sleep(.5)
                    if job["status"] == "cancelling":
                        break
                    job["status"] = "running"
                    batch = []
                    for item in job["items"][offset:offset + 20]:
                        if job["status"] == "cancelling":
                            break
                        try:
                            audio = await self.refiner.clip(user, mid, item["segment_id"], cache)
                            if job["status"] == "cancelling":
                                break
                            text = segments[item["segment_id"]]["raw_text"]
                            duration_ms = _duration_ms(audio)
                            if total_audio_ms + duration_ms > 30 * 60 * 1000:
                                raise ValueError("Alignment job audio limit reached")
                            total_audio_ms += duration_ms
                            batch.append((item, audio, text))
                        except (ValueError, KeyError, StopIteration):
                            item.update(state="skipped", reason="Audio is missing, ambiguous, too long or outside the alignment job limit.")
                    if job["status"] == "cancelling":
                        break
                    if batch:
                        try:
                            response = await client.post(self.url.rstrip("/") + "/align-batch",
                                headers={"Authorization": "Bearer " + self.token},
                                data={"texts": json.dumps([text for _, _, text in batch], ensure_ascii=False)},
                                files=[("files", (f"segment-{i}.wav", audio, "audio/wav")) for i, (_, audio, _) in enumerate(batch)])
                            response.raise_for_status()
                            results = response.json().get("results")
                            if not isinstance(results, list) or len(results) != len(batch):
                                raise ValueError("Invalid alignment batch")
                            clean_results = [validate_result(result, audio, text)
                                             for (_, audio, text), result in zip(batch, results)]
                            for (item, _, _), clean in zip(batch, clean_results):
                                item.update(state="aligned", model=clean["model"], audio_sha256=clean["audio_sha256"],
                                            text_sha256=clean["text_sha256"], duration_ms=clean["duration_ms"], words=clean["words"])
                                job["model"] = clean["model"]
                        except (httpx.HTTPError, ValueError, KeyError):
                            failed_items += len(batch)
                            for item, _, _ in batch:
                                item.update(state="skipped", reason="Alignment worker failed; raw ASR is unchanged.")
                    await self.store.save_alignment(user, mid, job)
            if failed_items:
                job["error"] = f"Alignment worker failed for {failed_items} segment(s); rerun alignment to retry."
            if job["status"] != "cancelling":
                aligned = any(item.get("state") == "aligned" for item in job["items"])
                job.update(status="completed" if aligned else "failed", finished_at=_now())
                if not aligned and not job.get("error"):
                    job["error"] = "No segments could be aligned; check saved audio coverage and limits."
            else:
                job.update(status="cancelled", finished_at=_now())
        except asyncio.CancelledError:
            job.update(status="interrupted", error="Worker stopped before alignment completed.")
        except Exception as exc:
            logger.exception("Word alignment job failed: meeting_id=%s job_id=%s", mid, job["id"])
            job.update(status="failed", error=f"Word alignment failed ({type(exc).__name__}); raw ASR and recordings are unchanged.")
        finally:
            try:
                await self.store.save_alignment(user, mid, job)
            finally:
                self.active = None

    async def cancel(self, user, mid):
        if self.active and self.active[:2] == (user, mid):
            self.active[2]["status"] = "cancelling"
            await self.store.save_alignment(user, mid, self.active[2])
        return await self.current(user, mid)

    async def audio(self, user, mid, segment_id):
        job = await self.store.get_alignment(user, mid)
        item = next((i for i in (job or {}).get("items", []) if i["segment_id"] == segment_id and i.get("state") == "aligned"), None)
        if item is None:
            raise ValueError("No aligned audio is available for this segment")
        doc = await self.store.get_transcript_document(user, mid)
        segment = next((s for s in (doc or {}).get("segments", []) if s["segment_id"] == segment_id), None)
        spans = (segment or {}).get("audio") or []
        if (not segment or hashlib.sha256(segment["raw_text"].encode("utf-8")).hexdigest() != item.get("text_sha256")
                or len(spans) != 1 or spans[0].get("recording_id") != item.get("recording_id")
                or abs(spans[0]["start_ms"] - item.get("recording_start_ms", -1)) > 1
                or abs(spans[0]["end_ms"] - item.get("recording_end_ms", -1)) > 1):
            raise CorrectionConflict("Transcript or source span changed; rerun alignment before word playback")
        audio = await self.refiner.clip(user, mid, segment_id)
        if hashlib.sha256(audio).hexdigest() != item.get("audio_sha256"):
            raise CorrectionConflict("Source audio changed; rerun alignment before word playback")
        return audio


def _now():
    return datetime.now(timezone.utc).isoformat()


def _phrases(words):
    groups = []
    for word in words:
        key = word.get("speaker_id")
        if not groups or groups[-1]["speaker_id"] != key:
            groups.append({"speaker_id": key, "speaker_name": word.get("speaker_name", "Unknown speaker"),
                           "text": word.get("text", ""), "start_ms": word.get("start_ms"),
                           "end_ms": word.get("end_ms"), "word_indices": [word["index"]]})
        else:
            group = groups[-1]
            group["text"] += " " + word.get("text", "")
            group["word_indices"].append(word["index"])
            if word.get("start_ms") is not None:
                group["start_ms"] = word["start_ms"] if group["start_ms"] is None else min(group["start_ms"], word["start_ms"])
                group["end_ms"] = word["end_ms"] if group["end_ms"] is None else max(group["end_ms"], word["end_ms"])
    return groups
