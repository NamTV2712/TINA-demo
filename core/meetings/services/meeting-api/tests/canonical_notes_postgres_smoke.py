"""Actual PostgreSQL/Redis + actual worker function with a deterministic injected CompletionPort.

Only run in an isolated tina_notes_verify_* database and an owned disposable Redis instance.
"""
import asyncio
import json
import os
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path('/task')
sys.path[:0] = [str(ROOT/'core/meetings/services/meeting-api/src'), str(ROOT/'core/agent')]

from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from redis.asyncio import Redis
from meeting_api.__main__ import _database_url
from meeting_api.collector.adapters import SqlAlchemyTranscriptStore
from meeting_api.collector.transcript_document import Correction
from meeting_api.collector.speakers import SpeakerUpdate
from meeting_api.collector.processed_notes import publish_request, drain_results, REQUESTS, RESULTS
from meeting_api.collector.transcript_revisions import dispatch_revisions
from meeting_api.sessions.models import Meeting, Transcription
from llm.ports import CompletionResult
from worker.processed_notes import run
from shared.units import CANONICAL_NOTES_PREFIX


class Completion:
    def complete(self, prompt, **kwargs):
        import re
        ids = re.findall(r'\bid=([^ \]]+)', prompt)
        return CompletionResult(text=json.dumps({'notes': [{'id': sid, 'text': 'Readable fixture note.'} for sid in ids]}), model='fixture-model')


class CandidateStream:
    def __init__(self): self.rows = []
    def xadd(self, key, fields): self.rows.append((key, fields))


async def main():
    assert os.environ['DB_NAME'].startswith('tina_notes_verify_')
    package = types.ModuleType('admin_api')
    package.__path__ = [str(ROOT/'core/identity/services/admin-api/src/admin_api')]
    sys.modules['admin_api'] = package
    from admin_api.schema.models import Base
    from admin_api.schema.sync import ensure_schema
    engine = create_async_engine(_database_url())
    assert engine.url.database == os.environ['DB_NAME'] and engine.url.database.startswith('tina_notes_verify_')
    await ensure_schema(engine, Base)
    sf = async_sessionmaker(engine, expire_on_commit=False)
    redis = Redis.from_url(os.environ['REDIS_URL'], decode_responses=True)
    assert await redis.dbsize() == 0, 'Disposable Redis must start empty'
    origin = 1792522376
    raw = 'Tôi sẽ gửi API report trước thứ Sáu.'
    async with sf() as db:
        db.add(Meeting(id=1, user_id=7, platform='google_meet', platform_specific_id='notes-fixture', status='completed', data={}))
        await db.flush()
        db.add(Transcription(meeting_id=1, segment_id='s1', start_time=origin, end_time=origin+2,
                             text=raw, speaker='Speaker', session_uid='fixture'))
        await db.commit()
    store = SqlAlchemyTranscriptStore(sf, redis_client=redis)
    await store.processed_notes(7, 1, action='configure', payload={'enabled': True})
    assert await store.processed_notes(8, 1) is None
    # Row locks serialize claims, so only one concurrent caller gets the lease.
    claims = await asyncio.gather(*(store.processed_notes(7, 1, action='claim') for _ in range(4)))
    job = next(j for j in claims if j)
    assert sum(j is not None for j in claims) == 1
    stream = CandidateStream()
    with tempfile.TemporaryDirectory() as work:
        run(stream, Path(work), CANONICAL_NOTES_PREFIX+json.dumps(job), completion=Completion())
    assert stream.rows[0][0] == RESULTS
    delayed = stream.rows[0][1]
    await store.correct_transcript(7, 1, 's1', Correction(expected_revision=0, text='User corrected this sentence.'))
    await redis.xadd(RESULTS, delayed)
    await drain_results(redis, store)
    state = await store.processed_notes(7, 1)
    assert not state['view']['doc']['notes']
    assert await store.processing_candidates() == [{'meeting_id': 1, 'user_id': 7}]

    async def produce_fresh():
        job = await publish_request(redis, store, 7, 1)
        assert job
        stream = CandidateStream()
        with tempfile.TemporaryDirectory() as work:
            run(stream, Path(work), CANONICAL_NOTES_PREFIX+json.dumps(job), completion=Completion())
        for key, fields in stream.rows:
            await redis.xadd(key, fields)
        await drain_results(redis, store)
        return job, stream.rows[0][1]

    fresh_job, fresh_result = await produce_fresh()
    state = await store.processed_notes(7, 1)
    note = state['view']['doc']['notes'][0]
    assert not note['stale'] and note['evidence'][0]['quote'] == 'User corrected this sentence.'
    assert note['evidence'][0]['revision'] == 1
    seq = note['publication_revision']
    await redis.xadd(RESULTS, fresh_result)
    await drain_results(redis, store)
    assert (await store.processed_notes(7, 1))['view']['doc']['notes'][0]['publication_revision'] == seq
    await store.correct_transcript(7, 1, 's1', Correction(expected_revision=1, text=None))
    assert (await store.processed_notes(7, 1))['view']['doc']['notes'][0]['stale']
    await produce_fresh()
    speakers = await store.get_speakers(7, 1)
    speaker = speakers['speakers'][0]
    await store.update_speaker(7, 1, speaker['speaker_id'], SpeakerUpdate(name='Alice', expected_revision=speaker['revision']))
    assert (await store.processed_notes(7, 1))['view']['doc']['notes'][0]['stale']
    await produce_fresh()
    state = await store.processed_notes(7, 1)
    assert state['view']['doc']['notes'][0]['speaker'] == 'Alice'
    assert state['view']['doc']['notes'][0]['evidence'][0]['revision'] == 2
    await dispatch_revisions(store, redis)
    assert any('note' in fields for _, fields in await redis.xrange('proc:meeting:1'))
    await store.merge_processed_view(1, view_id='copilot-notes', kind='cleaned_transcript',
        notes=[{'id':'s1','text':'stale legacy overwrite'}], source_cursor='999-0')
    assert (await store.processed_notes(7, 1))['view']['doc']['notes'][0]['text'] != 'stale legacy overwrite'
    async with sf() as db:
        row = (await db.execute(select(Transcription).where(Transcription.meeting_id == 1))).scalars().one()
        assert row.text == raw
    await store.prepare_completed_artifact_deletion(7, 1)
    await store.finalize_completed_artifact_deletion(7, 1)
    assert await store.processed_notes(7, 1) is None
    assert await redis.xlen(REQUESTS) == 0 and await redis.xlen(RESULTS) == 0
    await redis.aclose()
    await engine.dispose()
    print(json.dumps({'postgres_redis_canonical_notes': 'PASS', 'checks': ['serialized claims', 'delayed result rejected',
        'exact source evidence', 'idempotent result replay', 'restore revision', 'speaker rename',
        'approved outbox publication', 'legacy replay fenced', 'raw ASR unchanged', 'artifact queue purge'],
        'inference': 'actual worker function with deterministic injected CompletionPort'}))


if __name__ == '__main__':
    asyncio.run(main())
