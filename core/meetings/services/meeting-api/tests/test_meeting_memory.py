import copy
import hashlib
import json
from pathlib import Path

import jsonschema
import pytest

from meeting_api.collector.memory import conversation_memory, persist
from meeting_api.collector.speakers import SpeakerUpdate
from test_bot_refinement import fixture, ORIGIN

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'core/meetings/contracts').exists())
MEETING = {'id': 1, 'status': 'completed', 'platform': 'google_meet', 'native_meeting_id': 'demo'}


def segment(sid, start=0, text='Tôi sẽ gửi báo cáo trước thứ Sáu.'):
    return {'segment_id': sid, 'start': ORIGIN/1000 + start, 'end': ORIGIN/1000 + start + 2,
            'text': text, 'speaker': 'speaker', 'session_uid': 'session', 'completed': True}


def validate(name, value):
    schema = json.loads((ROOT / f'core/meetings/contracts/{name}.v1/{name}.schema.json').read_text())
    jsonschema.validate(value, schema)


def test_projection_is_deterministic_and_incremental_with_exact_revision_evidence():
    rows = [segment('s1'), segment('s2', 10, 'Chúng ta thống nhất phát hành bản mới.'),
            segment('s3', 70, 'Hiện tại có ba máy chủ.'), segment('pending', 80, 'I will delete data.') | {'completed': False}]
    original = copy.deepcopy(rows)
    data = {}
    first = persist(MEETING, data, rows)
    assert rows == original
    canon, memory = first['canonical'], first['memory']
    assert [s['segment_id'] for s in canon['segments']] == ['s1', 's2', 's3']
    assert len(memory['windows']) == 2
    assert {f['type'] for f in memory['facts']} == {'action_item', 'decision', 'fact'}
    for fact in memory['facts']:
        assert fact['text'] == fact['evidence'][0]['quote']
        assert fact['status'] == 'candidate' and fact['assignee_id'] is None and fact['deadline_date'] is None
    assert memory['facts'][0]['deadline_text'] == 'thứ Sáu'
    assert all(s['speaker_id'] for s in canon['segments'])
    events = len(data['transcript_outbox'])
    assert persist(MEETING, data, rows[::-1]) == first
    assert len(data['transcript_outbox']) == events
    second_window = memory['windows'][1]
    data['transcript_edits'] = {'s1': {'raw_text': rows[0]['text'], 'history': [{'revision': 1, 'text': 'Chào mọi người.'}]}}
    edited = persist(MEETING, data, rows)
    assert edited['canonical']['revision'] == 2
    assert edited['canonical']['segments'][0]['raw_text'] == rows[0]['text']
    assert edited['memory']['windows'][1]['facts'] is second_window['facts']
    assert all(f['type'] != 'action_item' for f in edited['memory']['facts'])
    assert edited['memory']['windows'][0]['evidence'][0]['revision'] == 1
    # Rebuild a missing memory projection without duplicate revision events.
    del data['meeting_memory']
    pending = len(data['transcript_outbox'])
    assert persist(MEETING, data, rows)['memory'] == data['meeting_memory']
    assert len(data['transcript_outbox']) == pending
    validate('canonical-transcript', edited['canonical'])
    validate('meeting-memory', edited['memory'])
    event = data['transcript_outbox'][-1]
    validate('meeting-memory-revision', event)
    with pytest.raises(jsonschema.ValidationError):
        validate('meeting-memory-revision', dict(event, text='private'))


def test_extraction_rejects_explicit_negation_and_questions_and_preserves_unknowns():
    rows = [segment(str(i), i*3, text) for i, text in enumerate([
        'Tôi chưa quyết định.', 'We have not decided.', 'I will send it?', 'Không, tôi sẽ gửi báo cáo.',
        'We decided to ship on Friday.', 'We need to prepare a demo.', 'Currently there are two servers.'
    ])]
    result = persist(MEETING, {}, rows)['memory']
    assert [f['type'] for f in result['facts']] == ['decision', 'action_item', 'fact']
    assert all(f['deadline_date'] is None and f['assignee_id'] is None for f in result['facts'])


