"""Owner-authorized, durable English translations; raw/canonical transcripts are read-only.

Clients advance one ready phrase per POST while a translated view is open. SQLite
leases deduplicate concurrent web/extension requests, including separate API processes.
Provider failures back off without affecting capture; GET never invokes inference.
"""
from __future__ import annotations

from contextlib import contextmanager
import sqlite3
import time
import uuid
from pathlib import Path

from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from control_plane.meeting_knowledge import meeting_get
from shared.translation_text import visible_translation
from shared.translation_groups import TAIL_QUIET_SECONDS, phrases, source_fingerprint, tail_fingerprint


class Advance(BaseModel):
    model_config = ConfigDict(extra='forbid')
    retry: bool = False
    segment_ids: list[str] = Field(default_factory=list, max_length=128)


class TranslationStore:
    def __init__(self, path: Path):
        self.path = path

    @contextmanager
    def connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.executescript('''
            CREATE TABLE IF NOT EXISTS phrase_translations (
                owner TEXT, meeting INTEGER, phrase TEXT, source_hash TEXT, translated TEXT,
                PRIMARY KEY(owner, meeting, phrase));
            CREATE TABLE IF NOT EXISTS translation_tails (
                owner TEXT, meeting INTEGER, source_hash TEXT, observed_at REAL,
                PRIMARY KEY(owner, meeting));
            CREATE TABLE IF NOT EXISTS translation_jobs (
                owner TEXT, meeting INTEGER, token TEXT DEFAULT '', lease REAL DEFAULT 0,
                failures INTEGER DEFAULT 0, retry_at REAL DEFAULT 0,
                PRIMARY KEY(owner, meeting));
        ''')
        try:
            yield connection
        finally:
            connection.close()

    def observe(self, owner, meeting, segments):
        """Use observed stability, not capture wall time: delayed ASR must still be buffered."""
        digest, now = tail_fingerprint(segments), time.time()
        with self.connect() as db:
            db.execute('''INSERT INTO translation_tails VALUES (?,?,?,?)
                          ON CONFLICT(owner, meeting) DO UPDATE SET
                          source_hash=excluded.source_hash, observed_at=excluded.observed_at
                          WHERE translation_tails.source_hash != excluded.source_hash''',
                       (owner, meeting, digest, now))

    def snapshot(self, owner, meeting, segments, live=False):
        with self.connect() as db:
            cached = {row['phrase']: row for row in db.execute(
                'SELECT * FROM phrase_translations WHERE owner=? AND meeting=?', (owner, meeting))}
            job = db.execute('SELECT * FROM translation_jobs WHERE owner=? AND meeting=?', (owner, meeting)).fetchone()
            tail = db.execute('SELECT * FROM translation_tails WHERE owner=? AND meeting=?', (owner, meeting)).fetchone()
        now = time.time()
        tail_ready = not live or bool(tail and tail['source_hash'] == tail_fingerprint(segments)
                                      and now - tail['observed_at'] >= TAIL_QUIET_SECONDS)
        rows = []
        for group in phrases(segments, tail_ready=tail_ready):
            saved = cached.get(group['group_id'])
            translated = None
            if group['ready'] and saved and saved['source_hash'] == source_fingerprint(group):
                try:
                    translated = visible_translation(saved['translated'])
                except ValueError:
                    pass
            rows.append({**group, 'translated_text': translated})
        pending = sum(row['translated_text'] is None for row in rows)
        running = bool(job and job['lease'] > now)
        paused = bool(job and job['retry_at'] > now)
        return {'version': 'meeting-translation.v2', 'meeting_id': meeting, 'target_language': 'en',
                'status': 'complete' if not pending else 'running' if running else 'paused' if paused else 'pending',
                'retry_after': max(0, int(job['retry_at'] - now) + 1) if paused else 0,
                'total': len(rows), 'completed': len(rows) - pending, 'groups': rows}

    def claim(self, owner, meeting, retry=False):
        now, token = time.time(), uuid.uuid4().hex
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('INSERT OR IGNORE INTO translation_jobs(owner, meeting) VALUES (?,?)', (owner, meeting))
            row = db.execute('SELECT * FROM translation_jobs WHERE owner=? AND meeting=?', (owner, meeting)).fetchone()
            if row['lease'] > now or (row['retry_at'] > now and not retry):
                db.commit()
                return None
            db.execute('UPDATE translation_jobs SET token=?, lease=?, retry_at=0 WHERE owner=? AND meeting=?',
                       (token, now + 120, owner, meeting))
            db.commit()
        return token

    def finish(self, owner, meeting, token, group, translated):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            job = db.execute('SELECT * FROM translation_jobs WHERE owner=? AND meeting=?', (owner, meeting)).fetchone()
            if not job or job['token'] != token:
                db.commit()
                return
            if translated:
                db.execute('INSERT OR REPLACE INTO phrase_translations VALUES (?,?,?,?,?)',
                           (owner, meeting, group['group_id'], source_fingerprint(group), translated))
                failures, retry_at = 0, 0
            else:
                failures = job['failures'] + 1
                retry_at = time.time() + (15 if failures == 1 else 60 if failures == 2 else 300)
            db.execute('UPDATE translation_jobs SET token=?, lease=0, failures=?, retry_at=? WHERE owner=? AND meeting=?',
                       ('', failures, retry_at, owner, meeting))
            db.commit()


