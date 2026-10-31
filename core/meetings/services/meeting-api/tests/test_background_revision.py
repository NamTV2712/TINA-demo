import copy

import pytest

from meeting_api.collector.job_revision import check_job
from meeting_api.collector.transcript_document import CorrectionConflict
from test_bot_refinement import fixture


def test_job_admission_uses_cas_and_late_progress_cannot_replace_another_run():
    old = {'id':'old', 'status':'completed'}
    new = {'id':'new', 'status':'running'}
    with pytest.raises(CorrectionConflict): check_job(old, new)
    check_job(old, new, expected_job_id='old')
    with pytest.raises(CorrectionConflict): check_job({'id':'new','status':'completed'}, old)
    with pytest.raises(CorrectionConflict): check_job(old, {'id':'old','status':'running'})


@pytest.mark.asyncio
async def test_alignment_commit_checks_revision_under_lock_and_raw_ingest_cannot_relink_edited_audio(monkeypatch):
    api, store, _, _, _ = await fixture(monkeypatch)
    original = copy.deepcopy(store._meetings[1]['segments']['s/1'])
    job = {'id':'alignment-old','status':'running','items':[{'segment_id':'s/1','expected_revision':0,'state':'pending'}]}
    await store.save_alignment(7,1,job)
    async with api:
        path='/transcripts/by-id/1'
        assert (await api.patch(path+'/segments/s%2F1',json={'expected_revision':0,'text':'User accepted words.'})).status_code == 200
        job['status']='completed';job['items'][0].update(state='aligned',words=[{'text':'old','index':0,'start_ms':0,'end_ms':100,'aligned':True}])
        await store.save_alignment(7,1,job)
        saved=await store.get_alignment(7,1)
        assert saved['items'][0]['state']=='stale' and 'words' not in saved['items'][0]
        assert not any(e.get('kind')=='alignment' for e in store._meetings[1]['data'].get('transcript_outbox',[]))
        await store.upsert_segments(1,[dict(original,text='stale ASR',start=1,end=2,session_uid='wrong-session')])
        assert store._meetings[1]['segments']['s/1']==original
        doc=(await api.get(path+'/document')).json()['segments'][0]
        assert doc['text']=='User accepted words.' and doc['revision']==1
