import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptJournal } from './transcript-journal.js';
import type { Meeting } from './desktop.js';
import type { RefinementJob } from './refinement.js';

const directory = mkdtempSync(join(tmpdir(), 'tina-canonical-'));
let journal = new TranscriptJournal(join(directory, 'transcripts.sqlite'));
const meeting: Meeting = { id: 1, platform: 'desktop', native_meeting_id: 'sample', status: 'completed', start_time: new Date().toISOString(),
  segments: [{ segment_id: 's1', speaker: 'You', text: 'rawneedle', start: 100, end: 101, completed: true, speaker_key: 'ch-1000:one' }] };
const key = 'desktop/sample';
try {
  journal.save(meeting);
  assert.equal(journal.search('rawneedle', [key]).length, 1);
  journal.correct(key, meeting.segments[0], 0, 'manualneedle');
  const late=journal.liveSegment(key,{...meeting.segments[0],text:'stale ASR',start:5,end:9,speaker_key:'ch-999:wrong'});
  assert.equal(late?.start,100);assert.equal(late?.end,101);assert.equal(late?.speaker_key,'ch-1000:one');assert.equal(late?.text,'manualneedle');
  assert.equal(journal.search('rawneedle', [key]).length, 0);
  assert.equal(journal.search('manualneedle', [key]).length, 1);
  assert.equal(journal.search('manualneedle', []).length, 0);
  assert.throws(() => journal.correct(key, meeting.segments[0], 0, 'stale'));
  assert.equal(journal.pendingRevisions().length, 1);
  const job: RefinementJob = { version: 'transcript-refinement.v1', id: 'job', meeting: key, status: 'completed', model: 'custom', backend: 'FunASR', created_at: new Date().toISOString(),
    items: [{ segment_id: 's1', expected_revision: 1, state: 'ready', text: 'refinedneedle', audio_sha256: '0'.repeat(64) }] };
  journal.saveRefinement(job);
  journal.applyRefinement(job, meeting.segments[0], job.items[0]);
  assert.equal(journal.search('manualneedle', [key]).length, 0);
  assert.equal(journal.search('refinedneedle', [key]).length, 1);
  journal.correct(key, meeting.segments[0], 2, null);
  assert.equal(journal.search('refinedneedle', [key]).length, 0);
  assert.equal(journal.search('rawneedle', [key]).length, 1);
  const pending = journal.pendingRevisions();
  assert.deepEqual(pending.map(r => r.event.revision), [1, 2, 3]);
  assert.deepEqual(pending.map(r => r.event.kind), ['manual', 'refinement', 'restore']);
  assert.ok(pending.every(r => !('text' in r.event) && !('actor_id' in r.event)));
  journal.close(); journal = new TranscriptJournal(join(directory, 'transcripts.sqlite'));
  assert.deepEqual(journal.pendingRevisions(), pending); // delivery survives restart
  assert.equal(journal.search('rawneedle', [key]).length, 1);
  journal.acknowledgeRevision(pending[0].id); journal.acknowledgeRevision(pending[0].id);
  assert.equal(journal.pendingRevisions().length, 2);
  // Failure after the history/index writes must roll the complete transaction back.
  (journal as any).db.exec("CREATE TRIGGER reject_revision BEFORE INSERT ON transcript_outbox BEGIN SELECT RAISE(ABORT,'blocked'); END");
  assert.throws(() => journal.correct(key, meeting.segments[0], 3, 'mustnotpersist'));
  assert.equal((journal.document(meeting) as any).segments[0].revision, 3);
  assert.equal(journal.search('mustnotpersist', [key]).length, 0);
  assert.equal(journal.search('rawneedle', [key]).length, 1);
  assert.equal(journal.pendingRevisions().length, 2);
  assert.equal(meeting.segments[0].text, 'rawneedle');
  console.log('PASS canonical SQLite: manual/refinement/restore, current-text FTS, exact ack, restart and atomic rollback');
} finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
