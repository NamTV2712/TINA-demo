import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { TranscriptJournal } from './transcript-journal.js';
import { fingerprint } from './foundation.js';
import type { Meeting } from './desktop.js';

const dir = mkdtempSync(join(tmpdir(), 'tina-foundation-')), path = join(dir, 'transcripts.sqlite');
let journal = new TranscriptJournal(path);
const epoch = 1800000000000, key = 'google_meet/foundation';
const meeting: Meeting = { id: 1, platform: 'google_meet', native_meeting_id: 'foundation', status: 'completed', start_time: new Date(epoch).toISOString(),
  segments: [{segment_id:'ch-0:one',speaker_key:'ch-0:one',speaker:'Hà',text:'Tôi sẽ review API.',start:epoch/1000,end:epoch/1000+1,completed:true}] };
try {
  const session = journal.captureSession(key, 'fixture');
  journal.receivePcm(key, session, 0, 0, epoch, new Float32Array(8000).fill(.1));
  journal.receivePcm(key, session, 0, 12000, epoch+750, new Float32Array(4000).fill(.2));
  journal.save(meeting);
  const first: any = journal.foundation(meeting);
  const ajv = new Ajv2020({strict:false}); addFormats(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(new URL('../../../contracts/stt-foundation.v1/stt-foundation.schema.json', import.meta.url),'utf8')));
  assert(validate(first), JSON.stringify(validate.errors));
  assert.equal(first.sequence,1); assert.equal(first.segments[0].audio.length,2,'Missing PCM must remain an explicit gap');
  assert.deepEqual(first.segments[0].audio.map((r:any)=>[r.start_sample,r.end_sample]),[[0,8000],[12000,16000]]);
  assert.equal(first.segments[0].audio[1].start_us,(epoch+750)*1000);
  assert.deepEqual(journal.foundation(meeting),first,'Unchanged snapshots are idempotent');
  journal.correct(key,meeting.segments[0],0,'Câu được sửa.');
  const edited: any = journal.foundation(meeting);
  assert.equal(edited.sequence,2);assert.equal(edited.segments[0].segment_uid,first.segments[0].segment_uid);
  assert.equal(edited.segments[0].revision,1);assert.equal(edited.segments[0].raw_text,first.segments[0].raw_text);
  journal.close();journal=new TranscriptJournal(path);
  assert.deepEqual(journal.foundation(journal.load()[0]),edited,'IDs, sequence, revision and sample references survive restart');
  const {sequence,_ignore,fingerprint:hash,...base}={...edited,_ignore:null};
  assert.equal(fingerprint(base),hash);
  if(process.env.TINA_FOUNDATION_FIXTURE)writeFileSync(process.env.TINA_FOUNDATION_FIXTURE,JSON.stringify(edited,null,2)+'\n');
  console.log('PASS foundation: portable IDs, exact sample references/gaps, revision history, idempotent snapshot and restart');
} finally { journal.close();rmSync(dir,{recursive:true,force:true}); }
