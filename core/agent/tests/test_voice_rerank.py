"""Optional reranking cannot invent evidence, lose heard context or weaken final review."""
import json
from types import SimpleNamespace

import pytest

from shared.voice_rerank import rerank_voice_sources, RERANK_SYSTEM
from shared.meeting_knowledge import PREFIX
from shared.voice_knowledge import VERIFY_SYSTEM


def sources():
    return [{'id': f's{i}', 'key': f'key-{i}', 'quote': f'Synthetic excerpt {i}.',
             'fingerprint': str(i) * 64} for i in range(20)]


def test_rerank_keeps_original_objects_stable_ids_recent_speech_and_heard_context():
    rows = sources()
    history = [{'question': 'Demo?', 'answer': 'Lan.', 'source_ids': ['s3']}]
    def complete(raw):
        assert json.loads(raw)['history'] == history
        return '{"source_ids":["s8","s2"]}'
    selected, outcome = rerank_voice_sources('Deadline?', rows, history, ['s19'], complete)
    assert outcome == 'applied'
    assert [s['id'] for s in selected] == ['s8', 's2', 's3', 's19']
    assert selected[0] is rows[8] and len(rows) == 20


@pytest.mark.parametrize('raw', ['not JSON', '{"source_ids":["s999"]}',
    '{"source_ids":["s1","s1"]}', '{"source_ids":[]}', '{"source_ids":[{}]}',
    '{"source_ids":["s1"],"claims":["invented"]}'])
def test_invalid_ranking_keeps_complete_original_retrieval(raw):
    rows = sources()
    selected, outcome = rerank_voice_sources('Q?', rows, [], [], lambda _: raw)
    assert outcome == 'fallback' and selected is rows


def test_timeout_and_excess_protected_context_keep_original_and_small_inputs_skip_llm():
    rows = sources()
    def fail(_): raise TimeoutError('private provider message')
    assert rerank_voice_sources('Q?', rows, [], [], fail) == (rows, 'fallback')
    assert rerank_voice_sources('Q?', rows[:2], [], [], fail) == (rows[:2], 'skipped')
    long = [s | {'quote': 'x' * 1200} for s in rows + [
        {'id': f'extra{i}', 'key': f'extra{i}'} for i in range(13)]]
    selected, outcome = rerank_voice_sources('Q?', long, [], [s['id'] for s in long], lambda _: '{"source_ids":["s0"]}')
    assert selected is long and outcome == 'fallback'


def test_worker_generates_from_ranked_sources_but_verifies_against_all_original_evidence(monkeypatch):
    from worker import engine
    from shared.voice_knowledge import VOICE_REPAIR_SYSTEM
    rows = sources()
    rows[8]['quote'] = 'Lan owns demo.'
    rows[19]['quote'] = 'Correction: Minh owns demo.'
    events, seen = [], []
    monkeypatch.setenv('TINA_CHAT_SESSION', 'meeting-knowledge-rerank-test')
    def complete(prompt, *, system):
        body = json.loads(prompt); seen.append((system, body))
        if system == RERANK_SYSTEM: return SimpleNamespace(text='{"source_ids":["s8"]}')
        if system == VERIFY_SYSTEM:
            assert body['sources'] == rows
            return SimpleNamespace(text='{"approved":false,"reason":"contradiction"}')
        if system == VOICE_REPAIR_SYSTEM: return SimpleNamespace(text='{"claims":[]}')
        assert [s['id'] for s in body['sources']] == ['s8']
        return SimpleNamespace(text='{"claims":[{"text":"Lan owns demo.","source_ids":["s8"]}]}')
    monkeypatch.setattr(engine, 'completion_from_env', lambda **_: SimpleNamespace(complete=complete))
    stream = SimpleNamespace(xadd=lambda _, e: events.append(json.loads(e['event'])), expire=lambda *_: None)
    source = {'mode': 'voice', 'question': 'Who owns demo?', 'sources': rows}
    engine._run_meeting_knowledge(stream, 'synthetic', {'entrypoint': {'inline': PREFIX + json.dumps({
        'request_id': 'rerank-test', 'text': json.dumps(source)})}})
    result = json.loads(events[0]['text'])
    assert not result['claims'] and result['verification'] == ['contradiction']
    assert sum(system == RERANK_SYSTEM for system, _ in seen) == 1
