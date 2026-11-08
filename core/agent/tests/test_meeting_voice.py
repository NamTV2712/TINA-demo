import json
from copy import deepcopy

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from control_plane import meeting_knowledge as api
from control_plane.workspace_reader import WorkspaceReader


@pytest.fixture
def voice(tmp_path, monkeypatch):
    root = tmp_path / '7'; root.mkdir()
    (root / 'wiki').mkdir()
    (root / 'wiki/shared.md').write_text('The approved budget is 100.')
    (root / 'wiki/private.md').write_text('PRIVATE WORKSPACE SECRET')
    policy = {'enabled': True, 'include_transcript': False, 'documents': ['wiki/shared.md'], 'revision': 1}
    row = {'id': 1, 'user_id': 7, 'status': 'active', 'platform': 'google_meet',
           'native_meeting_id': 'abc', 'data': {'voice_assistant': policy, 'docs': [{'path': 'wiki/shared.md'}]}}
    canonical = {'segments': [{'segment_id': 'seg1', 'text': 'PRIVATE TRANSCRIPT', 'revision': 0}]}
    prompts, mutate = [], [None]
    def meeting_get(base, subject, mid, path):
        if subject != '7' or mid != 1: raise HTTPException(404)
        return deepcopy(canonical if path.endswith('/canonical') else row)
    def complete(request, raw):
        prompts.append(json.loads(raw))
        if mutate[0]: mutate[0]()
        return json.dumps({'claims': [{'text': 'The budget is 100.', 'source_ids': ['s0']}]})
    monkeypatch.setenv('TINA_INTERNAL_API_SECRET', 'test-internal')
    monkeypatch.setattr(api, 'meeting_get', meeting_get)
    app = FastAPI()
    api.register(app, lambda r: r.headers['x-user-id'], lambda r, slug: root,
                 WorkspaceReader(str(tmp_path)), 'http://meeting.test', complete)
    return TestClient(app), row, root, prompts, mutate


HEADERS = {'X-Internal-Secret': 'test-internal', 'X-User-Id': '7'}
URL = '/api/internal/meeting-voice/1/answer'


def test_only_explicit_shared_sources_enter_voice_prompt(voice):
    client, row, root, prompts, mutate = voice
    response = client.post(URL, headers=HEADERS, json={'question': 'Budget?', 'revision': 1})
    assert response.status_code == 200, response.text
    assert response.json()['text'] == 'The budget is 100.'
    encoded = json.dumps(prompts)
    assert 'PRIVATE TRANSCRIPT' not in encoded and 'PRIVATE WORKSPACE SECRET' not in encoded
    assert all(s['path'] == 'wiki/shared.md' for s in prompts[0]['sources'])
    assert not (root / '.meeting-knowledge').exists()


def test_missing_internal_secret_or_substituted_owner_is_denied(voice):
    client, *_ = voice
    assert client.post(URL, headers={'X-User-Id': '7'}, json={'question': 'Budget?', 'revision': 1}).status_code == 401
    assert client.post(URL, headers=HEADERS | {'X-User-Id': '8'}, json={'question': 'Budget?', 'revision': 1}).status_code == 404
    assert client.post(URL, headers=HEADERS, json={'question': 'Budget?', 'revision': 1, 'documents': ['wiki/private.md']}).status_code == 422


@pytest.mark.parametrize('change', ['source', 'policy'])
def test_revoked_or_changed_evidence_is_not_spoken(voice, change):
    client, row, root, prompts, mutate = voice
    mutate[0] = (lambda: (root / 'wiki/shared.md').write_text('Budget changed.')) if change == 'source' else lambda: row['data']['voice_assistant'].update(enabled=False, revision=2)
    assert client.post(URL, headers=HEADERS, json={'question': 'Budget?', 'revision': 1}).status_code == 409


