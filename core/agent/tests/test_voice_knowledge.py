import json

import pytest

from shared.meeting_knowledge import sources_for
from shared.voice_knowledge import voice_sources, current_history, validate_voice_answer

NOW = 1800000000000


def segment(identifier, text, end):
    return dict(segment_id=identifier, revision=0, text=text, start_ms=end - 1000, end_ms=end)


def test_voice_retrieval_reserves_recent_context_and_ranks_latest_relevant_evidence():
    rows = [segment(str(i), 'Chuyện khác không liên quan.', NOW - 500000 + i * 1000) for i in range(50)]
    rows += [segment('old', 'Deadline demo là thứ Sáu.', NOW - 200000),
             segment('new', 'Deadline demo đổi sang thứ Hai.', NOW - 20000),
             segment('neighbor', 'Lan phụ trách kiểm thử.', NOW - 19000)]
    sources = sources_for({'segments': rows}, {})
    selected, recent = voice_sources(sources, 'Deadline demo?', [], NOW)
    keys = [s['key'] for s in selected]
    assert keys.index('segment:new') < keys.index('segment:old')
    assert 'segment:neighbor' in keys
    assert {s['key'] for s in selected if s['id'] in recent} == {'segment:new', 'segment:neighbor'}
    assert len(selected) <= 32 and sum(len(s['quote']) for s in selected) <= 24000
    assert not any(s['quote'] == 'Chuyện khác không liên quan.' for s in selected)


def test_followup_uses_only_fresh_authorized_history_and_keeps_it_out_of_evidence():
    sources = sources_for({'segments': [segment('demo', 'Minh làm bản demo.', NOW - 300000)]}, {})
    refs = [{k: sources[0][k] for k in ('key', 'fingerprint')}]
    turn = {'question': 'Ai làm demo?', 'answer': 'Minh.', 'created_at_ms': NOW - 10000, 'sources': refs}
    history = current_history([turn], sources, NOW)
    selected, _ = voice_sources(sources, 'Vậy khi nào xong?', history, NOW)
    assert selected[0]['key'] == 'segment:demo'
    assert all(s['kind'] == 'transcript' and s['quote'] != turn['answer'] for s in selected)
    assert not current_history([turn], [], NOW)
    assert not current_history([turn | {'created_at_ms': NOW - 900001}], sources, NOW)
    changed = sources_for({'segments': [segment('demo', 'Lan làm demo.', NOW - 300000)]}, {})
    assert not current_history([turn], changed, NOW)
    assert not voice_sources(sources, 'Giá cà phê hôm nay?', [], NOW)[0]


def test_voice_output_allows_bounded_clarification_without_inventing_fact_citations():
    raw = json.dumps({'claims': [], 'clarification': 'Bạn hỏi bản demo hay bản chính thức?'})
    assert validate_voice_answer(raw, [])['clarification'].endswith('?')
    for body in [{'claims': [], 'clarification': 'Chắc chắn thứ Sáu.'},
                 {'claims': [], 'clarification': 'x' * 201 + '?'},
                 {'claims': [{'text': 'x', 'source_ids': ['invented']}]}]:
        with pytest.raises(ValueError): validate_voice_answer(json.dumps(body), [])
    sources = [{'id': 's0'}]
    for claims in [[{'text': 'x', 'source_ids': ['s0']}] * 4,
                   [{'text': 'x' * 801, 'source_ids': ['s0']}]]:
        with pytest.raises(ValueError): validate_voice_answer(json.dumps({'claims': claims}), sources)


def test_short_clarification_answer_retains_its_authorized_topic_without_turning_history_into_evidence():
    sources=sources_for({'segments':[segment('demo','Bản demo giao thứ Hai.',NOW-500000),
                                    segment('production','Bản production giao thứ Sáu.',NOW-490000)]},{})
    turn={'question':'Hạn bản nào?', 'answer':'Bạn hỏi demo hay production?', 'clarification':True,
          'created_at_ms':NOW-10000,'sources':[{k:s[k] for k in ('key','fingerprint')} for s in sources]}
    history=current_history([turn],sources,NOW)
    selected,_=voice_sources(sources,'Chính thức.',history,NOW)
    assert {s['key'] for s in selected}=={s['key'] for s in sources}
    assert all(s['quote'] not in [turn['question'],turn['answer']] for s in selected)
    assert not voice_sources(sources,'Chính thức.',[turn|{'created_at_ms':NOW-30001}],NOW)[0]
    assert not current_history([turn],[],NOW)


