"""Metadata-only revision notifications. The canonical snapshot remains the source of text."""
from __future__ import annotations

import asyncio
import json
from uuid import uuid4


def enqueue_revision(data: dict, *, meeting_id: int, platform: str, native_id: str, segment_id: str, revision: dict) -> dict:
    sequences = data.setdefault("transcript_revision_sequences", {})
    previous_text = ((data.get("transcript_edits") or {}).get(segment_id, {}).get("history") or [])
    text_revision = int(previous_text[-1].get("revision", 0)) if previous_text else 0
    next_revision = (max(int(sequences.get(segment_id, 0)) + 1, text_revision + 1)
                     if revision.get("kind") == "alignment"
                     else max(int(sequences.get(segment_id, 0)) + 1, int(revision.get("revision", 0))))
    sequences[segment_id] = next_revision
    event = {"version": "transcript-revision.v1", "type": "transcript.revised", "event_id": str(uuid4()),
             "meeting_id": meeting_id, "platform": platform, "native_meeting_id": native_id,
             "segment_id": segment_id, "revision": next_revision, "kind": revision["kind"], "at": revision["at"]}
    data["transcript_outbox"] = [*(data.get("transcript_outbox") or []), event]
    return event


async def dispatch_revisions(store, redis, limit=50) -> int:
    """Publish before exact-ID acknowledgement; a crash can duplicate, never discard, a notification."""
    delivered = 0
    for row in await store.pending_revisions(limit):
        event = row["event"]
        if event['type'] in ('meeting.notes.updated', 'meeting.memory.updated') and hasattr(store, 'processed_notes'):
            state = await store.processed_notes(row['user_id'], event['meeting_id'])
            if state is not None and state.get('enabled'):
                await redis.set(f'canonical:meeting:{event["meeting_id"]}:on', '1', ex=86400)
            else:
                await redis.delete(f'canonical:meeting:{event["meeting_id"]}:on')
            from .processed_notes import publish_projection
            await publish_projection(redis, state, event)
        body = json.dumps(event, ensure_ascii=False)
        await asyncio.wait_for(redis.publish(f'u:{row["user_id"]}:meetings', body), timeout=5)
        await asyncio.wait_for(redis.publish(f'tc:meeting:{event["meeting_id"]}:mutable', body), timeout=5)
        await store.ack_revision(row["user_id"], event["meeting_id"], event["event_id"])
        delivered += 1
    return delivered
