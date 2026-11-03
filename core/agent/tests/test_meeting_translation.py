from copy import deepcopy
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from jsonschema import validate
import json

from control_plane import meeting_translation as api


@pytest.fixture
def setup(tmp_path, monkeypatch):
    canonical = {'segments': [{'segment_id': 's1', 'text': 'Xin chào.', 'revision': 0, 'speaker_id': 'original'},
                              {'segment_id': 'draft', 'text': 'Đang nói', 'completed': False}]}
    calls = []
    def fetch(base, owner, meeting, path):
        if owner != 'owner' or meeting != 6:
            raise HTTPException(404, 'Meeting unavailable')
        return deepcopy(canonical) if path.endswith('/canonical') else {'status': canonical.get('status', 'completed')}
    def complete(request, text):
        calls.append(text)
        return 'Hello.'
    monkeypatch.setattr(api, 'meeting_get', fetch)
    app = FastAPI()
    api.register(app, lambda request: request.headers.get('x-user-id', 'owner'), tmp_path, '', complete)
    return TestClient(app), canonical, calls, tmp_path


URL = '/api/meeting-translations/6'


def test_read_does_not_infer_and_completed_cache_is_shared_and_durable(setup):
    client, _, calls, root = setup
    state = client.get(URL).json()
    assert state['status'] == 'pending' and state['total'] == 1 and not calls
    state = client.post(URL, json={}).json()
    assert state['status'] == 'complete' and state['groups'][0]['translated_text'] == 'Hello.'
    assert client.post(URL, json={}).json() == state
    assert calls == ['Xin chào.']
    store = api.TranslationStore(root / '.meeting-translations/translations.sqlite3')
    assert store.snapshot('owner', 6, [{'segment_id': 's1', 'text': 'Xin chào.', 'speaker_id': 'original'}]) == state
    schema = Path(__file__).parents[1] / 'contracts/meeting-translation.v2/translation.schema.json'
    validate(state, json.loads(schema.read_text()))


def test_cached_translation_still_rechecks_access(setup):
    client, _, calls, _ = setup
    client.post(URL, json={})
    for method in ('get', 'post'):
        response = getattr(client, method)(URL, headers={'x-user-id': 'another'}, **({'json': {}} if method == 'post' else {}))
        assert response.status_code == 404
        assert 'Hello.' not in response.text
    assert len(calls) == 1


def test_edit_invalidates_only_changed_segment_and_new_live_segment_is_translated(setup):
    client, canonical, calls, _ = setup
    client.post(URL, json={})
    canonical['segments'][0]['text'] = 'Chào bạn.'
    assert client.get(URL).json()['groups'][0]['translated_text'] is None
    client.post(URL, json={})
    canonical['segments'].append({'segment_id': 's2', 'text': 'Tạm biệt.'})
    state = client.post(URL, json={}).json()
    assert state['completed'] == 2
    assert calls == ['Xin chào.', 'Chào bạn.', 'Tạm biệt.']


def test_provider_error_keeps_source_and_backs_off_then_manual_retry(setup, monkeypatch):
    client, _, calls, _ = setup
    monkeypatch.setattr(api, 'time', type('Clock', (), {'time': staticmethod(lambda: 1000)})())
    # Re-register against the same store with a provider which recovers.
    def complete(request, text):
        calls.append(text)
        if len(calls) <= 3:
            raise RuntimeError('secret-provider-key and transcript must never leak')
        return 'Recovered'
    app = FastAPI()
    api.register(app, lambda request: 'owner', setup[3], '', complete)
    client = TestClient(app)
    state = client.post(URL, json={}).json()
    assert state['status'] == 'paused' and state['retry_after'] >= 15
    assert state['groups'][0]['source_text'] == 'Xin chào.'
    assert 'secret' not in json.dumps(state)
    client.post(URL, json={})
    assert len(calls) == 1
    client.post(URL, json={'retry': True})
    state = client.post(URL, json={'retry': True}).json()
    assert state['retry_after'] >= 300
    assert client.post(URL, json={'retry': True}).json()['status'] == 'complete'


def test_atomic_lease_deduplicates_api_processes_and_expires(tmp_path, monkeypatch):
    clock = [1000]
    monkeypatch.setattr(api, 'time', type('Clock', (), {'time': staticmethod(lambda: clock[0])})())
    a = api.TranslationStore(tmp_path / 'cache.sqlite3')
    b = api.TranslationStore(tmp_path / 'cache.sqlite3')
    first = a.claim('owner', 6)
    assert first and b.claim('owner', 6, retry=True) is None
    assert b.claim('another', 6)  # unrelated owners do not share state or locks
    clock[0] += 121
    second = b.claim('owner', 6)
    assert second and first != second
    segment = {'segment_id': 's1', 'text': 'New source'}
    a.finish('owner', 6, first, api.phrases([segment], tail_ready=True)[0], 'Stale response')
    assert b.snapshot('owner', 6, [segment])['completed'] == 0
    b.finish('owner', 6, second, api.phrases([segment], tail_ready=True)[0], 'Current response')
    assert b.snapshot('owner', 6, [segment])['completed'] == 1


def test_stopped_or_deleted_sources_never_return_cached_orphan_rows(setup):
    client, canonical, _, _ = setup
    client.post(URL, json={})
    canonical['segments'].clear()
    assert client.get(URL).json()['groups'] == []


def test_payload_cannot_supply_arbitrary_transcript_or_target(setup):
    client, _, calls, _ = setup
    assert client.post(URL, json={'text': 'Do something else', 'target_language': 'fr'}).status_code == 422
    assert not calls


