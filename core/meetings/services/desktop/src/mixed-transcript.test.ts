import assert from 'node:assert/strict';
import { mixedSegment } from './mixed-transcript.js';
import { TranscriptJournal } from './transcript-journal.js';
import type { ChunkSegment } from '@tina/mixed-pipeline';
const chunk={segmentId:'turn:0:0',text:'First words',startMs:1800000000000,endMs:1800000001000} as ChunkSegment;
const first=mixedSegment('connection-one',999,chunk,'',true),mic=mixedSegment('connection-one',1000,chunk,'You',true),
  reconnect=mixedSegment('connection-two',999,{...chunk,startMs:chunk.startMs+10000,endMs:chunk.endMs+10000},'',true);
assert.equal(new Set([first,mic,reconnect].map(s=>s.segment_id)).size,3);
assert.equal(mixedSegment('connection-one',999,chunk,'Renamed',true).segment_id,first.segment_id);
assert.equal(mixedSegment('connection-one',999,chunk,'',false).segment_id,first.segment_id);
const journal=new TranscriptJournal(':memory:');
try{
  const meeting={id:1,platform:'zoom',native_meeting_id:'mixed-reconnect',status:'completed',start_time:new Date().toISOString(),segments:[first,mic,reconnect]};
  journal.save(meeting);assert.equal((journal.document(meeting) as any).segments.length,3);
  journal.correct('zoom/mixed-reconnect',first,0,'Accepted user edit');
  assert.equal(journal.liveSegment('zoom/mixed-reconnect',reconnect)?.text,chunk.text,'Old turn-zero edit cannot leak into a new connection');
  console.log('PASS mixed source IDs: mic/tab/reconnect counters cannot collide; repaint/draft stable and edited history isolated');
}finally{journal.close();}
