"""Durable owner-only voice answers; independent of canonical ASR transcript rows."""
from typing import Literal
from uuid import UUID
import time

from pydantic import BaseModel, ConfigDict, Field, model_validator
from urllib.parse import urlsplit

FINAL = {'completed', 'failed', 'stopped'}


class VoiceLink(BaseModel):
    model_config = ConfigDict(extra='forbid')
    title: str = Field(min_length=1, max_length=300)
    url: str = Field(min_length=1, max_length=4096)

    @model_validator(mode='after')
    def safe_url(self):
        parsed = urlsplit(self.url)
        if (parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username is not None
                or any(c.isspace() or ord(c) < 32 for c in self.url)):
            raise ValueError('Invalid public source URL')
        parsed.port
        return self


class VoiceLookup(BaseModel):
    model_config = ConfigDict(extra='forbid')
    tool: Literal['get_recent_transcript', 'search_meeting', 'search_shared_documents']
    source_count: int = Field(ge=0, le=32, strict=True)


class VoiceReply(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: UUID
    text: str = Field(min_length=1, max_length=4000)
    played_text: str | None = Field(default=None, max_length=4000)
    answer_kind: Literal['meeting', 'general', 'web'] = 'meeting'
    reason: Literal['answered', 'clarification', 'no_shared_sources', 'retrieval_empty', 'insufficient_evidence',
                    'verification_rejected', 'verification_unavailable', 'llm_unavailable',
                    'general_disabled', 'web_disabled', 'web_unavailable', 'web_no_sources'] = 'answered'
    links: list[VoiceLink] = Field(default_factory=list, max_length=6)
    lookups: list[VoiceLookup] = Field(default_factory=list, max_length=2)
    state: Literal['queued', 'started', 'completed', 'failed', 'stopped', 'unconfirmed']
    created_at_ms: int = Field(ge=0, strict=True)
    updated_at_ms: int = Field(ge=0, strict=True)
    started_at_ms: int | None = Field(default=None, ge=0, strict=True)
    ended_at_ms: int | None = Field(default=None, ge=0, strict=True)

    @model_validator(mode='after')
    def played_prefix(self):
        if self.played_text is not None and not ' '.join(self.text.split()).startswith(self.played_text):
            raise ValueError('Played text is not an answer prefix')
        return self


def merge_reply(data, session, reply):
    if (data or {}).get('artifact_deletion'):
        raise ValueError('Meeting artifacts were deleted')
    value = VoiceReply.model_validate(reply).model_dump(mode='json')
    history = dict((data or {}).get('voice_replies') or {})
    key = value['request_id']
    previous = history.get(key)
    if previous:
        if previous['session_uid'] != session or previous['text'] != value['text']:
            raise ValueError('Voice reply identity changed')
        if previous['state'] in FINAL or (previous['state'] == 'started' and value['state'] == 'queued'):
            return data
    history[key] = value | {'session_uid': session}
    # shortcut: replies share meeting JSONB; use a paginated table when histories make row writes expensive.
    return dict(data or {}, voice_replies=history)


def public_replies(row, active_session, heartbeat_fresh=True):
    replies = []
    for record in ((row.get('data') or {}).get('voice_replies') or {}).values():
        value = {key: val for key, val in record.items() if key != 'session_uid'}
        if value['state'] not in FINAL and (record.get('session_uid') != active_session
                or (not heartbeat_fresh and int(time.time() * 1000) - value['updated_at_ms'] > 15000)):
            value['state'] = 'unconfirmed'
        replies.append(VoiceReply.model_validate(value).model_dump(mode='json'))
    return sorted(replies, key=lambda item: (item['created_at_ms'], item['request_id']))
