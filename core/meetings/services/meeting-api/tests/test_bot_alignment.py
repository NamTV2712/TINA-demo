import copy
import asyncio
import hashlib
import wave
from uuid import uuid5, NAMESPACE_URL

import httpx
import pytest
from fastapi import FastAPI

from meeting_api.collector.alignment import BotAligner, validate_result
from meeting_api.collector.app import build_router
from meeting_api.collector.diarization import attribution, word_attribution
from test_bot_refinement import fixture, HEADERS, audio as make_audio


@pytest.mark.asyncio
@pytest.mark.parametrize("mixed_only", [False, True])
async def test_alignment_job_provenance_outbox_and_raw_preservation(monkeypatch, mixed_only):
    client, store, storage, refiner, _ = await fixture(monkeypatch)
    monkeypatch.setenv("ALIGNMENT_SERVICE_URL", "http://aligner.test")
    monkeypatch.setenv("ALIGNMENT_SERVICE_TOKEN", "local-alignment-token")
    aligner = BotAligner(store, refiner)
    refiner.aligner = aligner
    original = copy.deepcopy(store._meetings[1]["segments"])
    original_client = type(client)
    def worker(request):
        assert request.url.path == "/align-batch"
        assert request.headers["authorization"] == "Bearer local-alignment-token"
        assert b'name="texts"' in request.content and b"api thu sau" in request.content
        start = request.content.index(b"RIFF")
        end = request.content.index(b"\r\n--", start)
        audio = request.content[start:end]
        text = "api thu sau"
        return httpx.Response(200, json={"results": [{
            "model": "mfa-vietnamese_mfa-test",
            "audio_sha256": hashlib.sha256(audio).hexdigest(),
            "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
            "duration_ms": 1000,
            "words": [
                {"index": 0, "text": "api", "start_ms": 100, "end_ms": 310, "aligned": True},
                {"index": 1, "text": "thu", "start_ms": 330, "end_ms": 410, "aligned": True},
                {"index": 2, "text": "sau", "start_ms": None, "end_ms": None, "aligned": False},
            ],
        }]})
    monkeypatch.setattr("meeting_api.collector.alignment.httpx.AsyncClient",
                        lambda **kw: original_client(transport=httpx.MockTransport(worker), **kw))
    app = FastAPI()
    app.include_router(build_router(store, None, refiner=refiner, aligner=aligner))
    async with original_client(transport=httpx.ASGITransport(app=app), base_url="http://api.test", headers=HEADERS) as api:
        path = "/transcripts/by-id/1/alignment"
        assert (await api.get(path, headers={"x-user-id": "8"})).status_code == 404
        started = await api.post(path + "/start")
        assert started.status_code == 202, started.text
        await aligner.task
        recording_key = "recording-hash:model:3"
        turns = [{"start_ms": 0, "end_ms": 820, "speaker": 0},
                 {"start_ms": 820, "end_ms": 2000 if mixed_only else 920, "speaker": 1}]
        if not mixed_only:
            turns.append({"start_ms": 920, "end_ms": 2000, "speaker": 0})
        store._meetings[1]["data"]["transcript_diarization"] = {
            "id": "diarization-job", "status": "completed",
            "recordings": [{"recording_id": 9, "offset_ms": 0}],
            "items": [{"segment_id": "s/1", "recording_key": recording_key, "cluster": attribution(500, 1500, turns)}],
            "turns": turns,
        }
        registry = await store.apply_diarization(7, 1, store._meetings[1]["data"]["transcript_diarization"])
        cluster_ids = [str(uuid5(NAMESPACE_URL, f"tina:meeting:1:diarization:{recording_key}:{cluster}")) for cluster in (0, 1)]
        if mixed_only:
            for sid in cluster_ids:
                store._meetings[1]["data"]["speaker_registry"]["speakers"].pop(sid)
            registry = await store.get_speakers(7, 1)
            events = len(await store.pending_revisions())
            await store.get_speakers(7, 1)
            assert len(await store.pending_revisions()) == events
        assert all(any(s["speaker_id"] == sid for s in registry["speakers"]) for sid in cluster_ids)
        status = (await api.get(path)).json()
        job = status["job"]
        assert status["available"] and job["status"] == "completed", job.get("error")
        assert job["items"][0]["audio_sha256"] and job["items"][0]["text_sha256"]
        assert [w["text"] for w in job["items"][0]["words"]] == ["api", "thu", "sau"]
        assert not job["items"][0]["words"][2]["aligned"]
        assert [p["speaker_name"] for p in job["items"][0]["phrases"]] == ["Speaker 1", "Speaker 2", "Unknown speaker"]
        assert [i for p in job["items"][0]["phrases"] for i in p["word_indices"]] == [0, 1, 2]
        for sid, name in zip(cluster_ids, ["Alice", None]):
            entry = next(s for s in registry["speakers"] if s["speaker_id"] == sid)
            renamed = await api.patch(f"/transcripts/by-id/1/speakers/{sid}", json={"name": name, "expected_revision": entry["revision"]})
            assert renamed.status_code == 200, renamed.text
        renamed_job = (await api.get(path)).json()["job"]
        assert [w["speaker_name"] for w in renamed_job["items"][0]["words"]] == ["Alice", "Unknown speaker", "Unknown speaker"]
        assert [w["speaker_id"] for w in renamed_job["items"][0]["words"]] == [*cluster_ids, None]
        if not mixed_only:
            store._meetings[1]["data"]["speaker_registry"]["speakers"][cluster_ids[0]]["participant_id"] = "verified-meet-participant"
            bound_job = (await api.get(path)).json()["job"]
            assert all(w["speaker_id"] == cluster_ids[0] and w["speaker_source"] == "confirmed" for w in bound_job["items"][0]["words"])
        playback = await api.get(path + "/s%2F1/audio")
        assert playback.status_code == 200
        assert hashlib.sha256(playback.content).hexdigest() == job["items"][0]["audio_sha256"]
        await storage.upload("r/audio/master.wav", make_audio(2000), content_type="audio/wav")
        assert (await api.get(path + "/s%2F1/audio")).status_code == 409
        assert store._meetings[1]["segments"] == original
        assert any(event["kind"] == "alignment" for event in store._meetings[1]["data"]["transcript_outbox"])
        assert "transcript_alignment" not in (await api.get("/transcripts/by-id/1")).json()["data"]
        changed = await api.patch("/transcripts/by-id/1/segments/s%2F1", json={"expected_revision": 0, "text": "manual revision"})
        assert changed.status_code == 200
        revisions = [r["event"] for r in await store.pending_revisions() if r["event"]["type"] == "transcript.revised"]
        assert [event["revision"] for event in revisions] == [1, 2]
        assert [event["kind"] for event in revisions] == ["alignment", "manual"]
        await store.prepare_completed_artifact_deletion(7, 1)
        await store.finalize_completed_artifact_deletion(7, 1)
        assert await store.get_alignment(7, 1) is None
    await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["http503", "invalid_result", "missing_audio", "partial"])