def test_voice_payload_has_recent_context_and_rejects_revoked_history(voice):
    import time
    from shared.meeting_knowledge import sources_for
    client, row, root, prompts, _ = voice
    now = int(time.time() * 1000)
    source = sources_for({'segments': []}, {'wiki/shared.md': 'The approved budget is 100.'})[0]
    history = [{'question': 'Budget?', 'answer': 'The budget is 100.', 'created_at_ms': now - 1000,
                'sources': [{k: source[k] for k in ('key', 'fingerprint')}]}]
    response = client.post(URL, headers=HEADERS, json={'question': 'What about it?', 'revision': 1, 'history': history})
    assert response.status_code == 200
    assert prompts[-1]['mode'] == 'voice' and prompts[-1]['history'][0]['answer'] == 'The budget is 100.'
    assert 'PRIVATE TRANSCRIPT' not in json.dumps(prompts[-1])
    history[0]['sources'][0]['fingerprint'] = '0' * 64
    response = client.post(URL, headers=HEADERS, json={'question': 'Budget?', 'revision': 1, 'history': history})
    assert response.status_code == 200 and not prompts[-1]['history']


def test_short_answer_to_a_recent_clarification_keeps_its_topic_but_expired_question_is_not_pending(voice):
    import time
    from shared.meeting_knowledge import sources_for
    client, _, _, prompts, _ = voice
    now=int(time.time()*1000)
    source=sources_for({'segments':[]},{'wiki/shared.md':'The approved budget is 100.'})[0]
    history=[{'question':'Budget?', 'answer':'Demo or production?', 'clarification':True,
              'created_at_ms':now-1000,'sources':[{k:source[k] for k in ('key','fingerprint')}]}]
    r=client.post(URL,headers=HEADERS,json={'question':'Production.', 'revision':1,'history':history})
    assert r.status_code==200 and prompts[-1]['history'][0]['clarification'] is True
    assert prompts[-1]['history'][0]['question']=='Budget?'
    history[0]['created_at_ms']=now-31000
    r=client.post(URL,headers=HEADERS,json={'question':'Budget?', 'revision':1,'history':history})
    assert r.status_code==200 and prompts[-1]['history'][0]['clarification'] is False


def test_clarification_is_spoken_but_rechecks_all_context_sources(voice, monkeypatch):
    client, row, root, prompts, mutate = voice
    def complete(request, raw):
        prompts.append(json.loads(raw))
        if mutate[0]: mutate[0]()
        return json.dumps({'claims': [], 'clarification': 'Bạn hỏi ngân sách demo hay ngân sách triển khai?'})
    # Re-register with the same owner/source fixture and a clarification-only completion.
    app = FastAPI()
    api.register(app, lambda r: r.headers['x-user-id'], lambda r, slug: root,
                 WorkspaceReader(str(root.parent)), 'http://meeting.test', complete)
    scoped = TestClient(app)
    r = scoped.post(URL, headers=HEADERS, json={'question': 'Budget?', 'revision': 1})
    assert r.status_code == 200 and r.json()['text'].endswith('?') and r.json()['sources'] == []
    mutate[0] = lambda: (root / 'wiki/shared.md').write_text('Changed budget information')
    assert scoped.post(URL, headers=HEADERS, json={'question': 'Budget?', 'revision': 1}).status_code == 409


def test_worker_selects_voice_prompt_and_validates_clarification(monkeypatch):
    from llm.ports import CompletionResult
    from shared.meeting_knowledge import PREFIX
    from shared.voice_knowledge import VOICE_SYSTEM, VERIFY_SYSTEM
    from worker import engine
    captured = []
    class Completion:
        def complete(self, prompt, **kwargs):
            captured.append(kwargs['system'])
            if kwargs['system'] == VERIFY_SYSTEM: return CompletionResult(text='{"approved":true}')
            return CompletionResult(text=json.dumps({'claims': [], 'clarification': 'Bạn hỏi việc nào?'}))
    class Stream:
        def __init__(self): self.events = []
        def xadd(self, _topic, fields): self.events.append(json.loads(fields['event']))
        def expire(self, *_): pass
    monkeypatch.setenv('TINA_CHAT_SESSION', 'meeting-knowledge-voice')
    monkeypatch.setattr(engine, 'completion_from_env', lambda **_: Completion())
    payload = {'request_id': 'voice', 'text': json.dumps({'mode': 'voice', 'question': 'Việc đó?', 'sources': []})}
    stream = Stream()
    engine._run_meeting_knowledge(stream, 'private-output', {'entrypoint': {'inline': PREFIX + json.dumps(payload)}})
    assert captured == [VOICE_SYSTEM, VERIFY_SYSTEM]
    assert stream.events[0]['type'] == 'message-delta'
    assert json.loads(stream.events[0]['text'])['clarification'] == 'Bạn hỏi việc nào?'