def test_window_limits_and_late_arrivals():
    rows = [segment('a', text='a'*3500), segment('b', 3, 'b'*3500), segment('c', 70)]
    data = {}
    first = persist(MEETING, data, rows)
    assert len(first['memory']['windows']) == 3
    rows.append(segment('late', 1, 'We decided to wait.'))
    result = persist(MEETING, data, rows)
    assert result['canonical']['revision'] == 2
    assert [s['segment_id'] for s in result['canonical']['segments']] == ['a', 'late', 'b', 'c']
    with pytest.raises(ValueError):
        persist(MEETING, {}, [segment(str(i)) for i in range(2001)])


@pytest.mark.asyncio
async def test_owner_endpoints_alignment_rename_edit_restore_and_deletion(monkeypatch):
    client, store, _, _, _ = await fixture(monkeypatch)
    data = store._meetings[1]['data']
    raw = 'I will send the report.'
    store._meetings[1]['segments']['s/1']['text'] = raw
    data['transcript_alignment'] = {'id':'alignment', 'status':'completed', 'items': [{
        'segment_id':'s/1','state':'aligned','recording_id':9,'recording_start_ms':500,'recording_end_ms':1500,
        'model':'mfa-test','audio_sha256':'a'*64,'text_sha256':hashlib.sha256(raw.encode()).hexdigest(),
        'words':[{'index':i,'text':text,'start_ms':i*150,'end_ms':i*150+100,'aligned':True} for i,text in enumerate(raw.split())]
    }]}
    async with client:
        path = '/transcripts/by-id/1'
        first = (await client.get(path+'/canonical')).json()
        words = first['segments'][0]['words']
        assert words[0]['start_ms'] == ORIGIN + 500
        assert [w['text'] for w in words] == raw.split()
        validate('canonical-transcript', first)
        assert (await client.get(path+'/canonical',headers={'x-user-id':'8'})).status_code == 404
        assert (await client.get(path+'/memory',headers={'x-user-id':'8'})).status_code == 404
        assert (await client.get(path+'/memory')).json()['facts'][0]['evidence'][0]['quote'] == raw
        sid = first['segments'][0]['speaker_id']
        await store.update_speaker(7,1,sid,SpeakerUpdate(expected_revision=1,name='Alice'))
        renamed = (await client.get(path+'/canonical')).json()
        assert renamed['revision'] == first['revision'] + 1
        assert renamed['segments'][0]['speaker_name'] == 'Alice'
        assert all(w['speaker_name'] == 'Alice' for w in renamed['segments'][0]['words'])
        response = await client.patch(path+'/segments/s%2F1',json={'expected_revision':0,'text':'Done already.'})
        assert response.status_code == 200
        edited = (await client.get(path+'/canonical')).json()['segments'][0]
        assert edited['words'] == [] and edited['alignment']['status'] == 'segment_fallback'
        assert (await client.get(path+'/memory')).json()['facts'] == []
        await client.patch(path+'/segments/s%2F1',json={'expected_revision':1,'text':None})
        restored = (await client.get(path+'/canonical')).json()['segments'][0]
        assert restored['words'] and restored['revision'] == 2
        assert store._meetings[1]['segments']['s/1']['text'] == raw
        public = (await client.get(path)).json()
        assert 'canonical_transcript' not in public['data'] and 'meeting_memory' not in public['data']
        await store.prepare_completed_artifact_deletion(7,1)
        await store.finalize_completed_artifact_deletion(7,1)
        assert 'canonical_transcript' not in store._meetings[1]['data']
        assert 'meeting_memory' not in store._meetings[1]['data']
        assert (await client.get(path+'/memory')).status_code == 404
