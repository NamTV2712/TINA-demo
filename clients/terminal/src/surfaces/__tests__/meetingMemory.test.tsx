import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {MeetingMemory} from '../MeetingMemory';
import {parseRevisionFrame} from '../gatewayWS';
const fetchMock=vi.fn();
beforeEach(()=>{
  vi.stubGlobal('fetch',fetchMock);fetchMock.mockReset();
  HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('rejects malformed memory revision frames',()=>{
  const frame={type:'meeting.memory.updated',version:'meeting-memory-revision.v1',meeting_id:42,revision:3};
  expect(parseRevisionFrame(frame)).toEqual({meetingId:'42',segmentId:'memory',revision:3});
  expect(parseRevisionFrame({...frame,version:'other'})).toBeNull();
  expect(parseRevisionFrame({...frame,revision:0})).toBeNull();
  expect(parseRevisionFrame({...frame,meeting_id:'42'})).toBeNull();
});
it('shows exact evidence and ignores a response from the previous meeting',async()=>{
  const evidence={segment_id:'s1',revision:2,start_ms:1792522376000,end_ms:1792522378000,speaker_name:'Alice',quote:'We decided to ship.'};
  const data={meeting_id:42,canonical_revision:7,windows:[{id:'w1',evidence:[evidence],facts:[{id:'f1',type:'decision',text:evidence.quote,evidence:[evidence]}]}],facts:[{}]};
  let release!:(value:unknown)=>void;
  fetchMock.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  const view=render(<MeetingMemory meetingId="42"/>);
  fireEvent.click(screen.getByRole('button',{name:'Meeting memory'}));
  fetchMock.mockResolvedValue({ok:true,json:async()=>({...data,meeting_id:43,windows:[],facts:[]})});
  view.rerender(<MeetingMemory meetingId="43"/>);
  await screen.findByText('No finalized speech yet.');
  await act(async()=>{release({ok:true,json:async()=>data});});
  expect(screen.queryByText('Decision · candidate')).toBeNull();
  view.unmount();
  fetchMock.mockResolvedValue({ok:true,json:async()=>data});
  render(<MeetingMemory meetingId="42"/>);
  fireEvent.click(screen.getByRole('button',{name:'Meeting memory'}));
  await screen.findByText('Decision · candidate');
  expect(screen.getByText(/text revision 2/)).toBeTruthy();
  expect(screen.getAllByText(evidence.quote).length).toBeGreaterThan(0);
});

it('filters suggestion-free windows without changing the memory request',async()=>{
  const evidence={segment_id:'s1',revision:1,start_ms:1792522376000,end_ms:1792522378000,speaker_name:'Alice',quote:'We decided to ship.'};
  const fact={id:'f1',type:'decision',text:evidence.quote,evidence:[evidence]};
  fetchMock.mockResolvedValue({ok:true,json:async()=>({meeting_id:42,canonical_revision:1,windows:[{id:'w1',evidence:[evidence],facts:[fact]},{id:'w2',evidence:[evidence],facts:[]}],facts:[fact]})});
  render(<MeetingMemory meetingId="42"/>);
  fireEvent.click(screen.getByRole('button',{name:'Meeting memory'}));
  const toggle=await screen.findByRole('checkbox',{name:'Only windows with suggestions'});
  expect(screen.getByText(/Window 2/)).toBeTruthy();
  fireEvent.click(toggle);
  expect(screen.queryByText(/Window 2/)).toBeNull();
  expect(screen.getByText(/Window 1/)).toBeTruthy();
  fireEvent.click(toggle);
  expect(screen.getByText(/Window 2/)).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
