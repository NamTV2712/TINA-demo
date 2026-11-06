"""Ephemeral speech.v1 playback receipts; Redis CAS keeps terminal states immutable."""
import hashlib
import json

from redis.exceptions import WatchError

TERMINAL = {"completed", "failed", "stopped"}


class SpeechConflict(Exception):
    pass


class PlaybackStore:
    def __init__(self, redis):
        self.redis = redis

    @staticmethod
    def key(meeting_id, command_id):
        return f"speech:playback:{meeting_id}:{command_id}"

    async def get(self, meeting_id, command_id):
        value = await self.redis.get(self.key(meeting_id, command_id))
        return json.loads(value) if value else None

    async def update(self, meeting_id, command_id, change, *, receipt=False):
        key, active_key = self.key(meeting_id, command_id), f"speech:active:{meeting_id}"
        for _ in range(4):
            try:
                async with self.redis.pipeline(transaction=True) as pipe:
                    await pipe.watch(key, active_key)
                    raw, active = await pipe.get(key), await pipe.get(active_key)
                    active = active.decode() if isinstance(active, bytes) else active
                    current = json.loads(raw) if raw else None
                    result, write = change(current, active)
                    if not write:
                        return (result, False) if receipt else result
                    pipe.multi()
                    pipe.set(key, json.dumps(result), ex=600)
                    if result["state"] not in TERMINAL:
                        pipe.set(active_key, command_id, ex=200)
                    elif active == command_id:
                        pipe.delete(active_key)
                    await pipe.execute()
                    return (result, True) if receipt else result
            except WatchError:
                continue
        raise SpeechConflict("Speech state changed concurrently")

    async def begin(self, meeting_id, command_id, session_uid, text, voice):
        fingerprint = hashlib.sha256(json.dumps([text, voice]).encode()).hexdigest()
        def change(current, active):
            if current:
                if current["fingerprint"] != fingerprint or current["session_uid"] != session_uid:
                    raise SpeechConflict("Command ID already used for another request")
                return current, False
            if active and active != command_id:
                raise SpeechConflict("Another speech command is active")
            return {"command_id": command_id, "meeting_id": meeting_id, "session_uid": session_uid,
                    "fingerprint": fingerprint, "state": "queued"}, True
        return await self.update(meeting_id, command_id, change, receipt=True)

    async def report(self, meeting_id, command_id, session_uid, state):
        def change(current, active):
            if not current or current["session_uid"] != session_uid:
                raise SpeechConflict("Unknown speech command or bot session")
            if current["state"] in TERMINAL:
                return current, False
            if state == "completed" and current["state"] != "started":
                raise SpeechConflict("Playback must start before it can complete")
            if state == "started" and current.get("cancel_requested"):
                raise SpeechConflict("Speech cancellation is pending")
            return current | {"state": state}, True
        return await self.update(meeting_id, command_id, change)

    async def cancel(self, meeting_id, command_id, session_uid):
        def change(current, active):
            if not current:
                if active and active != command_id:
                    raise SpeechConflict("Another speech command is active")
                return {"command_id": command_id, "meeting_id": meeting_id, "session_uid": session_uid,
                        "fingerprint": None, "state": "queued", "cancel_requested": True}, True
            if current["state"] in TERMINAL:
                return current, False
            return current | {"cancel_requested": True}, True
        return await self.update(meeting_id, command_id, change)

    @staticmethod
    def public(record):
        return {key: record[key] for key in ("command_id", "meeting_id", "state")}
