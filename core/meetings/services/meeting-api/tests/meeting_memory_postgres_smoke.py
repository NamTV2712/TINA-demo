"""Run only against a disposable tina_memory_verify_* database, using the real schema/store."""
import asyncio
import copy
import hashlib
import json
import os
import sys
import types

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from meeting_api.__main__ import _database_url
from meeting_api.collector.adapters import SqlAlchemyTranscriptStore
from meeting_api.collector.speakers import SpeakerUpdate
from meeting_api.collector.transcript_document import Correction
from meeting_api.sessions.models import Meeting, Transcription


async def main():
    assert os.environ['DB_NAME'].startswith('tina_memory_verify_')
    package = types.ModuleType('admin_api')
    package.__path__ = ['/task/core/identity/services/admin-api/src/admin_api']
    sys.modules['admin_api'] = package
    from admin_api.schema.models import Base
    from admin_api.schema.sync import ensure_schema
    engine = create_async_engine(_database_url())
    await ensure_schema(engine, Base)
    sf = async_sessionmaker(engine, expire_on_commit=False)
    origin = 1792522376000
    raw = 'Tôi sẽ gửi báo cáo trước thứ Sáu.'
    recording = {'id': 9, 'status': 'completed', 'session_uid': 'fixture', 'audio_start_ms': origin,
                 'media_files': [{'type': 'audio'}]}
    alignment = {'id': 'fixture', 'status': 'completed', 'items': [{
        'segment_id': 's1', 'state': 'aligned', 'recording_id': 9, 'recording_start_ms': 0, 'recording_end_ms': 2000,
        'text_sha256': hashlib.sha256(raw.encode()).hexdigest(), 'audio_sha256': 'b'*64, 'model': 'fixture',
        'words': [{'index': i, 'text': text, 'start_ms': i*100, 'end_ms': i*100+90, 'aligned': True} for i,text in enumerate(raw.split())]}]}
    async with sf() as db:
        db.add(Meeting(id=1, user_id=7, platform='google_meet', platform_specific_id='memory-fixture', status='completed',
                       data={'recordings':[recording], 'transcript_alignment':alignment}))
        await db.flush()
        db.add(Transcription(meeting_id=1, segment_id='s1', start_time=origin/1000, end_time=origin/1000+2,
                             text=raw, speaker='Speaker', session_uid='fixture'))
        await db.commit()
    store = SqlAlchemyTranscriptStore(sf)
    first = await store.get_meeting_memory(7,1)
    assert first['canonical']['segments'][0]['words'][0]['start_ms'] == origin
    assert first['memory']['facts'][0]['evidence'][0]['quote'] == raw
    assert await store.get_meeting_memory(8,1) is None
    assert await store.memory_candidates() == [{'meeting_id':1,'user_id':7}]
    repeated = await asyncio.gather(*(store.get_meeting_memory(7,1) for _ in range(5)))
    assert all(r == first for r in repeated)
    assert len([e for e in await store.pending_revisions() if e['event']['type']=='meeting.memory.updated']) == 1
    sid = first['canonical']['segments'][0]['speaker_id']
    await store.update_speaker(7,1,sid,SpeakerUpdate(name='Alice',expected_revision=1))
    renamed = await store.get_meeting_memory(7,1)
    assert renamed['canonical']['revision'] == 2
    assert renamed['memory']['facts'][0]['evidence'][0]['speaker_name'] == 'Alice'
    assert all(w['speaker_name']=='Alice' for w in renamed['canonical']['segments'][0]['words'])
    await store.correct_transcript(7,1,'s1',Correction(expected_revision=0,text='Chào mọi người.'))
    edited = await store.get_meeting_memory(7,1)
    assert not edited['memory']['facts'] and not edited['canonical']['segments'][0]['words']
    await store.correct_transcript(7,1,'s1',Correction(expected_revision=1,text=None))
    restored = await store.get_meeting_memory(7,1)
    assert restored['memory']['facts'][0]['evidence'][0]['revision'] == 2
    async with sf() as db:
        row = await db.get(Meeting,1)
        assert row.data['meeting_memory'] == restored['memory']
        assert row.data['canonical_transcript'] == restored['canonical']
        source = (await db.execute(select(Transcription).where(Transcription.meeting_id==1))).scalars().one()
        assert source.text == raw
        db.add(Transcription(meeting_id=1,segment_id='late',start_time=origin/1000+70,end_time=origin/1000+72,text='We decided to ship.'))
        await db.commit()
    late = await SqlAlchemyTranscriptStore(sf).get_meeting_memory(7,1)
    assert len(late['memory']['windows']) == 2 and len(late['memory']['facts']) == 2
    public = await store.get_transcript_by_id(7,1)
    assert 'canonical_transcript' not in public['data'] and 'meeting_memory' not in public['data']
    await store.prepare_completed_artifact_deletion(7,1)
    await store.finalize_completed_artifact_deletion(7,1)
    assert await store.get_meeting_memory(7,1) is None
    async with sf() as db:
        row = await db.get(Meeting,1)
        assert 'canonical_transcript' not in row.data and 'meeting_memory' not in row.data
    await engine.dispose()
    print(json.dumps({'postgres_memory':'passed','checks':['durable projections','serialized no-op reads','alignment attribution','identity revisions','edit/restore evidence','late rows','owner privacy','artifact deletion']}))


if __name__ == '__main__':
    asyncio.run(main())
