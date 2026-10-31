"""SQLite-export fixture → actual PostgreSQL via production owner routes. Disposable DB only."""
import asyncio
import copy
import json
import os
from pathlib import Path
import sys
import types

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from meeting_api.__main__ import _database_url
from meeting_api.collector.adapters import SqlAlchemyTranscriptStore
from meeting_api.collector.app import build_router
from meeting_api.collector.foundation import fingerprint, validate
from meeting_api.sessions.models import Meeting, Transcription
from meeting_api.collector.transcript_document import CorrectionConflict


async def main():
    assert os.environ['DB_NAME'].startswith('tina_stt_verify_'), 'Disposable database required'
    root = Path(__file__).resolve().parents[3]
    package = types.ModuleType('admin_api'); package.__path__ = [str(root/'core/identity/services/admin-api/src/admin_api')]; sys.modules['admin_api'] = package
    from admin_api.schema.models import Base
    from admin_api.schema.sync import ensure_schema
    engine = create_async_engine(_database_url())
    try:
        await ensure_schema(engine, Base)
        sf = async_sessionmaker(engine, expire_on_commit=False)
        async with sf() as db:
            db.add(Meeting(id=1, user_id=7, platform='google_meet', platform_specific_id='foundation-only', status='completed', data={}))
            await db.flush()
            db.add(Transcription(meeting_id=1, segment_id='bot-original', text='Bot original raw', start_time=100, end_time=101, speaker='Bot voice', session_uid='bot-session'))
            await db.commit()
        store = SqlAlchemyTranscriptStore(sf)
        app = FastAPI(); app.include_router(build_router(store, None))
        snapshot = json.loads(Path(sys.argv[1]).read_text()); validate(snapshot)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://fixture', headers={'x-user-id':'7'}) as api:
            path = '/transcripts/by-id/1/replicas/' + snapshot['meeting_uid']
            denied = await api.put(path, json={'expected_revision':0,'snapshot':snapshot}, headers={'x-user-id':'8'})
            assert denied.status_code == 404
            for _ in range(2):
                response = await api.put(path, json={'expected_revision':0,'snapshot':snapshot})
                assert response.status_code == 200, response.text[:300]
                assert response.json() == snapshot
            assert (await api.get(path)).json() == snapshot
            native_before = (await api.get('/transcripts/by-id/1/document')).json()
            assert native_before['segments'][0]['raw_text'] == 'Bot original raw'

            def advance(text):
                packet = copy.deepcopy(snapshot); packet['sequence'] += 1
                segment = packet['segments'][0]; segment['revision'] += 1; segment['text'] = text
                segment['history'].append({'revision':segment['revision'],'text':text,'kind':'manual','at':'2026-10-24T00:00:00Z'})
                packet['fingerprint'] = fingerprint({k:v for k,v in packet.items() if k not in ('fingerprint','sequence')})
                return packet

            # Row lock/CAS makes exactly one concurrent source update durable.
            left, right = advance('Accepted source edit A'), advance('Accepted source edit B')
            responses = await asyncio.gather(*[api.put(path, json={'expected_revision':snapshot['sequence'],'snapshot':packet}) for packet in (left,right)])
            assert sorted(r.status_code for r in responses) == [200,409]
            accepted = next(r.json() for r in responses if r.status_code == 200)
            assert (await api.put(path,json={'expected_revision':accepted['sequence'],'snapshot':snapshot})).status_code == 409
            await engine.dispose()
            assert (await api.get(path)).json() == accepted, 'Replica must survive a fresh database connection'

            assert (await api.patch('/transcripts/by-id/1/segments/bot-original',json={'expected_revision':0,'text':'User accepted canonical'})).status_code == 200
            await store.upsert_segments(1,[{'segment_id':'bot-original','start':1,'end':2,'text':'stale worker','speaker':'wrong','session_uid':'wrong-source'}])
            async with sf() as db:
                row = (await db.execute(select(Transcription).where(Transcription.segment_id=='bot-original'))).scalars().one()
                assert (row.text,row.start_time,row.end_time,row.session_uid,row.canonical_text,row.canonical_revision) == ('Bot original raw',100,101,'bot-session','User accepted canonical',1)
            job = {'id':'job-one','status':'running','items':[{'segment_id':'bot-original','state':'pending','expected_revision':0}]}
            await store.save_alignment(7,1,job)
            job['status']='completed'; job['items'][0]['state']='aligned'; job['items'][0]['words']=[]
            await store.save_alignment(7,1,job)
            assert (await store.get_alignment(7,1))['items'][0]['state']=='stale'
            next_job = {'id':'job-two','status':'running','items':[]}
            await store.save_alignment(7,1,next_job,expected_job_id='job-one')
            next_job['status']='completed';await store.save_alignment(7,1,next_job)
            try:
                await store.save_alignment(7,1,job)
                raise AssertionError('Late worker must not overwrite the newer job')
            except CorrectionConflict:
                pass
            assert (await store.get_alignment(7,1))['id']=='job-two'
            source = (await api.get('/transcripts/by-id/1/foundation')).json();validate(source)
            assert source['authority']['system']=='meeting-api' and source['meeting_uid']!=snapshot['meeting_uid']
            assert (await api.get('/transcripts/by-id/1/document')).json()['segments'][0]['text']=='User accepted canonical'
            assert (await api.get(path)).json()==accepted
        summary={'checks':['owner isolation','1080-segment SQLite to PostgreSQL round trip','idempotent source retry','concurrent CAS has one winner','stale snapshot rejected','replica survives reconnect','raw text/source clock/session protected after user edit','alignment expected_revision checked in transaction','late job rejected after newer completed job','native Bot canonical independent of Desktop authority'],
                 'segments':len(snapshot['segments']),'sources':len(snapshot['sources']),'authority':snapshot['authority'],'meeting_uid':snapshot['meeting_uid'],'replica_sequence':accepted['sequence']}
        Path(sys.argv[2]).write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary))
    finally:
        await engine.dispose()


asyncio.run(main())
