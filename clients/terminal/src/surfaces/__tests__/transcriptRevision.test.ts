import { parseRevisionFrame } from '../gatewayWS';
import { describe, it, expect } from 'vitest';
import { mergeDurableRevisions } from '../../canvas/useMeeting';

describe('canonical revision notifications', () => {
  it('refreshes notes from metadata notifications and clears notes after artifact deletion', () => {
    expect(parseRevisionFrame({type:'meeting.notes.updated',version:'processed-notes.v1',meeting_id:42,revision:3})).toEqual({meetingId:'42',segmentId:'notes',revision:3});
    expect(mergeDurableRevisions({lines:[],notes:[{id:'a',text:'deleted',publication_revision:7}]}, {lines:[],notes:[]})).toEqual({lines:[],notes:[]});
  });
  it('accepts metadata identity and rejects malformed revisions', () => {
    const event = { type: 'transcript.revised', version: 'transcript-revision.v1', meeting_id: 42, segment_id: 's/1', revision: 2 };
    expect(parseRevisionFrame(event)).toEqual({ meetingId: '42', segmentId: 's/1', revision: 2 });
    for (const invalid of [{ ...event, revision: 0 }, { ...event, revision: 1.5 }, { ...event, meeting_id: '42' }, { ...event, segment_id: '' }, null]) expect(parseRevisionFrame(invalid)).toBeNull();
  });
  it('keeps accepted text against older snapshots, then accepts Restore as a newer revision', () => {
    const line = { id: 's1', revision: 2, t: '00:01', speaker: 'You', text: 'accepted' };
    const previous = { lines: [line], notes: [] };
    expect(mergeDurableRevisions(previous, { lines: [{ ...line, revision: 0, text: 'late raw' }], notes: [] }).lines[0].text).toBe('accepted');
    expect(mergeDurableRevisions(previous, { lines: [{ ...line, revision: 3, text: 'original' }], notes: [] }).lines[0].text).toBe('original');
  });
});

it('speaker revisions invalidate the snapshot on a separate identity key',()=>{
  expect(parseRevisionFrame({type:'speaker.revised',version:'speaker-revision.v1',meeting_id:42,speaker_id:'person',revision:3})).toEqual({meetingId:'42',segmentId:'speaker:person',revision:3});
  const line={id:'s1',t:'00:01',speaker:'Known',text:'corrected',revision:2,speakerId:'person',speakerRevision:4};
  const previous={lines:[line],notes:[]};
  const next={lines:[{...line,speaker:'New name',speakerRevision:5,text:'stale',revision:0}],notes:[]};
  expect(mergeDurableRevisions(previous,next).lines[0]).toMatchObject({text:'corrected',revision:2,speaker:'New name',speakerRevision:5});
});