async def test_alignment_reports_total_and_partial_failures(monkeypatch, mode):
    client, store, storage, refiner, _ = await fixture(monkeypatch)
    original_client = type(client)
    count = 21 if mode == "partial" else 1
    if count > 1:
        source = next(iter(store._meetings[1]["segments"].values()))
        store._meetings[1]["segments"] = {f"s/{i}": {**source, "segment_id": f"s/{i}"} for i in range(count)}
    monkeypatch.setenv("ALIGNMENT_SERVICE_URL", "http://aligner.test")
    monkeypatch.setenv("ALIGNMENT_SERVICE_TOKEN", "test")
    content = make_audio()
    async def clip(*args):
        if mode == "missing_audio":
            raise ValueError("Missing recording")
        return content
    monkeypatch.setattr(refiner, "clip", clip)
    calls = 0
    def worker(request):
        nonlocal calls
        calls += 1
        if mode == "http503" or (mode == "partial" and calls > 1):
            return httpx.Response(503)
        result = {"model": "mfa-test", "audio_sha256": hashlib.sha256(content).hexdigest(),
                  "text_sha256": hashlib.sha256(b"api thu sau").hexdigest(), "words": [
                      {"index": i, "text": text, "start_ms": i * 200, "end_ms": i * 200 + 100, "aligned": True}
                      for i, text in enumerate(["api", "thu", "sau"])]}
        if mode == "invalid_result":
            result["audio_sha256"] = "wrong"
        return httpx.Response(200, json={"results": [result] * min(count, 20)})
    monkeypatch.setattr("meeting_api.collector.alignment.httpx.AsyncClient", lambda **kw: original_client(transport=httpx.MockTransport(worker), **kw))
    aligner = BotAligner(store, refiner)
    await aligner.start(7, 1)
    await aligner.task
    job = (await aligner.current(7, 1))["job"]
    assert job["status"] == ("completed" if mode == "partial" else "failed")
    assert job["error"]
    assert sum(i["state"] == "aligned" for i in job["items"]) == (20 if mode == "partial" else 0)
    assert sum(row["event"]["type"] == "transcript.revised" for row in await store.pending_revisions()) == (20 if mode == "partial" else 0)
    await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel_during_clip", [False, True])
