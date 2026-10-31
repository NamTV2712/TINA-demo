import copy
import json
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from meeting_api.collector.app import build_router
from meeting_api.collector.fakes import InMemoryTranscriptStore
from meeting_api.collector.foundation import validate, fingerprint
from test_bot_refinement import fixture

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'core/meetings/contracts').is_dir())


def snapshot():
    return json.loads((ROOT / 'core/meetings/contracts/stt-foundation.v1/golden/desktop.json').read_text())


def rehash(s):
    s['fingerprint'] = fingerprint({k: v for k, v in s.items() if k not in ('sequence', 'fingerprint')})
    return s


def test_desktop_fixture_uses_the_same_utf8_ids_digests_history_and_sample_clock():
    source = snapshot()
    assert validate(source) is source
    for mutate in (
        lambda s: s['segments'].append(copy.deepcopy(s['segments'][0])),
        lambda s: s['segments'][0]['audio'][0].update(start_sample=1),
        lambda s: s['segments'][0].update(text='worker overwrite'),
    ):
        broken = snapshot(); mutate(broken); rehash(broken)
        with pytest.raises(ValueError):
            validate(broken)


@pytest.mark.asyncio
async def test_owner_cas_replication_is_idempotent_and_cannot_overwrite_native_transcripts():
    store = InMemoryTranscriptStore()
    mid = store.seed_meeting(user_id=7, platform='google_meet', native_meeting_id='same-logical-meeting', status='completed',
                             segments=[{'segment_id': 'bot-one', 'text': 'Bot authority', 'start': 100, 'end': 101}])
    app = FastAPI(); app.include_router(build_router(store, None))
    src = snapshot(); path = f'/transcripts/by-id/{mid}/replicas/' + src['meeting_uid']
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test', headers={'x-user-id': '7'}) as api:
        assert (await api.put(path, json={'expected_revision': 0, 'snapshot': src}, headers={'x-user-id': '8'})).status_code == 404
        assert (await api.put(path, json={'expected_revision': 0, 'snapshot': src}, headers={'x-user-id': ''})).status_code == 401
        assert (await api.put(path, json={'expected_revision': 0, 'snapshot': src})).json() == src
        assert (await api.put(path, json={'expected_revision': 0, 'snapshot': src})).json() == src
        assert (await api.get(path)).json() == src
        assert (await api.get(path, headers={'x-user-id': '8'})).status_code == 404
        newer = copy.deepcopy(src); newer['sequence'] += 1
        item = newer['segments'][0]; item['revision'] += 1; item['text'] = item['raw_text']
        item['history'].append({'revision': item['revision'], 'text': item['text'], 'kind': 'restore', 'at': '2026-10-24T00:00:00Z'})
        rehash(newer)
        assert (await api.put(path, json={'expected_revision': 0, 'snapshot': newer})).status_code == 409
        assert (await api.put(path, json={'expected_revision': src['sequence'], 'snapshot': newer})).json() == newer
        assert (await api.put(path, json={'expected_revision': newer['sequence'], 'snapshot': src})).status_code == 409
        rewritten = copy.deepcopy(newer); rewritten['sequence'] += 1; rewritten['segments'][0]['raw_text'] = 'tampered raw'; rehash(rewritten)
        assert (await api.put(path, json={'expected_revision': newer['sequence'], 'snapshot': rewritten})).status_code in (409, 422)
        assert store._meetings[mid]['segments']['bot-one']['text'] == 'Bot authority'
        public = (await api.get(f'/transcripts/by-id/{mid}')).json()
        assert 'stt_replicas' not in public['data']
        await store.prepare_completed_artifact_deletion(7, mid)
        await store.finalize_completed_artifact_deletion(7, mid)
        assert (await api.get(path)).status_code == 404


@pytest.mark.asyncio
async def test_bot_export_anchors_normalized_samples_to_the_original_recording(monkeypatch):
    api, store, _, _, _ = await fixture(monkeypatch)
    async with api:
        path = '/transcripts/by-id/1/foundation'
        first = (await api.get(path)).json(); validate(first)
        assert (await api.get(path)).json() == first
        assert first['authority']['system'] == 'meeting-api'
        assert first['segments'][0]['audio'][0]['start_sample'] == 8000
        assert first['sources'][0]['clock_quality'] == 'decoded'
        assert (await api.get(path, headers={'x-user-id': '8'})).status_code == 404
        store._meetings[1]['status'] = 'active'
        assert (await api.get(path)).status_code == 409
