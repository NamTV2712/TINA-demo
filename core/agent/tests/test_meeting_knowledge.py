import json
from copy import deepcopy

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from control_plane import meeting_knowledge as api
from control_plane.workspace_reader import WorkspaceReader
from shared.meeting_knowledge import select_sources, sources_for, stale, validate_answer


@pytest.fixture
def setup(tmp_path, monkeypatch):
    base = tmp_path / 'owner'
    base.mkdir()
    (base / 'kg/entities/meeting').mkdir(parents=True)
    doc = base / 'kg/entities/meeting/abc.md'
    doc.write_text('# Demo\n\nNgày ra mắt là 15/11.')
    canonical = {'segments': [{'segment_id': 'seg-1', 'revision': 0, 'text': 'Minh sẽ gửi demo.',
                               'speaker_name': 'Lan', 'speaker_revision': 0, 'start_ms': 12000, 'end_ms': 15000}]}
    calls = []
    def fetch(_base, subject, mid, path):
        if subject != 'owner' or mid != 1:
            raise HTTPException(404, 'Meeting unavailable')
        if path.endswith('/canonical'): return deepcopy(canonical)
        if path.endswith('/memory'):
            seg = canonical['segments'][0] if canonical['segments'] else None
            return {'facts': [{'id': '00000000-0000-0000-0000-000000000001', 'type': 'action_item',
                              'text': seg['text'], 'evidence': [{k: seg[k] for k in ('segment_id', 'revision', 'speaker_name', 'start_ms', 'end_ms')} | {'quote': seg['text']}]}] if seg else []}
        return {'native_meeting_id': 'abc'}
    def complete(_request, raw):
        payload = json.loads(raw)
        calls.append(payload)
        return json.dumps({'claims': [{'text': 'Minh gửi demo.', 'source_ids': [payload['sources'][0]['id']]}]})
    monkeypatch.setattr(api, 'meeting_get', fetch)
    app = FastAPI()
    api.register(app, lambda request: request.headers.get('x-user-id', 'owner'),
                 lambda _request, _slug: base, WorkspaceReader(str(tmp_path)), '', complete)
    return TestClient(app), canonical, base, calls


ROOT = '/api/workspace/meeting-knowledge/1'


def test_question_citations_and_explicit_create_only_apply(setup):
    client, _, base, calls = setup
    answer = client.post(ROOT + '/ask', json={'question': 'Ai gửi demo?'}).json()
    assert answer['sources'][0]['quote'] == 'Minh sẽ gửi demo.'
    assert calls[0]['sources'][0]['segment_id'] == 'seg-1'
    assert not (base / 'wiki').exists()
    url = ROOT + f'/answers/{answer["id"]}/apply'
    response = client.post(url)
    assert response.status_code == 200
    page = base / response.json()['path']
    assert 'revision 0' in page.read_text()
    assert 'Fingerprint:' in page.read_text()
    assert client.post(url).status_code == 200
    page.write_text('User edit')
    assert client.post(url).status_code == 409
    assert page.read_text() == 'User edit'


@pytest.mark.parametrize('field,value', [('text', 'Restored original'), ('revision', 1),
                                        ('speaker_name', 'Minh'), ('start_ms', 13000)])
def test_edits_restore_rename_and_timing_invalidate_answer(setup, field, value):
    client, canonical, _, _ = setup
    answer = client.post(ROOT + '/ask', json={'question': 'Ai gửi demo?'}).json()
    canonical['segments'][0][field] = value
    assert client.get(ROOT).json()['answers'][0]['stale'] is True
    assert client.post(ROOT + f'/answers/{answer["id"]}/apply').status_code == 409


def test_missing_source_is_stale_but_unrelated_new_segment_is_not(setup):
    client, canonical, _, _ = setup
    client.post(ROOT + '/ask', json={'question': 'Ai gửi demo?'})
    canonical['segments'].append(dict(canonical['segments'][0], segment_id='new'))
    assert client.get(ROOT).json()['answers'][0]['stale'] is False
    canonical['segments'] = []
    assert client.get(ROOT).json()['answers'][0]['stale'] is True


def test_owner_check_and_document_allowlist(setup):
    client, _, _, calls = setup
    assert client.get(ROOT, headers={'x-user-id': 'stranger'}).status_code == 404
    assert client.post(ROOT + '/ask', json={'question': 'x', 'documents': ['../../secret']}).status_code == 422
    assert client.post(ROOT + '/ask', json={'question': '  '}).status_code == 422
    assert not calls


