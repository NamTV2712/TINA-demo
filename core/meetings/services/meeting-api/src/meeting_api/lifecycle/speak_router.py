"""Owner-scoped Speak commands published to an active bot's acts.v1 Redis channel."""
from __future__ import annotations

import json
import os
from typing import Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..bot_spawn.ports import MeetingRepo
from .stop import leave_command_channel
from .stop_router import CommandPublisher, _SUPPORTED_PLATFORMS, _resolve_user_id


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    voice: Optional[str] = Field(default=None, max_length=64)
    model_config = ConfigDict(extra="forbid")

    @field_validator("text")
    @classmethod
    def non_blank_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("text must not be blank")
        return value


def build_speak_router(repo: MeetingRepo, publisher: CommandPublisher) -> APIRouter:
    router = APIRouter()

    async def publish(meeting: dict, command: dict) -> None:
        try:
            listeners = await publisher.publish(
                leave_command_channel(meeting["id"]),
                json.dumps(command, ensure_ascii=False),
            )
        except Exception as exc:
            raise HTTPException(status_code=503, detail="Bot command channel is unavailable") from exc
        if listeners == 0:
            raise HTTPException(status_code=409, detail="Bot is not listening for commands")

    async def active_voice_bot(platform: str, native_meeting_id: str, user_id: int) -> dict:
        if platform not in _SUPPORTED_PLATFORMS:
            raise HTTPException(status_code=422, detail=f"unsupported platform '{platform}'")
        meeting = await repo.find_active(user_id, platform, native_meeting_id)
        if meeting is None:
            raise HTTPException(status_code=404, detail="No active meeting for this bot")
        if meeting.get("status") != "active":
            raise HTTPException(status_code=409, detail="Bot is not admitted to the meeting")
        return meeting

    @router.post("/bots/{platform}/{native_meeting_id}/speak")
    async def speak(
        platform: str,
        native_meeting_id: str,
        body: SpeakRequest,
        x_user_id: Optional[str] = Header(default=None),
    ):
        user_id = _resolve_user_id(x_user_id)
        meeting = await active_voice_bot(platform, native_meeting_id, user_id)
        if not os.getenv("TTS_SERVICE_URL", "").strip():
            raise HTTPException(status_code=503, detail="TTS_SERVICE_URL is not configured")
        if not (meeting.get("data") or {}).get("voice_agent_enabled"):
            raise HTTPException(status_code=409, detail="Speak was not enabled when this bot started")
        command = {"action": "speak", "text": body.text, "voice": (body.voice or "").strip() or "auto"}
        await publish(meeting, command)
        return {"accepted": True, "meeting_id": meeting["id"]}

    @router.delete("/bots/{platform}/{native_meeting_id}/speak")
    async def stop_speaking(
        platform: str,
        native_meeting_id: str,
        x_user_id: Optional[str] = Header(default=None),
    ):
        user_id = _resolve_user_id(x_user_id)
        meeting = await active_voice_bot(platform, native_meeting_id, user_id)
        if not (meeting.get("data") or {}).get("voice_agent_enabled"):
            raise HTTPException(status_code=409, detail="Speak was not enabled when this bot started")
        await publish(meeting, {"action": "speak_stop"})
        return {"accepted": True, "meeting_id": meeting["id"]}

    return router
