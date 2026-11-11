import React from 'react';
import { cleanup, render, screen, act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { VoiceActivity } from '../VoiceActivity';
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});
const body=(state='LISTENING')=>({available:true,policy:{enabled:true},runtime:{state,session_active:true,heartbeat_fresh:true,kws:{status:'ready',observed_at_ms:Date.now()}}});
it('scopes requests to the selected meeting and expires readiness while a request hangs',async()=>{
  vi.useFakeTimers();let calls=0;
  vi.stubGlobal('fetch',vi.fn(async()=>{calls++;return calls===1?Response.json(body()):new Promise(()=>{});}));
  render(<VoiceActivity meetingId="42"/>);
  await act(async()=>{await Promise.resolve();});
  expect(screen.getByRole('status',{name:'TINA · Chờ gọi tên'})).toBeTruthy();
  await act(async()=>{await vi.advanceTimersByTimeAsync(15001);});
  expect(screen.getByRole('status',{name:'TINA · Mất kết nối voice'})).toBeTruthy();
});
it('rejects access failures, resets across meetings and renders ended meetings without polling',async()=>{
  const fetch=vi.fn(async(_url:string,_init?:RequestInit)=>Response.json(body('SPEAKING')));vi.stubGlobal('fetch',fetch);
  const view=render(<VoiceActivity meetingId="42"/>);
  expect(await screen.findByRole('status',{name:'TINA · Đang trả lời'})).toBeTruthy();
  fetch.mockImplementation(async()=>new Response('',{status:403}));
  view.rerender(<VoiceActivity meetingId="43"/>);
  expect(await screen.findByRole('status',{name:'TINA · Mất kết nối voice'})).toBeTruthy();
  expect(fetch.mock.calls.map(args=>args[0])).toContain('/api/meetings/43/voice-assistant');
  const before=fetch.mock.calls.length;view.rerender(<VoiceActivity meetingId="43" ended/>);
  expect(screen.getByRole('status',{name:'TINA · Đã kết thúc'})).toBeTruthy();
  expect(fetch.mock.calls.length).toBe(before);
});
