"""Discord as a first-class spawn platform (voice connector, not a browser bot).

Discord adds a SECOND runtime profile behind the same runtime.v1 spawn port:

  * ``request_bot`` keeps every spawn invariant (dedup, quota, token, session, stop interlock) but
    mints a ``dc-`` workload id + ``profile="discord-bot"`` and hands the connector a Discord
    invocation (channel URL + native id) instead of browser auth / recording / capture-tape fields;
  * ``CompositeRuntimeClient`` routes create on the profile and delete/get on the ``dc-`` prefix;
  * the public ``POST /bots`` door accepts either a ``<guild>:<channel>`` native id or the channel
    link, refuses disagreement, and refuses recording it cannot deliver.

All offline: the in-memory repo + fake runtime drive the SHIPPED handlers.
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from meeting_api import create_app
from meeting_api.bot_spawn import (
    build_workload_spec,
    request_bot,
)
from meeting_api.bot_spawn.adapters import CompositeRuntimeClient
from meeting_api.bot_spawn.fakes import FakeRuntimeClient, InMemoryMeetingRepo
from meeting_api.bot_spawn.invocation import conforms_workload_spec
from meeting_api.collector.fakes import InMemoryTranscriptStore
from meeting_api.collector.meeting_link import (
    discord_channel_url,
    find_meeting_link,
    parse_discord_channel_url,
    parse_meeting_url,
)
from meeting_api.bot_spawn.service import construct_meeting_url
from meeting_api.lifecycle.stop_router import InMemoryCommandPublisher

SECRET = "test-admin-token"
USER = 7
HEADERS = {"x-user-id": str(USER)}
GUILD = "123456789012345678"
CHANNEL = "987654321098765432"
NATIVE = f"{GUILD}:{CHANNEL}"
URL = f"https://discord.com/channels/{GUILD}/{CHANNEL}"


@pytest.fixture(autouse=True)
def _admin_token(monkeypatch):
    monkeypatch.setenv("ADMIN_TOKEN", SECRET)


def _client(*, repo=None, runtime=None):
    return TestClient(create_app(
        transcript_store=InMemoryTranscriptStore(),
        meeting_repo=repo if repo is not None else InMemoryMeetingRepo(),
        runtime=runtime if runtime is not None else FakeRuntimeClient(),
        command_publisher=InMemoryCommandPublisher(),
    ))


# ── parsing / construction: the link and the native id are the same address ─────────────────────

def test_parse_discord_channel_url_accepts_the_real_hosts():
    for host in ("discord.com", "www.discord.com", "canary.discord.com",
                 "ptb.discord.com", "discordapp.com", "www.discordapp.com"):
        assert parse_discord_channel_url(f"https://{host}/channels/{GUILD}/{CHANNEL}") == NATIVE


def test_parse_discord_channel_url_refuses_lookalikes_and_non_guild_paths():
    assert parse_discord_channel_url(f"https://discord.com.evil.example/channels/{GUILD}/{CHANNEL}") is None
    assert parse_discord_channel_url(f"https://evil-discord.com/channels/{GUILD}/{CHANNEL}") is None
    # A DM has no guild; @me is not a snowflake.
    assert parse_discord_channel_url(f"https://discord.com/channels/@me/{CHANNEL}") is None
    # A message permalink is deeper than the channel route.
    assert parse_discord_channel_url(f"https://discord.com/channels/{GUILD}/{CHANNEL}/999") is None
    # Snowflakes are 15–21 digits (the connector's own bound).
    assert parse_discord_channel_url("https://discord.com/channels/123/456") is None
    assert parse_discord_channel_url(f"https://discord.com/channels/{GUILD}/{CHANNEL}x") is None


def test_discord_native_id_and_url_roundtrip():
    assert discord_channel_url(NATIVE) == URL
    assert discord_channel_url(URL) is None          # a URL is not a native id
    assert discord_channel_url("123:456") is None    # too short
    assert discord_channel_url(f"{GUILD}/{CHANNEL}") is None


def test_parse_meeting_url_and_ics_scan_recognize_discord():
    assert parse_meeting_url(URL) == ("discord", NATIVE)
    assert parse_meeting_url(NATIVE) == ("discord", NATIVE)
    # A bare Teams thread id must NOT be read as a Discord native id.
    assert parse_meeting_url("19:meeting_abc@thread.v2") is None
    assert find_meeting_link(f"Join here: {URL}") == ("discord", NATIVE, URL)


def test_construct_meeting_url_builds_discord_from_the_native_id():
    assert construct_meeting_url("discord", NATIVE) == URL
    assert construct_meeting_url("discord", "not-a-discord-id") is None


# ── workload spec: the connector's profile, not the container kernel's ──────────────────────────

def test_build_workload_spec_carries_the_serving_profile():
    spec = build_workload_spec(
        workload_id="dc-1-abcdef12",
        profile="discord-bot",
        invocation={"platform": "discord"},
    )
    conforms_workload_spec(spec)
    assert spec["profile"] == "discord-bot"
    assert json.loads(spec["env"]["TINA_BOT_CONFIG"])["platform"] == "discord"
    # The default keeps every existing browser-bot caller unchanged.
    assert build_workload_spec(
        workload_id="mtg-1-abcdef12", invocation={"platform": "google_meet"},
    )["profile"] == "meeting-bot"


# ── request_bot: Discord keeps the spawn invariants, drops the browser-only fields ──────────────

async def test_request_bot_discord_uses_the_connector_profile_and_dc_id(monkeypatch):
    monkeypatch.setenv("TRANSCRIPTION_SERVICE_URL", "http://localhost:8083")
    monkeypatch.setenv("TRANSCRIPTION_SERVICE_TOKEN", "tok-test")
    # A browser-auth deployment must not gate a Discord spawn: the connector authenticates with
    # its OWN bot token, never the stored browser session.
    monkeypatch.setenv("BOT_AUTHENTICATED", "true")

    repo = InMemoryMeetingRepo()
    runtime = FakeRuntimeClient()
    meeting = await request_bot(
        repo, runtime, user_id=USER, platform="discord", native_meeting_id=NATIVE,
        bot_name="TINA", redis_url="redis://redis:6379/0",
        meeting_api_url="http://meeting-api:8080", token_secret=SECRET,
    )

    spec = runtime.specs[0]
    assert spec["profile"] == "discord-bot"
    assert spec["workloadId"].startswith("dc-")
    inv = json.loads(spec["env"]["TINA_BOT_CONFIG"])
    assert inv["platform"] == "discord"
    assert inv["nativeMeetingId"] == NATIVE
    assert inv["meetingUrl"] == URL
    # Browser-only fields are absent, not false: nothing downstream can mistake this for a
    # browser bot that merely failed to record.
    assert "authenticated" not in inv
    assert "recordingEnabled" not in inv or inv["recordingEnabled"] is False
    assert "recordingUploadUrl" not in inv
    assert "captureSignalEnabled" not in inv
    assert "captureModes" not in inv
    # No lobby on Discord — the connector's own alone timers apply.
    assert "automaticLeave" not in inv
    # The session got the eager create + the connector workload id, exactly like any spawn.
    assert repo.sessions[0]["session_uid"] == inv["connectionId"]
    assert meeting["bot_container_id"] == spec["workloadId"]


async def test_request_bot_discord_downgrades_inherited_recording_policy(monkeypatch):
    """Auto-join resolves recording from the CALENDAR policy (default ON) and calls request_bot
    directly. Discord cannot record, so the policy is downgraded — the join still happens."""
    monkeypatch.setenv("TRANSCRIPTION_SERVICE_URL", "http://localhost:8083")
    monkeypatch.setenv("TRANSCRIPTION_SERVICE_TOKEN", "tok-test")
    runtime = FakeRuntimeClient()
    await request_bot(
        InMemoryMeetingRepo(), runtime, user_id=USER, platform="discord",
        native_meeting_id=NATIVE, recording_enabled=True,
        redis_url="redis://redis:6379/0", token_secret=SECRET,
    )
    inv = json.loads(runtime.specs[0]["env"]["TINA_BOT_CONFIG"])
    assert "recordingEnabled" not in inv or inv["recordingEnabled"] is False
    assert "recordingUploadUrl" not in inv


# ── Composite runtime: create on profile, delete/get on the id prefix ──────────────────────────

async def test_composite_runtime_routes_by_profile_and_id_prefix():
    kernel, discord = FakeRuntimeClient(), FakeRuntimeClient()
    runtime = CompositeRuntimeClient(kernel, discord)

    await runtime.create_workload({"workloadId": "mtg-1-ab", "profile": "meeting-bot", "env": {}})
    await runtime.create_workload({"workloadId": "dc-2-cd", "profile": "discord-bot", "env": {}})
    assert [s["workloadId"] for s in kernel.specs] == ["mtg-1-ab"]
    assert [s["workloadId"] for s in discord.specs] == ["dc-2-cd"]

    assert (await runtime.get_workload("dc-2-cd"))["state"] == "running"
    assert (await runtime.get_workload("mtg-1-ab"))["state"] == "running"

    await runtime.delete_workload("dc-2-cd")
    await runtime.delete_workload("mtg-1-ab")
    assert discord.deleted == ["dc-2-cd"]
    assert kernel.deleted == ["mtg-1-ab"]


# ── the public door: link/native-id agreement + no recording promise ───────────────────────────

def test_post_bots_discord_link_spawns_on_the_connector():
    runtime = FakeRuntimeClient()
    c = _client(runtime=runtime)
    r = c.post("/bots", headers=HEADERS,
               json={"platform": "discord", "meeting_url": URL})
    assert r.status_code == 201, r.text
    spec = runtime.specs[0]
    assert spec["profile"] == "discord-bot"
    assert spec["workloadId"].startswith("dc-")
    inv = json.loads(spec["env"]["TINA_BOT_CONFIG"])
    assert inv["nativeMeetingId"] == NATIVE
    assert inv["meetingUrl"] == URL


def test_post_bots_discord_native_id_alone_is_constructible():
    runtime = FakeRuntimeClient()
    c = _client(runtime=runtime)
    r = c.post("/bots", headers=HEADERS,
               json={"platform": "discord", "native_meeting_id": NATIVE})
    assert r.status_code == 201, r.text
    assert json.loads(runtime.specs[0]["env"]["TINA_BOT_CONFIG"])["meetingUrl"] == URL


def test_post_bots_discord_disagreeing_link_and_native_id_is_422():
    runtime = FakeRuntimeClient()
    c = _client(runtime=runtime)
    other = "111111111111111111:222222222222222222"
    r = c.post("/bots", headers=HEADERS,
               json={"platform": "discord", "native_meeting_id": other, "meeting_url": URL})
    assert r.status_code == 422, r.text
    assert "disagrees" in r.json()["detail"]
    assert runtime.specs == []


def test_post_bots_discord_non_channel_url_is_422():
    c = _client()
    r = c.post("/bots", headers=HEADERS,
               json={"platform": "discord", "meeting_url": f"https://discord.com/channels/{GUILD}"})
    assert r.status_code == 422, r.text


def test_post_bots_discord_bad_native_id_is_422():
    c = _client()
    r = c.post("/bots", headers=HEADERS,
               json={"platform": "discord", "native_meeting_id": "guild:channel"})
    assert r.status_code == 422, r.text
    assert "snowflake" in r.json()["detail"]


def test_post_bots_discord_explicit_recording_is_refused_before_spawn():
    runtime = FakeRuntimeClient()
    c = _client(runtime=runtime)
    r = c.post("/bots", headers=HEADERS,
               json={"platform": "discord", "native_meeting_id": NATIVE,
                     "recording_enabled": True})
    assert r.status_code == 422, r.text
    assert "recording_enabled is not supported" in r.json()["detail"]
    assert runtime.specs == []


def test_delete_bots_discord_is_a_supported_platform():
    """Discord is in the sealed api.v1 Platform enum, so stop passes validation and reports the
    real state (no active bot → 404), not a 422 'unsupported platform'."""
    c = _client()
    r = c.delete(f"/bots/discord/{NATIVE}", headers=HEADERS)
    assert r.status_code == 404, r.text