def test_document_edits_and_symlink_escape(setup, tmp_path):
    client, _, base, _ = setup
    answer = client.post(ROOT + '/ask', json={'question': 'Ngày ra mắt?', 'documents': ['kg/entities/meeting/abc.md']}).json()
    (base / 'kg/entities/meeting/abc.md').write_text('Ngày khác')
    assert client.post(ROOT + f'/answers/{answer["id"]}/apply').status_code == 409
    (base / 'wiki').symlink_to(tmp_path)
    answer = client.post(ROOT + '/ask', json={'question': 'Ai gửi demo?'}).json()
    assert client.post(ROOT + f'/answers/{answer["id"]}/apply').status_code == 409


def test_model_cannot_invent_source_ids_and_retrieval_is_bounded():
    selected = select_sources(sources_for({'segments': [dict(segment_id=str(i), text='demo ' * 600)
                                                     for i in range(100)]}, {}), 'demo')
    assert len(selected) <= 40 and sum(len(s['quote']) for s in selected) <= 48000
    with pytest.raises(ValueError):
        validate_answer('{"claims":[{"text":"invented","source_ids":["fake"]}]}', selected)
    assert validate_answer('{"claims":[]}', selected) == {'claims': [], 'sources': []}


def test_isolated_worker_and_private_dispatch_use_completion_only(monkeypatch):
    from llm.ports import CompletionResult
    from shared import units
    from worker import engine
    source = select_sources(sources_for({'segments': [dict(segment_id='a', text='Minh gửi demo.')]}, {}), 'demo')
    text = json.dumps({'question': 'Ai gửi demo?', 'sources': source})
    payload = json.dumps({'request_id': 'request', 'text': text})
    inv = units.make_dispatch(subject='owner', trigger='message',
                             start=units.entrypoint(inline=units.MEETING_KNOWLEDGE_PREFIX + payload),
                             workspaces=[{'id': 'owner', 'mode': 'ro'}],
                             context={'kind': 'none', 'session': 'meeting-knowledge-request'})
    assert units.is_meeting_knowledge(inv) and units.is_private_transcript_job(inv)
    assert inv['workspaces'] == [{'id': 'owner', 'mode': 'ro'}]
    class Completion:
        def complete(self, prompt, **kwargs):
            assert prompt == text and 'untrusted' in kwargs['system']
            return CompletionResult(text='{"claims":[{"text":"Minh","source_ids":["s0"]}]}')
    class Stream:
        def __init__(self): self.events = []
        def xadd(self, _topic, fields): self.events.append(json.loads(fields['event']))
        def expire(self, *_args): pass
    monkeypatch.setenv('TINA_CHAT_SESSION', 'meeting-knowledge-request')
    monkeypatch.setattr(engine, 'completion_from_env', lambda **kwargs: Completion())
    stream = Stream()
    engine._run_meeting_knowledge(stream, 'private-output', inv['start'])
    assert stream.events[0]['type'] == 'message-delta'
    assert stream.events[-1]['type'] == 'turn-complete'
    monkeypatch.setenv('TINA_CHAT_SESSION', 'different-request')
    stream.events.clear()
    engine._run_meeting_knowledge(stream, 'private-output', inv['start'])
    assert stream.events == [{'type': 'turn-complete'}]


def test_review_is_explicit_revision_safe_and_invalidated_by_evidence(setup):
    client, canonical, base, _ = setup
    item = client.get(ROOT).json()['facts'][0]
    body = {'fact_id': item['fact']['id'], 'expected_fingerprint': item['fingerprint'],
            'expected_revision': 0, 'status': 'approved', 'text': 'Minh gửi demo.'}
    result = client.post(ROOT + '/facts/review', json=body)
    assert result.status_code == 200 and result.json()['revision'] == 1
    assert canonical['segments'][0]['text'] == 'Minh sẽ gửi demo.'
    assert client.post(ROOT + '/facts/review', json=body).status_code == 409
    assert client.post(ROOT + '/facts/review', json=body | {'expected_revision': 1, 'status': 'discarded'}).json()['status'] == 'discarded'
    canonical['segments'][0]['speaker_name'] = 'Changed'
    assert client.get(ROOT).json()['facts'][0]['stale'] is True
    assert client.post(ROOT + '/facts/review', json=body | {'expected_revision': 2}).status_code == 409
