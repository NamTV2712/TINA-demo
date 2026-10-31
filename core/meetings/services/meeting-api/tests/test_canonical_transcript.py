import json
import pytest

from meeting_api.collector.transcript_revisions import dispatch_revisions
from meeting_api.collector.transcript_document import Correction
from test_bot_refinement import fixture


@pytest.mark.asyncio
async def test_manual_refinement_restore_search_and_transactional_events(monkeypatch):
    client, store, _, worker, _ = await fixture(monkeypatch)
    path = '/transcripts/by-id/1'
    async with client:
        response = await client.patch(path + '/segments/s%2F1', json={'expected_revision': 0, 'text': 'manualneedle'})
        assert response.status_code == 200
        search = lambda q: client.get('/transcripts/search', params={'q': q, 'meeting_id': 1})
        assert (await search('manualneedle')).json()['count'] == 1
        assert (await search('thu')).json()['count'] == 0
        await client.post(path + '/refinement/start', json={})
        await worker.task
        job = await worker.current(7, 1)
        response = await client.post(path + '/refinement/apply', json={'job_id': job['id'], 'segment_id': 's/1', 'expected_revision': 1})
        assert response.status_code == 200, response.text
        assert (await search('manualneedle')).json()['count'] == 0
        assert (await search('thứ')).json()['count'] == 1
        response = await client.patch(path + '/segments/s%2F1', json={'expected_revision': 2, 'text': None})
        assert response.status_code == 200
        assert (await search('thu')).json()['count'] == 1
        assert (await search('thứ')).json()['count'] == 0
        assert (await client.get(path)).json()['segments'][0]['revision'] == 3
        assert store._meetings[1]['segments']['s/1']['text'] == 'api thu sau'
        pending = await store.pending_revisions()
        assert [r['event']['revision'] for r in pending] == [1, 2, 3]
        assert [r['event']['kind'] for r in pending] == ['manual', 'refinement', 'restore']
        assert all('text' not in r['event'] and 'actor_id' not in r['event'] for r in pending)
        assert 'transcript_outbox' not in (await client.get(path)).json()['data']
        assert (await client.patch(path + '/segments/s%2F1', json={'expected_revision': 0, 'text': 'stale'})).status_code == 409
        assert len(await store.pending_revisions()) == 3
        assert (await client.get('/transcripts/search', params={'q': 'thu'}, headers={'x-user-id': '8'})).json()['count'] == 0


@pytest.mark.asyncio
async def test_publish_failure_retries_and_exact_ack_retains_new_events(monkeypatch):
    client, store, _, _, _ = await fixture(monkeypatch)
    await store.correct_transcript(7, 1, 's/1', Correction(expected_revision=0, text='first'))
    first = (await store.pending_revisions())[0]['event']
    class Publisher:
        calls = []
        fail = True
        async def publish(self, channel, body):
            self.calls.append((channel, json.loads(body)))
            if self.fail and channel.startswith('tc:'):
                raise ConnectionError('offline')
    publisher = Publisher()
    with pytest.raises(ConnectionError):
        await dispatch_revisions(store, publisher)
    assert (await store.pending_revisions())[0]['event']['event_id'] == first['event_id']
    await store.correct_transcript(7, 1, 's/1', Correction(expected_revision=1, text='second'))
    publisher.fail = False
    assert await dispatch_revisions(store, publisher, limit=1) == 1
    assert [r['event']['revision'] for r in await store.pending_revisions()] == [2]
    assert await dispatch_revisions(store, publisher) == 1
    assert await dispatch_revisions(store, publisher) == 0
    assert publisher.calls[0][1] == publisher.calls[2][1]  # duplicate retains its event identity
    await store.ack_revision(7, 1, first['event_id'])  # repeated ack is harmless
    assert await store.pending_revisions() == []
    await client.aclose()


def test_revision_event_conforms_to_metadata_only_contract():
    from pathlib import Path
    import jsonschema
    from meeting_api.collector.transcript_revisions import enqueue_revision
    root = next(p for p in Path(__file__).resolve().parents if (p / 'core/meetings/contracts').exists())
    schema = json.loads((root / 'core/meetings/contracts/transcript-revision.v1/transcript-revision.schema.json').read_text())
    event = enqueue_revision({}, meeting_id=1, platform='desktop', native_id='sample', segment_id='s1',
                             revision={'revision': 1, 'kind': 'manual', 'at': '2026-10-21T10:00:00Z'})
    jsonschema.validate(event, schema)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({**event, 'text': 'private'}, schema)