def test_unrelated_source_edits_do_not_cancel_a_supported_factual_answer(voice):
    client, row, root, prompts, mutate = voice
    (root / 'wiki/shared.md').write_text('The approved budget is 100.\n\nA separate lunch discussion.')
    # The neighboring paragraph is context, but the answer cites only the budget paragraph.
    # Editing a paragraph changes the whole document fingerprint, so use a different linked file.
    (root / 'wiki/other.md').write_text('The budget review lunch is at noon.')
    row['data']['docs'].append({'path': 'wiki/other.md'})
    row['data']['voice_assistant']['documents'].append('wiki/other.md')
    mutate[0] = lambda: (root / 'wiki/other.md').write_text('The budget review lunch moved.')
    response = client.post(URL, headers=HEADERS, json={'question': 'Budget?', 'revision': 1})
    assert response.status_code == 200, response.text


def test_lookup_round_can_recover_a_semantic_miss_and_cannot_open_unapproved_paths(voice):
    client, row, root, prompts, mutate = voice
    def complete(request, raw):
        payload = json.loads(raw); prompts.append(payload)
        if payload['tools_remaining']:
            return json.dumps({'tool_calls': [{'name': 'search_shared_documents', 'query': 'budget'}]})
        return json.dumps({'claims': [{'text': 'The budget is 100.', 'source_ids': [payload['sources'][0]['id']]}]})
    app = FastAPI()
    api.register(app, lambda r: r.headers['x-user-id'], lambda r, slug: root,
                 WorkspaceReader(str(root.parent)), 'http://meeting.test', complete)
    response = TestClient(app).post(URL, headers=HEADERS, json={'question': 'How much can we spend?', 'revision': 1})
    assert response.status_code == 200 and response.json()['reason'] == 'answered'
    assert response.json()['lookups'] == [{'tool': 'search_shared_documents', 'source_count': 1}]
    assert prompts[0]['sources'] == [] and len(prompts[1]['sources']) == 1
    assert 'PRIVATE' not in json.dumps(prompts)


@pytest.mark.parametrize('kind,question,flag', [
    ('general', 'ASR là gì?', 'allow_general_knowledge'),
    ('web', 'Tìm trên web về Redis', 'allow_web_search'),
])
def test_public_routes_are_opt_in_and_never_send_room_sources_or_history(voice, kind, question, flag):
    client, row, root, prompts, mutate = voice
    assert client.post(URL, headers=HEADERS, json={'question': question, 'revision': 1}).json()['reason'] == kind + '_disabled'
    assert not prompts
    row['data']['voice_assistant'][flag] = True
    def complete(request, raw):
        payload = json.loads(raw); prompts.append(payload)
        return json.dumps({'text': 'A public explanation.', 'links': [{'url': 'https://redis.io/docs/', 'title': 'Redis'}]})
    app = FastAPI()
    api.register(app, lambda r: r.headers['x-user-id'], lambda r, slug: root,
                 WorkspaceReader(str(root.parent)), 'http://meeting.test', complete)
    response = TestClient(app).post(URL, headers=HEADERS, json={'question': question, 'revision': 1})
    assert response.status_code == 200 and response.json()['answer_kind'] == kind
    assert response.json()['reason'] == 'answered'
    assert set(prompts[-1]) == {'mode', 'question'}
    assert 'PRIVATE' not in json.dumps(prompts) and 'budget' not in json.dumps(prompts)


def test_diagnostics_distinguish_missing_sources_retrieval_and_model_failure(voice):
    client, row, root, prompts, mutate = voice
    assert client.post(URL, headers=HEADERS, json={'question': 'Spend?', 'revision': 1}).json()['reason'] == 'llm_unavailable'
    row['data']['voice_assistant']['documents'] = []
    assert client.post(URL, headers=HEADERS, json={'question': 'Spend?', 'revision': 1}).json()['reason'] == 'no_shared_sources'
