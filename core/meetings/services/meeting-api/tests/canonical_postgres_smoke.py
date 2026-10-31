"""Isolated real-PostgreSQL/ASR verification. Requires a fresh tina_canonical_verify_* database.
Run with the production dependencies and both source trees mounted; never points at production data.
"""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import types
from datetime import datetime

import httpx
from fastapi import FastAPI
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from meeting_api.__main__ import _database_url
from meeting_api.collector.adapters import SqlAlchemyTranscriptStore
from meeting_api.collector.app import build_router
from meeting_api.collector.refinement import BotRefiner
from meeting_api.collector.transcript_revisions import dispatch_revisions
from meeting_api.sessions.models import Meeting, Transcription
from meeting_api.recordings.fakes import InMemoryRecordingRepo, InMemoryStorage


async def main():
    assert os.environ.get('DB_NAME', '').startswith('tina_canonical_verify_'), 'Fresh isolated database required'
    # Load the actual schema owner without importing the unrelated identity HTTP app.
    package = types.ModuleType('admin_api'); package.__path__ = ['/task/admin-src/admin_api']; sys.modules['admin_api'] = package
    from admin_api.schema.models import Base
    from admin_api.schema.sync import ensure_schema
    engine = create_async_engine(_database_url())
    await ensure_schema(engine, Base)
    async with engine.begin() as db:
        # Reproduce an old deployment before the additive migration, only in this scratch DB.
        await db.execute(text('ALTER TABLE transcriptions DROP COLUMN canonical_text'))
        await db.execute(text('ALTER TABLE transcriptions DROP COLUMN canonical_revision'))
    await ensure_schema(engine, Base)
    await ensure_schema(engine, Base)  # convergence is idempotent
    sf = async_sessionmaker(engine, expire_on_commit=False)
    source = Path('/task/audio.wav')
    duration = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', str(source)]))
    origin = 1792522376000; raw = 'rawneedlexyz'; stamp = datetime.utcnow()
    recording = {'id': 99, 'status': 'completed', 'session_uid': 'fixture-session', 'audio_start_ms': origin,
                 'media_files': [{'id': 98, 'type': 'audio', 'format': 'wav', 'storage_path': 'fixture/audio/master.wav', 'is_final': True}]}
    async with sf() as db:
        db.add(Meeting(id=1, user_id=7, platform='google_meet', platform_specific_id='isolated', status='completed', start_time=stamp, data={'recordings': [recording]}))
        db.add(Meeting(id=2, user_id=7, platform='google_meet', platform_specific_id='legacy', status='completed', start_time=stamp,
                       data={'transcript_edits': {'legacy': {'raw_text': 'legacyraw', 'history': [{'revision': 1, 'text': 'legacyacceptedneedle', 'kind': 'manual', 'at': '2026-10-21T00:00:00Z'}]}}}))
        await db.flush()
        db.add(Transcription(meeting_id=1, segment_id='fixture/one', start_time=origin/1000, end_time=origin/1000+duration, text=raw, speaker='Fixture', session_uid='fixture-session'))
        db.add(Transcription(meeting_id=2, segment_id='legacy', start_time=0, end_time=1, text='legacyraw'))
        await db.commit()
    store = SqlAlchemyTranscriptStore(sf)
    await store.ensure_canonical_transcripts()
    assert len(await store.search_transcripts(7, 'legacyacceptedneedle')) == 1
    assert await store.search_transcripts(7, 'legacyraw') == []
    index = await store.ensure_fts_index(); assert index['index'] == 'ix_transcription_canonical_fts'
    repo, storage = InMemoryRecordingRepo(), InMemoryStorage()
    repo.seed(meeting_id=1, user_id=7, session_uid='fixture-session', status='completed'); await repo.put_recordings(1, [recording])
    audio = source.read_bytes(); await storage.upload('fixture/audio/master.wav', audio, content_type='audio/wav')
    async def backend(user):
        return {'url': 'http://host.docker.internal:18000', 'model': 'custom', 'token': '', 'label': 'funasr'}
    worker = BotRefiner(store, repo, storage, backend)
    app = FastAPI(); app.include_router(build_router(store, None, refiner=worker))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://fixture', headers={'x-user-id': '7'}) as client:
        base = '/transcripts/by-id/1'
        response = await client.patch(base+'/segments/fixture%2Fone', json={'expected_revision': 0, 'text': 'manualneedlexyz'})
        response.raise_for_status()
        assert len(await store.search_transcripts(7, 'manualneedlexyz')) == 1 and await store.search_transcripts(7, raw) == []
        assert await store.search_transcripts(8, 'manualneedlexyz') == []
        async with engine.begin() as db:
            await db.execute(text("CREATE FUNCTION reject_canonical() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.canonical_text = 'mustnotpersist' THEN RAISE EXCEPTION 'rollback probe'; END IF; RETURN NEW; END $$"))
            await db.execute(text('CREATE TRIGGER reject_canonical BEFORE UPDATE ON transcriptions FOR EACH ROW EXECUTE FUNCTION reject_canonical()'))
        from meeting_api.collector.transcript_document import Correction
        try:
            await store.correct_transcript(7, 1, 'fixture/one', Correction(expected_revision=1, text='mustnotpersist'))
        except Exception:
            pass
        else:
            raise AssertionError('Fault injection failed')
        assert len(await store.pending_revisions()) == 1
        assert len(await store.search_transcripts(7, 'manualneedlexyz')) == 1
        assert await store.search_transcripts(7, 'mustnotpersist') == []
        await store.upsert_segments(1, [{'segment_id': 'fixture/one', 'start': origin/1000, 'end': origin/1000+duration, 'text': raw}])
        assert len(await store.search_transcripts(7, 'manualneedlexyz')) == 1
        (await client.post(base+'/refinement/start', json={'glossary': ['TINA', 'FunASR']})).raise_for_status()
        await worker.task
        job = await worker.current(7, 1); assert job['status'] == 'completed', job
        (await client.post(base+'/refinement/apply', json={'job_id': job['id'], 'segment_id': 'fixture/one', 'expected_revision': 1})).raise_for_status()
        assert await store.search_transcripts(7, 'manualneedlexyz') == []
        hits = await store.search_transcripts(7, job['items'][0]['text']); assert hits and hits[0]['text'] == job['items'][0]['text']
        (await client.patch(base+'/segments/fixture%2Fone', json={'expected_revision': 2, 'text': None})).raise_for_status()
        assert len(await store.search_transcripts(7, raw)) == 1
        assert (await client.get(base)).json()['segments'][0]['revision'] == 3
    async with engine.begin() as db:
        await db.execute(text('SET LOCAL enable_seqscan = off'))
        plan = (await db.execute(text("EXPLAIN (COSTS OFF) SELECT id FROM transcriptions WHERE to_tsvector('english',COALESCE(canonical_text,text)) @@ websearch_to_tsquery('english','rawneedlexyz')"))).scalars().all()
        assert 'ix_transcription_canonical_fts' in '\n'.join(plan), plan
        original = (await db.execute(text('SELECT text,session_uid FROM transcriptions WHERE meeting_id=1'))).first()
        assert original[0] == raw and original[1] == 'fixture-session'
    before = await store.pending_revisions(); assert [r['event']['revision'] for r in before] == [1, 2, 3]
    await engine.dispose()
    engine = create_async_engine(_database_url()); sf = async_sessionmaker(engine, expire_on_commit=False); store = SqlAlchemyTranscriptStore(sf)
    assert await store.pending_revisions() == before
    class Publisher:
        fail = True
        async def publish(self, channel, body):
            if self.fail: raise ConnectionError('retry probe')
    publisher = Publisher()
    try: await dispatch_revisions(store, publisher)
    except ConnectionError: pass
    assert await store.pending_revisions() == before
    publisher.fail = False; assert await dispatch_revisions(store, publisher) == 3
    assert await dispatch_revisions(store, publisher) == 0
    assert hashlib.sha256(storage.blobs['fixture/audio/master.wav']).digest() == hashlib.sha256(audio).digest()
    receipt = {'database': os.environ['DB_NAME'], 'additive_schema_and_backfill': True, 'real_asr': True, 'manual_apply_restore_search': True,
               'index_used': True, 'raw_audio_preserved': True, 'transaction_rollback': True, 'owner_scoped': True,
               'restart_and_retry': True, 'events': len(before), 'production_data_mutated': False}
    print(json.dumps(receipt))
    await engine.dispose()


asyncio.run(main())
