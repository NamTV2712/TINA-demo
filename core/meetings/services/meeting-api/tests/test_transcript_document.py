from fastapi.testclient import TestClient
import pytest

from meeting_api.collector import create_app
from meeting_api.collector.fakes import InMemoryTranscriptStore


def setup():
    store = InMemoryTranscriptStore()
    for mid, owner, status in [(1, 7, "completed"), (2, 8, "completed"), (3, 7, "active")]:
        store.seed_meeting(user_id=owner, platform="desktop", native_meeting_id=f"m{mid}",
                           meeting_id=mid, status=status, segments=[{
                               "segment_id": "s/1", "speaker": "You", "text": "  API   thứ sáu  ",
                               "start": 0, "end": 2, "completed": True}])
    return TestClient(create_app(store, redis=None)), store


HEADERS = {"x-user-id": "7"}


def test_raw_revision_restore_and_existing_read_overlay():
    client, store = setup()
    path = "/transcripts/by-id/1"
    doc = client.get(path + "/document", headers=HEADERS).json()
    assert doc["segments"][0]["normalized_text"] == "API thứ sáu"
    patch = {"expected_revision": 0, "text": "API thứ Sáu."}
    response = client.patch(path + "/segments/s%2F1", headers=HEADERS, json=patch)
    assert response.status_code == 200, response.text
    segment = response.json()["segments"][0]
    assert segment["raw_text"] == "  API   thứ sáu  "
    assert segment["revision"] == 1
    assert segment["history"][0]["actor_id"] == 7
    assert client.get(path, headers=HEADERS).json()["segments"][0]["text"] == "API thứ Sáu."
    assert "transcript_edits" not in client.get(path, headers=HEADERS).json()["data"]
    assert store._meetings[1]["segments"]["s/1"]["text"] == "  API   thứ sáu  "
    assert client.patch(path + "/segments/s%2F1", headers=HEADERS, json=patch).status_code == 409
    restored = client.patch(path + "/segments/s%2F1", headers=HEADERS,
                            json={"expected_revision": 1, "text": None}).json()["segments"][0]
    assert restored["text"] == "  API   thứ sáu  "
    assert restored["revision"] == 2
    assert len(restored["history"]) == 2


def test_owner_only_and_completed_only():
    client, _ = setup()
    for mid in [1, 2, 3]:
        path = f"/transcripts/by-id/{mid}"
        expected = {1: 200, 2: 404, 3: 409}[mid]
        assert client.patch(path + "/segments/s%2F1", headers=HEADERS,
                            json={"expected_revision": 0, "text": "correct"}).status_code == expected
    assert client.get("/transcripts/by-id/2/document", headers=HEADERS).status_code == 404
    assert client.get("/transcripts/by-id/1/document").status_code == 401


def test_invalid_payload_does_not_create_revision():
    client, _ = setup()
    for payload in [{"text": "x"}, {"expected_revision": True, "text": "x"},
                    {"expected_revision": -1, "text": "x"}, {"expected_revision": 0, "text": " "},
                    {"expected_revision": 0, "text": "x" * 10001},
                    {"expected_revision": 0, "text": "x", "raw_text": "overwrite"}]:
        assert client.patch("/transcripts/by-id/1/segments/s%2F1", headers=HEADERS, json=payload).status_code == 422
    assert client.get("/transcripts/by-id/1/document", headers=HEADERS).json()["segments"][0]["revision"] == 0


def test_restore_preserves_legacy_original_even_if_empty_or_long():
    from meeting_api.collector.transcript_document import Correction, corrected
    for raw in ["", "Đ" * 10001]:
        first = corrected({}, "s1", raw, Correction(expected_revision=0, text="edited"), 7)
        restored = corrected({"s1": first}, "s1", raw, Correction(expected_revision=1, text=None), 7)
        assert restored["raw_text"] == raw
        assert restored["history"][-1]["text"] == raw


@pytest.mark.asyncio
@pytest.mark.parametrize("initial_revision", [0, 1])
async def test_sql_document_keeps_one_snapshot_during_correction(initial_revision):
    import copy
    from datetime import datetime
    from types import SimpleNamespace
    pytest.importorskip("sqlalchemy")
    from meeting_api.collector.adapters import SqlAlchemyTranscriptStore
    from meeting_api.collector.transcript_document import Correction, corrected

    raw = "original ASR"
    meeting = SimpleNamespace(id=1, user_id=7, platform="google_meet", platform_specific_id="m1",
                              status="completed", start_time=None, end_time=None,
                              created_at=datetime(2026, 10, 23), data={})
    row = SimpleNamespace(segment_id="s/1", session_uid="session", text=raw,
                          start_time=1, end_time=2, speaker="You", language="vi")
    if initial_revision:
        meeting.data = {"transcript_edits": {"s/1": corrected({}, "s/1", raw,
                        Correction(expected_revision=0, text="first correction"), 7)}}
    sessions, queries = [], []

    class Result:
        def __init__(self, rows): self.rows = rows
        def scalars(self): return self
        def first(self): return self.rows[0] if self.rows else None
        def all(self): return self.rows

    class Session:
        async def __aenter__(self):
            sessions.append(self)
            self.meeting = copy.deepcopy(meeting)
            return self

        async def connection(self, *, execution_options):
            assert execution_options == {"isolation_level": "REPEATABLE READ"}
            assert len(queries) == 2 * (len(sessions) - 1)

        async def execute(self, query):
            queries.append(query)
            entities = [column["entity"] for column in query.column_descriptions]
            assert len(entities) == 1
            return Result([self.meeting] if entities[0].__name__ == "Meeting" else [row])

        async def __aexit__(self, *args):
            # A different client commits after this DB snapshot closes.
            if len(sessions) == 1:
                meeting.data = {"transcript_edits": {"s/1": corrected(meeting.data.get("transcript_edits", {}), "s/1", raw,
                                Correction(expected_revision=initial_revision, text="corrected text"), 7)}}

    store = SqlAlchemyTranscriptStore(Session)
    segment = (await store.get_transcript_document(7, 1))["segments"][0]
    assert segment["raw_text"] == raw
    assert segment["text"] == ("first correction" if initial_revision else raw)
    assert segment["revision"] == initial_revision and len(segment["history"]) == initial_revision
    assert len(sessions) == 1 and len(queries) == 2
    segment = (await store.get_transcript_document(7, 1))["segments"][0]
    assert segment["raw_text"] == raw and segment["text"] == "corrected text"
    assert segment["revision"] == initial_revision + 1 and len(segment["history"]) == initial_revision + 1
