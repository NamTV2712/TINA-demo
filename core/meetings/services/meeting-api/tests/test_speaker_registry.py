import copy

import pytest
from pydantic import ValidationError

from meeting_api.collector.speakers import SpeakerUpdate, observe, overlay, update, view
from meeting_api.collector.transcript_document import CorrectionConflict

MEETING = {"id": 42, "platform": "google_meet", "native_meeting_id": "abc-defg-hij"}


def segment(sid="turn:1:1000", key="turn:1", participant="participant-a", name="Minh"):
    return {"segment_id": sid, "speaker_key": key, "session_uid": "session", "participant_id": participant,
            "speaker": name, "source": "glow-bound", "text": "raw spoken words", "start": 1, "end": 2}


def test_platform_identity_is_stable_across_turns_but_same_names_never_merge():
    data = {}
    rows = [segment(), segment("turn:2:3000", "turn:2"), segment("turn:3:5000", "turn:3", "participant-b")]
    assert observe(data, MEETING, rows)
    assert rows[0]["speaker_id"] == rows[1]["speaker_id"] != rows[2]["speaker_id"]
    assert rows[0]["speaker_status"] == "observed"
    before = copy.deepcopy(data)
    assert not observe(data, MEETING, rows)
    assert data == before
    assert rows[0]["text"] == "raw spoken words"


def test_unattributed_names_remain_unknown_and_chat_is_not_a_voice():
    data = {}
    rows = [segment(participant=None), {**segment("chat:1"), "source": "chat"}]
    observe(data, MEETING, rows)
    assert rows[0]["speaker"] == "Unknown speaker"
    assert rows[0]["speaker_status"] == "unknown"
    assert "speaker_id" not in rows[1]
    assert view(data, 42)["speakers"][0]["candidate_name"] == "Minh"


def test_confirmation_history_cas_unknown_and_later_metadata_preserve_raw_words():
    data, rows = {}, [segment()]
    observe(data, MEETING, rows)
    sid = rows[0]["speaker_id"]
    update(data, MEETING, sid, SpeakerUpdate(expected_revision=1, name="Nguyễn Minh"), 7)
    with pytest.raises(CorrectionConflict):
        update(data, MEETING, sid, SpeakerUpdate(expected_revision=1, name="Other"), 7)
    later = [segment("turn:2:3000", "turn:2", name="New Meet label")]
    observe(data, MEETING, later)
    assert later[0]["speaker_id"] == sid
    assert later[0]["speaker"] == "Nguyễn Minh"
    assert later[0]["text"] == "raw spoken words"
    assert overlay([segment()], data)[0]["speaker"] == "Nguyễn Minh"
    update(data, MEETING, sid, SpeakerUpdate(expected_revision=2, name=None), 7)
    speaker = view(data, 42)["speakers"][0]
    assert speaker["status"] == "unknown" and speaker["name"] is None
    assert [h["revision"] for h in speaker["history"]] == [1, 2, 3]
    assert all("name" not in e and "actor_id" not in e for e in data["transcript_outbox"])


@pytest.mark.parametrize("body", [{"expected_revision": True, "name": "A"}, {"expected_revision": 0, "name": "A"},
                                  {"expected_revision": 1, "name": " "}, {"expected_revision": 1, "name": "A\nB"},
                                  {"expected_revision": 1, "name": "A" * 121}, {"expected_revision": 1, "name": "A", "actor_id": 99}])
def test_invalid_updates_are_refused(body):
    with pytest.raises(ValidationError):
        SpeakerUpdate(**body)


@pytest.mark.parametrize("status", ["active", "completed"])
def test_owner_endpoints_persist_identity_notify_and_preserve_text(status):
    from fastapi.testclient import TestClient
    from meeting_api.collector import create_app
    from meeting_api.collector.fakes import InMemoryTranscriptStore
    store = InMemoryTranscriptStore()
    mid = store.seed_meeting(user_id=7, platform="google_meet", native_meeting_id="abc", status=status, segments=[segment()])
    client = TestClient(create_app(store, None))
    path = f"/transcripts/by-id/{mid}/speakers"
    assert client.get(path).status_code == 401
    assert client.get(path, headers={"x-user-id":"99"}).status_code == 404
    first = client.get(path, headers={"x-user-id":"7"}).json()["speakers"][0]
    endpoint = path + "/" + first["speaker_id"]
    assert client.patch(endpoint, headers={"x-user-id":"99"}, json={"name":"Private","expected_revision":1}).status_code == 404
    assert client.patch(endpoint, headers={"x-user-id":"7"}, json={"name":"Nguyễn Minh","expected_revision":1}).status_code == 200
    doc = client.get(f"/transcripts/by-id/{mid}", headers={"x-user-id":"7"}).json()
    assert doc["segments"][0]["text"] == "raw spoken words"
    assert doc["segments"][0]["speaker"] == "Nguyễn Minh"
    assert doc["segments"][0]["speaker_revision"] == 2
    assert "speaker_registry" not in doc["data"]
    assert client.patch(endpoint, headers={"x-user-id":"7"}, json={"name":"Stale","expected_revision":1}).status_code == 409
    event = store._meetings[mid]["data"]["transcript_outbox"][-1]
    assert event["kind"] == "speaker" and event["speaker_id"] == first["speaker_id"]
    assert "segment_id" not in event and "name" not in event
    assert client.patch(endpoint, headers={"x-user-id":"7"}, json={"name":None,"expected_revision":2}).status_code == 200
    assert client.get(path, headers={"x-user-id":"7"}).json()["speakers"][0]["status"] == "unknown"


@pytest.mark.asyncio
async def test_deleting_artifacts_removes_identity_history_and_refuses_late_observations():
    from meeting_api.collector.fakes import InMemoryTranscriptStore
    store=InMemoryTranscriptStore()
    mid=store.seed_meeting(user_id=7,platform="google_meet",native_meeting_id="abc",status="completed",segments=[segment()])
    await store.get_speakers(7,mid)
    await store.prepare_completed_artifact_deletion(7,mid)
    await store.finalize_completed_artifact_deletion(7,mid)
    assert "speaker_registry" not in store._meetings[mid]["data"]
    assert await store.get_speakers(7,mid) is None
    await store.append_segment(mid,segment("late:1"))
    assert "speaker_registry" not in store._meetings[mid]["data"]


def test_registry_provenance_stays_off_ordinary_and_webhook_payloads():
    from meeting_api.collector.projection import project_response_data, project_list_data
    from meeting_api.webhooks.delivery import clean_meeting_data
    data={"title":"Meeting","speaker_registry":{"speakers":{"private":{"history":[{"actor_id":7,"participant_id":"private-platform-id"}]}}}}
    assert "speaker_registry" not in project_response_data(data,viewer_is_owner=True)
    assert "speaker_registry" not in project_response_data(data,viewer_is_owner=False)
    assert "speaker_registry" not in project_list_data(data)
    assert "speaker_registry" not in clean_meeting_data(data)
