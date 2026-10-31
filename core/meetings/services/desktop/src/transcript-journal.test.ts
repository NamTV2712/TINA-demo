import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptJournal, RevisionConflict } from './transcript-journal.js';
import type { Meeting } from './desktop.js';

const directory = mkdtempSync(join(tmpdir(), 'tina-journal-'));
const path = join(directory, 'transcripts.sqlite');
let journal = new TranscriptJournal(path);
const base = 1792490000000;
const meeting: Meeting = { id: 1, platform: 'desktop', native_meeting_id: 'capture', status: 'completed',
  start_time: new Date(base).toISOString(), segments: [{ segment_id: 'seg/1', speaker: 'You',
    speaker_key: 'ch-1000:1', text: '  API   thứ sáu  ', start: base / 1000, end: base / 1000 + 1, completed: true }] };
try {
  journal.save(meeting);
  journal.capture('desktop/capture', 'session', 1000, base, new Float32Array(1600).fill(0.0005));
  journal.capture('desktop/capture', 'session', 999, base, new Float32Array(1600).fill(0.1));
  journal.capture('desktop/capture', 'session', 1000, base + 500, new Float32Array(1600).fill(0.001));
  let doc = journal.document(meeting) as any;
  const validate = new Ajv2020({ strict: true }).compile(JSON.parse(readFileSync(new URL('../../../contracts/transcript-document.v1/transcript-document.schema.json', import.meta.url), 'utf8')));
  assert.ok(validate(doc), JSON.stringify(validate.errors));
  assert.equal(doc.segments[0].raw_text, '  API   thứ sáu  ');
  assert.equal(doc.segments[0].normalized_text, 'API thứ sáu');
  assert.equal(doc.segments[0].audio.length, 1);
  assert.equal(doc.segments[0].audio[0].chunk_count, 2);
  assert.equal(doc.segments[0].audio[0].end_ms - doc.segments[0].audio[0].start_ms, 600);
  const wav = journal.audio('desktop/capture', doc.segments[0].audio[0].chunk_id)!;
  assert.equal(wav.readUInt16LE(20), 3);
  assert.ok([new Float32Array([0.0005])[0], new Float32Array([0.001])[0]].includes(wav.readFloatLE(44)));
  assert.equal(journal.audio('desktop/other', doc.segments[0].audio[0].chunk_id), null);
  const clip = journal.clip('desktop/capture', meeting.segments[0])!;
  assert.equal(clip.length, 44 + 16000 * 4);
  assert.equal(clip.readFloatLE(44 + 3200 * 4), 0); // original silence gap is retained
  assert.equal(clip.readFloatLE(44 + 8000 * 4), new Float32Array([0.001])[0]);
  journal.correct('desktop/capture', meeting.segments[0], 0, 'API thứ Sáu.');
  assert.throws(() => journal.correct('desktop/capture', meeting.segments[0], 0, 'lost update'), RevisionConflict);
  assert.equal(journal.view(meeting).segments[0].text, 'API thứ Sáu.');
  assert.equal(meeting.segments[0].text, '  API   thứ sáu  ');
  journal.saveRefinement({ version: 'transcript-refinement.v1', id: 'in-flight', meeting: 'desktop/capture',
    status: 'running', model: 'custom', backend: 'FunASR', created_at: new Date().toISOString(), items: [
      { segment_id: 'seg/1', expected_revision: 1, state: 'ready', text: 'API thứ Sáu.', audio_sha256: '0'.repeat(64) },
      { segment_id: 'unfinished', expected_revision: 0, state: 'pending' },
    ] });
  journal.close(); journal = new TranscriptJournal(path);
  assert.equal(journal.load().length, 1);
  assert.equal(journal.view(journal.load()[0]).segments[0].text, 'API thứ Sáu.');
  assert.equal(journal.refinement('desktop/capture')?.status, 'interrupted');
  assert.equal(journal.refinement('desktop/capture')?.items[0].text, 'API thứ Sáu.');
  assert.equal(journal.refinement('desktop/capture')?.items[1].state, 'pending');
  journal.correct('desktop/capture', meeting.segments[0], 1, null);
  doc = journal.document(meeting) as any;
  assert.equal(doc.segments[0].text, '  API   thứ sáu  ');
  assert.equal(doc.segments[0].revision, 2);
  assert.equal(doc.segments[0].history[0].text, 'API thứ Sáu.');
  assert.throws(() => journal.capture('desktop/capture', 'bad', 0, base, new Float32Array([NaN])));
  for (const [id, raw] of [['legacy-empty', ''], ['legacy-long', 'Đ'.repeat(10001)]]) {
    const segment = { ...meeting.segments[0], segment_id: id, text: raw };
    meeting.segments.push(segment); journal.save(meeting, segment);
    journal.correct('desktop/capture', segment, 0, 'edited');
    journal.correct('desktop/capture', segment, 1, null);
    assert.equal(journal.view(meeting).segments.find(s => s.segment_id === id)?.text, raw);
  }
  journal.capture('desktop/capture', 'overlapping-session', 1000, base + 50, new Float32Array(1600).fill(0.02));
  assert.equal(journal.clip('desktop/capture', meeting.segments[0]), null); // never mix ambiguous sessions
  meeting.status = 'active'; journal.save(meeting);
  assert.equal(journal.load()[0].status, 'interrupted');
  console.log('PASS journal: raw text, source channels, clock gaps, audio bytes, revisions, conflict, restore and restart recovery');
} finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