def register(app, subject_of, root: Path, meeting_api_url: str, complete):
    # Outside workspace Git trees; persisted by the existing agent workspace volume.
    store = TranslationStore(root / '.meeting-translations' / 'translations.sqlite3')

    def load(request, meeting_id):
        if meeting_id < 1:
            raise HTTPException(422, 'Invalid meeting')
        subject = subject_of(request)
        canonical = meeting_get(meeting_api_url, subject, meeting_id, f'/transcripts/by-id/{meeting_id}/canonical')
        meeting = meeting_get(meeting_api_url, subject, meeting_id, f'/meetings/{meeting_id}')
        segments = [row for row in canonical.get('segments', [])
                    if row.get('segment_id') and row.get('completed') is not False and row.get('text', '').strip()]
        # The canonical contract bounds the archive; reject unsupported inputs before inference.
        if len(segments) > 2000 or any(len(row['text']) > 10000 for row in segments):
            raise HTTPException(413, 'Transcript exceeds translation limits')
        segments.sort(key=lambda row: row.get('start_ms', 0))
        live = meeting.get('status') not in {'completed', 'stopped', 'failed', 'past', 'cancelled'}
        store.observe(subject, meeting_id, segments)
        return subject, segments, live

    @app.get('/api/meeting-translations/{meeting_id}')
    def read(request: Request, meeting_id: int):
        subject, segments, live = load(request, meeting_id)  # Reauthorize even a fully cached archive.
        return store.snapshot(subject, meeting_id, segments, live)

    @app.post('/api/meeting-translations/{meeting_id}')
    def advance(request: Request, meeting_id: int, body: Advance):
        subject, segments, live = load(request, meeting_id)
        state = store.snapshot(subject, meeting_id, segments, live)
        priority = {sid: index for index, sid in enumerate(body.segment_ids) if len(sid) <= 512}
        pending = [row for row in state['groups'] if row['ready'] and row['translated_text'] is None]
        # Rendered live turns may be a tail of the archive. Show their translations before backfill.
        pending.sort(key=lambda row: min((priority.get(member['segment_id'], len(priority)) for member in row['members']), default=len(priority)))
        missing = next(iter(pending), None)
        if not missing:
            return state
        token = store.claim(subject, meeting_id, body.retry)
        if token:
            translated = None
            try:
                candidate = complete(request, missing['source_text'])
                if isinstance(candidate, str) and candidate.strip() and len(candidate) <= 50000:
                    translated = visible_translation(candidate)
            except Exception:  # Provider details, credentials and transcript never enter logs/responses.
                pass
            finally:
                store.finish(subject, meeting_id, token, missing, translated)
        return store.snapshot(subject, meeting_id, segments, live)
