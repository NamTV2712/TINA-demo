"""Real workers + real storage behind Meeting API routes, isolated from user meeting rows."""
from __future__ import annotations
import asyncio
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import time
import types
from uuid import uuid4
import wave

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from meeting_api.__main__ import _database_url
from meeting_api.collector.adapters import SqlAlchemyTranscriptStore
from meeting_api.collector.alignment import BotAligner
from meeting_api.collector.app import build_router
from meeting_api.collector.diarization import BotDiarizer
from meeting_api.collector.refinement import BotRefiner
from meeting_api.recordings.adapters import S3Storage, SqlAlchemyRecordingRepo
from meeting_api.sessions.models import Meeting, Transcription

OUT = Path('/task/run')
ORIGIN = 1767225600000


def save(name, value):
    (OUT/name).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')


def wav_bytes(frames):
    out=io.BytesIO()
    with wave.open(out,'wb') as w:
        w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(frames)
    return out.getvalue()


async def main():
    assert os.environ['DB_NAME'].startswith('tina_memory_verify_'), 'Disposable database required'
    manifest=json.loads((OUT/'manifest.json').read_text()); audio=(OUT/'meeting.wav').read_bytes()
    assert hashlib.sha256(audio).hexdigest()==manifest['audio_sha256']
    package=types.ModuleType('admin_api');package.__path__=['/task/core/identity/services/admin-api/src/admin_api'];sys.modules['admin_api']=package
    from admin_api.schema.models import Base
    from admin_api.schema.sync import ensure_schema
    engine=create_async_engine(_database_url());await ensure_schema(engine,Base)
    sf=async_sessionmaker(engine,expire_on_commit=False)
    store=SqlAlchemyTranscriptStore(sf); repo=SqlAlchemyRecordingRepo(sf)
    storage=S3Storage(bucket=os.environ.get('RECORDING_BUCKET','recordings'),endpoint_url=os.environ.get('S3_ENDPOINT'),
                      access_key=os.environ.get('S3_ACCESS_KEY'),secret_key=os.environ.get('S3_SECRET_KEY'))
    prefix='e2e-synthetic/'+uuid4().hex;key=prefix+'/audio/master.wav'
    recording={'id':9,'status':'completed','session_uid':'synthetic','audio_start_ms':ORIGIN,
        'media_files':[{'id':8,'type':'audio','format':'wav','is_final':True,'storage_path':key}]}
    async with sf() as db:
        db.add(Meeting(id=1,user_id=7,platform='google_meet',platform_specific_id='synthetic-only',status='active',data={'recordings':[recording]}))
        await db.commit()
    async def backend(user):return {'url':'http://host.docker.internal:18000','model':'custom','token':'','label':'qwen-fsmn'}
    refiner=BotRefiner(store,repo,storage,backend);diarizer=BotDiarizer(store,refiner);aligner=BotAligner(store,refiner)
    refiner.aligner=aligner;refiner.diarizer=diarizer;aligner.diarizer=diarizer
    app=FastAPI();app.include_router(build_router(store,None,refiner=refiner,diarizer=diarizer,aligner=aligner))
    timings={};checks={};requests=[]
    uploaded=False
    try:
        await storage.upload(key,audio,content_type='audio/wav');uploaded=True
        with wave.open(io.BytesIO(audio)) as w:
            assert (w.getframerate(),w.getnchannels(),w.getsampwidth())==(16000,1,2)
            frames=w.readframes(w.getnframes())
        # shortcut: fixed-window replay excludes capture/endpoint transport; add a real capture run before live-latency claims.
        chunk_frames=int(manifest['chunk_seconds']*16000)
        plan=json.loads((OUT/'windows.json').read_text())['windows'] if (OUT/'windows.json').exists() else [
            {'start_sample':offset//2,'end_sample':min(offset+chunk_frames*2,len(frames))//2,
             'available_at_seconds':min(offset+chunk_frames*2,len(frames))/32000,'cut_kind':'fixed'}
            for offset in range(0,len(frames),chunk_frames*2)]
        assert plan[0]['start_sample']==0 and plan[-1]['end_sample']==len(frames)//2
        assert all(w['end_sample']>w['start_sample'] and w['end_sample']-w['start_sample']<=25*16000
                   and w['available_at_seconds']>=w['end_sample']/16000
                   and (not i or w['start_sample']==plan[i-1]['end_sample']) for i,w in enumerate(plan))
        replay=time.perf_counter()
        async with httpx.AsyncClient(timeout=180) as asr:
            for chunk_index,window in enumerate(plan):
                offset=window['start_sample']*2
                part=frames[offset:window['end_sample']*2];start=window['start_sample']/16000;end=window['end_sample']/16000
                await asyncio.sleep(max(0,window['available_at_seconds']-(time.perf_counter()-replay)))
                begin=time.perf_counter()
                response=await asr.post('http://host.docker.internal:18000/v1/audio/transcriptions',data={'model':'custom','response_format':'verbose_json'},files={'file':('chunk.wav',wav_bytes(part),'audio/wav')})
                response.raise_for_status();recognized=response.json()
                ready=time.perf_counter()-replay
                rows=[]
                for index,segment in enumerate(recognized.get('segments',[])):
                    if not segment.get('text','').strip():continue
                    left=max(0,float(segment['start']));right=min(end-start,float(segment['end']))
                    assert 0<=left<right<=end-start+.001
                    rows.append({'segment_id':f'replay:{chunk_index}:{index}','start':ORIGIN/1000+start+left,'end':ORIGIN/1000+start+right,
                                 'text':segment['text'],'speaker':'Unknown','session_uid':'synthetic','completed':True})
                if rows:await store.upsert_segments(1,rows)
                requests.append({'chunk_start_s':start,'chunk_end_s':end,'http_seconds':time.perf_counter()-begin,'ready_seconds':ready,'segments':len(rows),'available_at_seconds':window['available_at_seconds'],'cut_kind':window['cut_kind']})
                save('asr-progress.json',requests)
                print(json.dumps({'stage':'asr','chunk':len(requests),'http_seconds':round(requests[-1]['http_seconds'],3),'segments':len(rows)}),flush=True)
        replay_wall=time.perf_counter()-replay
        async with sf() as db:
            meeting=await db.get(Meeting,1);meeting.status='completed';await db.commit()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture',headers={'x-user-id':'7'}) as api:
            base='/transcripts/by-id/1'
            async def call(method,path,**kw):
                r=await api.request(method,base+path,**kw)
                assert r.status_code<300,(path,r.status_code,r.text[:300])
                return r.json()
            before=await call('GET','/document')
            assert before['segments'],'ASR produced no finalized speech'
            begin=time.perf_counter();await call('POST','/diarization/start',json={'num_speakers':3});await diarizer.task
            diarization=await call('GET','/diarization');timings['diarization_seconds']=time.perf_counter()-begin
            save('diarization.json',diarization)
            assert diarization['status']=='completed',diarization.get('error')
            begin=time.perf_counter();await call('POST','/diarization/apply',json={'job_id':diarization['id']});timings['diarization_apply_seconds']=time.perf_counter()-begin
            print(json.dumps({'stage':'diarization','seconds':timings['diarization_seconds'],'clusters':len({t['speaker'] for t in diarization['turns']})}),flush=True)
            begin=time.perf_counter();await call('POST','/alignment/start');await aligner.task
            alignment=(await call('GET','/alignment'))['job'];timings['alignment_seconds']=time.perf_counter()-begin
            save('alignment.json',alignment)
            assert alignment['status']=='completed',alignment.get('error')
            print(json.dumps({'stage':'alignment','seconds':timings['alignment_seconds'],'aligned_items':sum(i['state']=='aligned' for i in alignment['items'])}),flush=True)
            begin=time.perf_counter();canonical=await call('GET','/canonical');timings['canonical_seconds']=time.perf_counter()-begin
            begin=time.perf_counter();memory=await call('GET','/memory');timings['memory_cached_read_seconds']=time.perf_counter()-begin
            save('canonical.json',canonical);save('memory.json',memory)
            sources={s['segment_id']:s for s in before['segments']}
            for s in canonical['segments']:
                source=sources[s['segment_id']]
                assert (s['text'],s['raw_text'],s['revision'])==(source['text'],source['raw_text'],source['revision'])
                assert [w['text'] for w in s['words']]==s['raw_text'].split() if s['alignment']['status']=='aligned' else not s['words']
                for word in s['words']:
                    if word['aligned']:assert s['start_ms']<=word['start_ms']<word['end_ms']<=s['end_ms']+1
                    else:assert word['start_ms'] is None and word['end_ms'] is None
            checks['canonical_source_and_word_bounds']=True
            for fact in memory['facts']:
                for evidence in fact['evidence']:
                    source=sources[evidence['segment_id']]
                    assert evidence['quote']==source['text'] and evidence['revision']==source['revision']
            checks['exact_evidence_with_revision']=True
            for endpoint in ('canonical','memory','alignment'):
                assert (await api.get(base+'/'+endpoint,headers={'x-user-id':'8'})).status_code==404
            checks['owner_isolation']=True
            registry=await call('GET','/speakers')
            attributed={w['speaker_id'] for s in canonical['segments'] for w in s['words'] if w.get('speaker_id')}
            entry=next(s for s in registry['speakers'] if s['speaker_id'] in attributed and any(h.get('recording_key') for h in s['history']))
            new_name='Synthetic voice renamed'
            await call('PATCH','/speakers/'+entry['speaker_id'],json={'name':new_name,'expected_revision':entry['revision']})
            renamed=await call('GET','/canonical');renamed_memory=await call('GET','/memory')
            affected=[w for s in renamed['segments'] for w in s['words'] if w['speaker_id']==entry['speaker_id']]
            assert affected, 'Rename must exercise actual word attribution'
            assert all(w['speaker_name']==new_name for w in affected)
            assert renamed['revision']>canonical['revision']
            checks['rename_updates_attribution']={'checked_words':len(affected),'revision':renamed['revision']}
            for w in renamed_memory['windows']:
                for e in w['evidence']:
                    if e['speaker_id']==entry['speaker_id']:assert e['speaker_name']==new_name
            # Replace one recognized segment, check stale evidence disappears, then restore the raw source.
            fact_sid=memory['facts'][0]['evidence'][0]['segment_id'] if memory['facts'] else canonical['segments'][0]['segment_id']
            from urllib.parse import quote
            route='/segments/'+quote(fact_sid,safe='')
            await call('PATCH',route,json={'expected_revision':0,'text':'Không có thay đổi.'})
            edited=await call('GET','/canonical');edited_memory=await call('GET','/memory')
            target=next(s for s in edited['segments'] if s['segment_id']==fact_sid)
            assert target['raw_text']==sources[fact_sid]['raw_text'] and target['revision']==1 and not target['words']
            assert all(e['segment_id']!=fact_sid for f in edited_memory['facts'] for e in f['evidence'])
            assert (await api.patch(base+route,json={'expected_revision':0,'text':'stale'})).status_code==409
            await call('PATCH',route,json={'expected_revision':1,'text':None})
            restored=await call('GET','/canonical');restored_memory=await call('GET','/memory')
            target=next(s for s in restored['segments'] if s['segment_id']==fact_sid)
            assert target['text']==sources[fact_sid]['raw_text'] and target['revision']==2
            initial=next(s for s in renamed['segments'] if s['segment_id']==fact_sid)
            assert target['words']==initial['words']
            checks['edit_restore_removes_stale_evidence_and_checks_revision']=True
            checks['audio_hash_unchanged']=hashlib.sha256(await storage.get(key)).hexdigest()==manifest['audio_sha256']
            assert checks['audio_hash_unchanged']
            async with sf() as db:
                row=await db.get(Meeting,1)
                assert row.data['canonical_transcript']==restored and row.data['meeting_memory']==restored_memory
                rows=(await db.execute(select(Transcription).where(Transcription.meeting_id==1))).scalars().all()
                assert all(r.text==sources[r.segment_id]['raw_text'] for r in rows)
            checks['durable_postgres_and_immutable_raw']=True
            pending=await store.pending_revisions(100)
            assert all('text' not in p['event'] and 'quote' not in p['event'] for p in pending)
            checks['metadata_only_outbox']=True
            save('pipeline.json',{'asr_requests':requests,'audio_replay_wall_seconds':replay_wall,'stage_seconds':timings,
                'diarization':diarization,'canonical':canonical,'memory':memory,'restored_canonical':restored,'checks':checks})
            print(json.dumps({'stage':'checks','passed':list(checks)}),flush=True)
    finally:
        if uploaded:
            keys=await storage.list(prefix+'/')
            assert all(k.startswith(prefix+'/') for k in keys)
            for k in keys:await storage.delete(k)
            assert not await storage.list(prefix+'/')
            save('cleanup.json',{'temporary_audio_objects_deleted':len(keys),'prefix':prefix})
        if aligner.task and not aligner.task.done():
            aligner.task.cancel();await aligner.task
        await diarizer.close();await refiner.close();await engine.dispose()


if __name__=='__main__':asyncio.run(main())
