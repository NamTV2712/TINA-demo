import copy
import hashlib
import io
import wave

import httpx
import pytest
from fastapi import FastAPI

from meeting_api.collector.app import build_router
from meeting_api.collector.diarization import BotDiarizer
from test_bot_refinement import fixture, HEADERS


@pytest.mark.asyncio
async def test_owner_job_analyze_apply_idempotency_restart_and_raw_preservation(monkeypatch):
    client,store,storage,refiner,_=await fixture(monkeypatch)
    await store.get_speakers(7,1)
    original=copy.deepcopy(store._meetings[1]['segments'])
    monkeypatch.setenv('DIARIZATION_SERVICE_URL','http://diarization.test')
    monkeypatch.setenv('DIARIZATION_SERVICE_TOKEN','local-private-token')
    diarizer=BotDiarizer(store,refiner);refiner.diarizer=diarizer
    original_client=httpx.AsyncClient
    # fixture replaces AsyncClient with a transport factory; restore the actual class.
    original_client=type(client)
    def worker(request):
        assert request.url.path=='/diarize'
        assert request.headers['authorization']=='Bearer local-private-token'
        start=request.content.index(b'RIFF');end=request.content.index(b'\r\n--',start)
        audio=request.content[start:end]
        with wave.open(io.BytesIO(audio)) as wav: duration=wav.getnframes()/16
        return httpx.Response(200,json={'model':'test-pyannote-embedding','audio_sha256':hashlib.sha256(audio).hexdigest(),'turns':[{'start_ms':0,'end_ms':duration,'speaker':0}]})
    monkeypatch.setattr('meeting_api.collector.diarization.httpx.AsyncClient',lambda **kw:original_client(transport=httpx.MockTransport(worker),**kw))
    app=FastAPI();app.include_router(build_router(store,None,refiner=refiner,diarizer=diarizer))
    async with original_client(transport=httpx.ASGITransport(app=app),base_url='http://api.test',headers=HEADERS) as api:
        path='/transcripts/by-id/1/diarization'
        assert (await api.get(path,headers={'x-user-id':'8'})).status_code==404
        assert (await api.post(path+'/start',json={'num_speakers':0})).status_code==422
        response=await api.post(path+'/start',json={'num_speakers':1});assert response.status_code==202,response.text
        await diarizer.task
        job=(await api.get(path)).json();assert job['status']=='completed',job
        assert len(job['items'])==1 and job['items'][0]['cluster']==0
        assert job['recordings'][0]['offset_ms']==0
        assert not job.get('applied_at')
        assert (await api.post(path+'/apply',json={'job_id':job['id']},headers={'x-user-id':'8'})).status_code==404
        result=await api.post(path+'/apply',json={'job_id':job['id']});assert result.status_code==200,result.text
        events=len(store._meetings[1]['data']['transcript_outbox'])
        assert (await api.post(path+'/apply',json={'job_id':job['id']})).status_code==200
        assert len(store._meetings[1]['data']['transcript_outbox'])==events
        assert store._meetings[1]['segments']==original
        assert 'transcript_diarization' not in (await api.get('/transcripts/by-id/1')).json()['data']
        assert (await api.post(path+'/apply',json={'job_id':'stale'})).status_code==409
        restarted=BotDiarizer(store,refiner)
        assert (await restarted.current(7,1))['applied_at']
        await store.prepare_completed_artifact_deletion(7,1);await store.finalize_completed_artifact_deletion(7,1)
        assert await store.get_diarization(7,1) is None
        assert 'transcript_diarization' not in store._meetings[1]['data']
    await client.aclose()