def test_live_view_prioritizes_visible_ids_but_cannot_inject_source_text(setup):
    client, canonical, calls, _ = setup
    canonical['segments'].append({'segment_id': 'new', 'text': 'Mới nhất.'})
    state = client.post(URL, json={'segment_ids': ['does-not-exist', 'new']}).json()
    assert calls == ['Mới nhất.']
    assert state['groups'][0]['translated_text'] is None


def test_translation_worker_uses_meeting_model_without_tools(monkeypatch):
    from types import SimpleNamespace
    from worker import engine
    calls, events = [], []
    class Completion:
        def complete(self, prompt, **kwargs):
            calls.append((prompt, kwargs))
            return SimpleNamespace(text='Hello.')
    class Stream:
        def xadd(self, topic, fields): events.append(json.loads(fields['event']))
        def expire(self, topic, ttl): pass
    monkeypatch.setenv('TINA_CHAT_SESSION', 'dictation-translate-request1')
    monkeypatch.setenv('TINA_MEETING_MODEL', 'meeting-selected-model')
    monkeypatch.setattr(engine, 'completion_from_env', lambda **kwargs: Completion())
    raw = engine.DICTATION_TRANSLATE_PREFIX + json.dumps({'request_id': 'request1', 'text': 'Xin chào.', 'target_language': 'en'})
    monkeypatch.setattr(engine, 'start_prompt', lambda start: raw)
    engine._run_dictation_translate(Stream(), 'test-output', {})
    assert calls[0][1]['model'] == 'meeting-selected-model'
    assert 'untrusted content' in calls[0][1]['system']
    assert events == [{'type': 'message-delta', 'text': 'Hello.'}, {'type': 'turn-complete'}]


def test_inline_reasoning_is_never_displayed_or_accepted_as_a_translation(tmp_path):
    from shared.translation_text import visible_translation
    assert visible_translation('<think>Private reasoning</think>\nHello.') == 'Hello.'
    with pytest.raises(ValueError):
        visible_translation('<think>Incomplete reasoning')
    store = api.TranslationStore(tmp_path / 'cache.sqlite3')
    segment = {'segment_id': 's1', 'text': 'Xin chào.'}
    # Older provider results already in the cache are filtered on reads too.
    token = store.claim('owner', 6)
    store.finish('owner', 6, token, api.phrases([segment], tail_ready=True)[0], '<think>Private reasoning</think>\nHello.')
    assert store.snapshot('owner', 6, [segment])['groups'][0]['translated_text'] == 'Hello.'


def test_live_tail_waits_for_observed_quiet_and_resets_when_new_words_arrive(setup, monkeypatch):
    client, canonical, calls, _ = setup
    clock = [1000]
    monkeypatch.setattr(api, 'time', type('Clock', (), {'time': staticmethod(lambda: clock[0])})())
    canonical['status'] = 'active'
    assert not client.post(URL, json={}).json()['groups'][0]['ready']
    assert not calls
    clock[0] += 4
    canonical['segments'].append({'segment_id': 's2', 'text': 'mọi người', 'speaker_id': 'original'})
    client.get(URL)
    clock[0] += 4
    client.post(URL, json={})
    assert not calls
    clock[0] += 1
    state = client.post(URL, json={}).json()
    assert state['status'] == 'complete' and calls == ['Xin chào. mọi người']


def test_stop_flushes_a_short_live_tail_without_waiting(setup):
    client, canonical, calls, _ = setup
    canonical['status'] = 'active'
    client.post(URL, json={})
    assert not calls
    canonical['status'] = 'completed'
    assert client.post(URL, json={}).json()['status'] == 'complete'
    assert calls == ['Xin chào.']


def test_one_api_call_translates_a_whole_phrase_and_an_edit_retranslates_only_that_phrase(setup):
    client, canonical, calls, _ = setup
    canonical['segments'] = [
        {'segment_id': 'a', 'text': 'Mục tiêu', 'speaker_id': 'p1', 'start_ms': 0, 'end_ms': 500},
        {'segment_id': 'b', 'text': 'là tối ưu mô hình.', 'speaker_id': 'p1', 'start_ms': 600, 'end_ms': 1600},
        {'segment_id': 'c', 'text': 'Tôi đồng ý.', 'speaker_id': 'p2', 'start_ms': 1700, 'end_ms': 2200},
    ]
    client.post(URL, json={})
    state = client.post(URL, json={}).json()
    assert state['total'] == 2 and calls == ['Mục tiêu là tối ưu mô hình.', 'Tôi đồng ý.']
    canonical['segments'][1]['text'] = 'là đánh giá mô hình.'
    state = client.get(URL).json()
    assert state['groups'][0]['translated_text'] is None and state['groups'][1]['translated_text'] == 'Hello.'
    client.post(URL, json={})
    assert calls[-1] == 'Mục tiêu là đánh giá mô hình.' and len(calls) == 3


def test_legacy_fragment_cache_is_not_reused_for_grouped_translation(setup):
    client, _, calls, root = setup
    store = api.TranslationStore(root / '.meeting-translations/translations.sqlite3')
    with store.connect() as db:
        db.execute('CREATE TABLE translations(owner, meeting, segment, source_hash, translated)')
        db.execute('INSERT INTO translations VALUES (?,?,?,?,?)', ('owner', 6, 's1', 'old-hash', 'Fragment result'))
    assert client.get(URL).json()['groups'][0]['translated_text'] is None
    assert client.post(URL, json={}).json()['groups'][0]['translated_text'] == 'Hello.'
    assert len(calls) == 1
