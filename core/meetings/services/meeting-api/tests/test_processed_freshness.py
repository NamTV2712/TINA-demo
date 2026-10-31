import copy
import time

from meeting_api.collector.memory import persist
from meeting_api.collector.processed_notes import configure, claim, accept
from test_meeting_memory import MEETING, segment


def setup():
    data = {}
    rows = [segment('a'), segment('b', 70, 'We agreed to ship Friday.')]
    projected = persist(MEETING, data, rows)
    configure(data, **{'canon': projected['canonical'], 'memory': projected['memory']}, enabled=True)
    return data, rows, projected


def result(job):
    return dict(job, notes=[{'id': e['segment_id'], 'text': e['quote'], 'speaker': 'LLM guessed name'} for e in job['source']['evidence']],
                params={'provider': 'fake', 'model': 'test-model'})


def test_delayed_result_cannot_overwrite_edit_restore_or_speaker_name():
    for change in ('edit', 'restore', 'rename'):
        data, rows, p = setup()
        job = claim(data, p['canonical'], p['memory'])
        before_rows = copy.deepcopy(rows)
        if change == 'rename':
            for speaker in data['speaker_registry']['speakers'].values():
                speaker['name'] = 'Alice'
                speaker['manual'] = True
                speaker['revision'] = speaker.get('revision', 0) + 1
        else:
            data['transcript_edits'] = {'a': {'raw_text': rows[0]['text'], 'history': [
                {'revision': 1, 'text': 'edited' if change == 'edit' else rows[0]['text']} ]}}
        p = persist(MEETING, data, rows)
        assert accept(data, p['canonical'], p['memory'], result(job))['accepted'] is False
        assert rows == before_rows


def test_fresh_notes_have_exact_evidence_and_only_affected_window_is_invalidated():
    data, rows, p = setup()
    first = claim(data, p['canonical'], p['memory'])
    assert accept(data, p['canonical'], p['memory'], result(first))['accepted']
    second = claim(data, p['canonical'], p['memory'])
    assert accept(data, p['canonical'], p['memory'], result(second))['accepted']
    view = data['processed']['views'][0]
    assert view['params']['prompt_version'] == 1
    assert view['doc']['notes'][0]['speaker'] != 'LLM guessed name'
    assert view['doc']['notes'][0]['evidence'][0]['quote'] == rows[0]['text']
    assert accept(data, p['canonical'], p['memory'], result(first))['duplicate']
    data['transcript_edits'] = {'a': {'raw_text': rows[0]['text'], 'history': [{'revision': 1, 'text': 'New wording.'}]}}
    p = persist(MEETING, data, rows)
    notes = {n['id']: n for n in data['processed']['views'][0]['doc']['notes']}
    assert notes['a']['stale'] and not notes['b']['stale']
    replacement = claim(data, p['canonical'], p['memory'])
    assert [e['segment_id'] for e in replacement['source']['evidence']] == ['a']
    assert replacement['source']['generation'] != first['source']['generation']
    assert accept(data, p['canonical'], p['memory'], result(replacement))['accepted']


def test_new_unrelated_window_does_not_reject_a_valid_inflight_result():
    data, rows, p = setup()
    job = claim(data, p['canonical'], p['memory'])
    p = persist(MEETING, data, [*rows, segment('c', 140)])
    assert accept(data, p['canonical'], p['memory'], result(job))['accepted']
    assert data['processed']['views'][0]['doc']['notes'][0]['source']['canonical_revision'] == job['source']['canonical_revision']


def test_disable_and_expired_or_reclaimed_lease_reject_results():
    data, rows, p = setup()
    old = claim(data, p['canonical'], p['memory'])
    job = data['canonical_notes']['windows'][old['source']['window_id']]
    job['lease_until'] = time.time() - 1
    assert not accept(data, p['canonical'], p['memory'], result(old))['accepted']
    newer = claim(data, p['canonical'], p['memory'])
    assert not accept(data, p['canonical'], p['memory'], result(old))['accepted']
    configure(data, p['canonical'], p['memory'], False)
    assert not accept(data, p['canonical'], p['memory'], result(newer))['accepted']
    assert claim(data, p['canonical'], p['memory']) is None


def test_inflight_work_is_coalesced_and_removed_segments_become_tombstones():
    data, rows, p = setup()
    old = claim(data, p['canonical'], p['memory'])
    data['transcript_edits'] = {'a': {'raw_text': rows[0]['text'], 'history': [{'revision': 1, 'text': 'Latest edit.'}]}}
    p = persist(MEETING, data, rows)
    assert claim(data, p['canonical'], p['memory']) is None
    assert not accept(data, p['canonical'], p['memory'], result(old))['accepted']
    fresh = claim(data, p['canonical'], p['memory'])
    assert accept(data, p['canonical'], p['memory'], result(fresh))['accepted']
    p = persist(MEETING, data, rows[1:])
    note = data['processed']['views'][0]['doc']['notes'][0]
    assert note['withdrawn'] and note['text'] == '' and note['stale']
