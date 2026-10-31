import json
import time
from uuid import uuid4

import pytest

from llm.ports import CompletionResult
from shared.units import CANONICAL_NOTES_PREFIX
from worker.processed_notes import run
from control_plane.processed_notes import dispatch_request


def job():
    return {'meeting_id': 42, 'user_id': 7, 'platform': 'google_meet', 'lease_until': time.time()+180,
            'source': {'window_id': 'window', 'fingerprint': 'a'*64, 'canonical_revision': 3,
                       'generation': str(uuid4()), 'evidence': [{'segment_id': 'a', 'revision': 2,
                       'start_ms': 1000, 'end_ms': 2000, 'speaker_id': 'person', 'speaker_name': 'Alice',
                       'quote': 'Tôi sẽ gửi API report.'}]}}


def test_dispatch_uses_the_meeting_owner_and_redactable_private_payload(monkeypatch):
    import hmac, hashlib
    monkeypatch.setenv('TINA_INTERNAL_API_SECRET', 'private-test')
    class Dispatcher:
        def dispatch(self, invocation, *, trusted_canonical_notes=False):
            self.invocation = invocation
            self.trusted_canonical_notes = trusted_canonical_notes
            return 'unit'
    dispatcher = Dispatcher()
    source = job()
    source['proof'] = hmac.new(b'private-test', json.dumps(source, sort_keys=True, ensure_ascii=False,
        separators=(',', ':')).encode(), hashlib.sha256).hexdigest()
    dispatch_request(dispatcher, source, validate_lease=lambda job: True)
    assert dispatcher.invocation['identity']['subject'] == '7'
    assert dispatcher.invocation['trigger'] == 'transcription'
    assert dispatcher.trusted_canonical_notes is True
    from shared.units import is_private_transcript_job
    assert is_private_transcript_job(dispatcher.invocation)
    previous = dispatcher.invocation
    assert dispatch_request(dispatcher, source, validate_lease=lambda job: False) is None
    assert dispatcher.invocation is previous
    import pytest
    source['user_id'] = 99
    with pytest.raises(ValueError, match='proof'):
        dispatch_request(dispatcher, source, validate_lease=lambda job: True)


def test_worker_calls_completion_with_canonical_text_and_produces_no_public_notes(tmp_path, monkeypatch):
    monkeypatch.setenv('TINA_LLM_MODEL', 'chosen-model')
    monkeypatch.setenv('TINA_OWNER', '7')
    class Completion:
        def complete(self, prompt, **kwargs):
            self.prompt = prompt
            assert 'Tôi sẽ gửi API report.' in prompt
            assert kwargs['model'] == 'chosen-model'
            return CompletionResult(text=json.dumps({'notes': [{'id': 'a', 'text': 'Tôi sẽ gửi API report.', 'speaker': 'wrong guess'}]}), model='chosen-model')
    class Stream:
        def __init__(self): self.rows = []
        def xadd(self, key, fields): self.rows.append((key, fields))
    stream = Stream(); source = job()
    completion = Completion()
    result = run(stream, tmp_path, CANONICAL_NOTES_PREFIX+json.dumps(source), completion=completion)
    assert result['source'] == source['source'] and result['notes'][0]['id'] == 'a'
    assert all(key == 'canonical_notes_results' for key, _ in stream.rows)
    assert result['params']['model'] == 'chosen-model'
    import hashlib
    assert result['params']['prompt_sha256'] == hashlib.sha256(completion.prompt.encode()).hexdigest()


def test_provider_failure_is_not_reported_as_fresh_notes(tmp_path, monkeypatch):
    monkeypatch.setenv("TINA_OWNER", "7")

    class Completion:
        def complete(self, *args, **kwargs): raise RuntimeError('private source / credential must not leak')
    class Stream:
        def xadd(self, key, fields): self.fields = fields
    stream = Stream()
    result = run(stream, tmp_path, CANONICAL_NOTES_PREFIX+json.dumps(job()), completion=Completion())
    assert 'error' in result and 'notes' not in result
    assert 'credential' not in result['error']


def test_worker_refuses_canonical_job_for_a_different_owner(tmp_path, monkeypatch):
    monkeypatch.setenv("TINA_OWNER", "17")

    class Completion:
        def complete(self, *_args, **_kwargs):
            pytest.fail("mismatched canonical owner must be rejected before model execution")

    class Stream:
        def __init__(self):
            self.rows = []

        def xadd(self, key, fields):
            self.rows.append((key, fields))

    payload = job()
    payload["user_id"] = 23
    stream = Stream()

    with pytest.raises(ValueError, match="owner"):
        run(stream, tmp_path, CANONICAL_NOTES_PREFIX + json.dumps(payload), completion=Completion())

    assert stream.rows == []