def test_verifier_preserves_approved_text_and_rejects_wrong_numbers_or_uncertain_provider():
    from shared.voice_knowledge import verify_voice_reply
    sources = [{'id': 's0', 'quote': 'Lan phụ trách demo, hạn 12/04/2026, chi phí 100 USD.'}]
    raw = json.dumps({'claims': [{'text': 'Lan phụ trách demo, hạn 12/04/2026.', 'source_ids': ['s0']}]})
    calls = []
    def review(prompt): calls.append(json.loads(prompt)); return '{"approved":true}'
    assert verify_voice_reply(raw, 'Ai làm demo?', sources, review) == raw
    assert calls[0]['sources'] == sources
    bad = raw.replace('12/04/2026', '13/04/2026')
    assert json.loads(verify_voice_reply(bad, 'Hạn nào?', sources, review)) == {'claims': []}
    assert len(calls) == 1
    for verdict in ['{"approved":false}', '{"approved":"true"}', 'invalid JSON']:
        assert json.loads(verify_voice_reply(raw, 'Hạn nào?', sources, lambda _: verdict)) == {'claims': []}
    def unavailable(_): raise TimeoutError('private provider output')
    assert json.loads(verify_voice_reply(raw, 'Hạn nào?', sources, unavailable)) == {'claims': []}
    clarification = json.dumps({'claims': [], 'clarification': 'Bạn hỏi demo hay bản chính thức?'})
    assert verify_voice_reply(clarification, 'Hạn nào?', sources, review) == clarification


def test_semantic_rejection_catches_wrong_owner_or_proposal_without_rewriting_the_reply():
    from shared.voice_knowledge import verify_voice_reply
    source = [{'id': 's0', 'quote': 'Lan đề xuất hạn thứ Sáu. Minh chưa chốt.'}]
    for text in ['Minh phụ trách.', 'Deadline đã chốt thứ Sáu.']:
        raw = json.dumps({'claims': [{'text': text, 'source_ids': ['s0']}]})
        assert json.loads(verify_voice_reply(raw, 'Ai phụ trách?', source, lambda _: '{"approved":false}')) == {'claims': []}


def test_bounded_tools_search_full_authorized_snapshot_without_opening_model_paths():
    from shared.voice_knowledge import voice_tool_calls, lookup_voice_sources
    sources = sources_for({'segments': [segment('early', 'Lan sở hữu module thanh toán.', NOW - 900000),
                                        segment('late', 'Demo đang chạy.', NOW - 1000)]},
                          {'wiki/shared.md': 'Mã sản phẩm Aster dùng Redis.'})
    selected, trace = lookup_voice_sources(sources, [], voice_tool_calls(json.dumps({'tool_calls': [
        {'name': 'search_meeting', 'query': 'thanh toán'},
        {'name': 'search_shared_documents', 'query': 'Redis'}]})), NOW)
    assert {s['key'] for s in selected} == {'segment:early', 'doc:wiki/shared.md:0'}
    assert [s['id'] for s in selected] == ['s0', 's2']
    assert all(t['source_count'] == 1 for t in trace)
    recent, _ = lookup_voice_sources(sources, [], [{'name': 'get_recent_transcript', 'query': ''}], NOW)
    assert [s['key'] for s in recent] == ['segment:late']
    for call in [{'name': 'read_file', 'query': '/etc/passwd'}, {'name': 'search_meeting', 'query': ''},
                 {'name': 'search_shared_documents', 'query': 'x', 'path': 'wiki/private.md'}]:
        with pytest.raises(ValueError): voice_tool_calls(json.dumps({'tool_calls': [call]}))


def test_public_routes_never_build_web_queries_from_private_context():
    from shared.voice_knowledge import voice_route
    assert voice_route('Tìm trên web về Redis mới nhất?') == ('web', 'Redis mới nhất?')
    assert voice_route('ASR là gì?')[0] == 'general'
    assert voice_route('Kiến thức chung: giải thích VAD')[0] == 'general'
    for question in ['Deadline đã chốt là gì?', 'Ngân sách của chúng ta là gì?', 'Vậy ai phụ trách?', 'Tìm thông tin này giúp tôi']:
        assert voice_route(question)[0] == 'meeting'


def test_verification_failures_are_distinguished_without_exposing_provider_output():
    from shared.voice_knowledge import verify_voice_reply
    raw = json.dumps({'claims': [{'text': 'Lan làm demo.', 'source_ids': ['s0']}]})
    sources = [{'id': 's0', 'quote': 'Lan làm demo.'}]
    assert json.loads(verify_voice_reply(raw, 'Ai?', sources, lambda _: '{"approved":false}', diagnostics=True))['reason'] == 'verification_rejected'
    def fail(_): raise TimeoutError('secret provider response')
    result = verify_voice_reply(raw, 'Ai?', sources, fail, diagnostics=True)
    assert json.loads(result)['reason'] == 'verification_unavailable' and 'secret' not in result