async def test_cancel_during_preparation_does_not_start_a_worker_request(monkeypatch, cancel_during_clip):
    client, store, storage, refiner, _ = await fixture(monkeypatch)
    original_client = type(client)
    monkeypatch.setenv("ALIGNMENT_SERVICE_URL", "http://aligner.test")
    monkeypatch.setenv("ALIGNMENT_SERVICE_TOKEN", "test")
    entered, release = asyncio.Event(), asyncio.Event()
    async def clip(*args):
        entered.set()
        await release.wait()
        return make_audio()
    monkeypatch.setattr(refiner, "clip", clip)
    requests = []
    def worker(request):
        requests.append(request)
        return httpx.Response(503)
    monkeypatch.setattr("meeting_api.collector.alignment.httpx.AsyncClient", lambda **kw: original_client(transport=httpx.MockTransport(worker), **kw))
    aligner = BotAligner(store, refiner)
    await aligner.start(7, 1)
    if cancel_during_clip:
        await asyncio.wait_for(entered.wait(), 1)
    await aligner.cancel(7, 1)
    release.set()
    await aligner.task
    job = (await aligner.current(7, 1))["job"]
    assert job["status"] == "cancelled"
    assert all(item["state"] == "pending" for item in job["items"])
    assert requests == []
    assert await store.pending_revisions() == []
    await client.aclose()


@pytest.mark.asyncio
async def test_cancel_in_flight_finishes_only_the_current_batch(monkeypatch):
    client, store, storage, refiner, _ = await fixture(monkeypatch)
    original_client = type(client)
    source = next(iter(store._meetings[1]["segments"].values()))
    store._meetings[1]["segments"] = {f"s/{i}": {**source, "segment_id": f"s/{i}"} for i in range(21)}
    monkeypatch.setenv("ALIGNMENT_SERVICE_URL", "http://aligner.test")
    monkeypatch.setenv("ALIGNMENT_SERVICE_TOKEN", "test")
    content = make_audio()
    async def clip(*args):
        return content
    monkeypatch.setattr(refiner, "clip", clip)
    entered, release = asyncio.Event(), asyncio.Event()
    requests = []
    async def worker(request):
        requests.append(request)
        entered.set()
        await release.wait()
        result = {"model": "mfa-test", "audio_sha256": hashlib.sha256(content).hexdigest(),
                  "text_sha256": hashlib.sha256(b"api thu sau").hexdigest(), "words": [
                      {"index": i, "text": text, "start_ms": i * 200, "end_ms": i * 200 + 100, "aligned": True}
                      for i, text in enumerate(["api", "thu", "sau"])]}
        return httpx.Response(200, json={"results": [result] * 20})
    monkeypatch.setattr("meeting_api.collector.alignment.httpx.AsyncClient", lambda **kw: original_client(transport=httpx.MockTransport(worker), **kw))
    aligner = BotAligner(store, refiner)
    await aligner.start(7, 1)
    await asyncio.wait_for(entered.wait(), 1)
    await aligner.cancel(7, 1)
    release.set()
    await aligner.task
    job = (await aligner.current(7, 1))["job"]
    assert job["status"] == "cancelled"
    assert len(requests) == 1
    assert sum(item["state"] == "aligned" for item in job["items"]) == 20
    assert job["items"][-1]["state"] == "pending"
    await client.aclose()


def test_alignment_result_rejects_reordered_tokens_and_invalid_times():
    audio = b""
    # Use a valid small PCM16 WAV so the validator also checks source format.
    import io
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000); wav.writeframes(b"\0\0" * 16000)
    audio = out.getvalue()
    base = {"model": "mfa-test", "audio_sha256": hashlib.sha256(audio).hexdigest(),
            "text_sha256": hashlib.sha256(b"one two").hexdigest(), "words": [
                {"index": 0, "text": "one", "start_ms": 100, "end_ms": 250, "aligned": True},
                {"index": 1, "text": "two", "start_ms": None, "end_ms": None, "aligned": False},
            ]}
    assert len(validate_result(base, audio, "one two")["words"]) == 2
    with pytest.raises(ValueError, match="preserve every"):
        validate_result({**base, "words": [{**base["words"][0], "text": "two"}, base["words"][1]]}, audio, "one two")
    with pytest.raises(ValueError, match="Invalid word time"):
        validate_result({**base, "words": [{**base["words"][0], "end_ms": 0}, base["words"][1]]}, audio, "one two")


def test_word_attribution_requires_exclusive_diarization_coverage():
    assert word_attribution(0, 200, [{"start_ms": 0, "end_ms": 200, "speaker": 2}]) == 2
    assert word_attribution(0, 200, [
        {"start_ms": 0, "end_ms": 150, "speaker": 1},
        {"start_ms": 80, "end_ms": 120, "speaker": 2},
    ]) is None
