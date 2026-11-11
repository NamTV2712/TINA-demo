import { describe, it, expect } from 'vitest';
import { voiceActivity } from '../voiceActivity';
import { voiceActivity as extensionActivity } from '../../../../extension/src/voice-activity';
const now = 1800000000000;
const snapshot = (state: string) => ({ available:true, policy:{enabled:true}, runtime:{state,session_active:true,heartbeat_fresh:true,kws:{status:'ready',observed_at_ms:now}} });

describe.each([['Terminal',voiceActivity],['Extension',extensionActivity]] as const)('%s voice activity',(_name,project)=>{
  it('shows only fresh session-bound voice readiness and maps the four stages',()=>{
    for (const state of ['LISTENING','CAPTURING','THINKING','SPEAKING','QUIET'] as const) expect(project(snapshot(state),now)).toBe(state);
    expect(project(snapshot('constructor'),now)).toBe('UNAVAILABLE');
    const value=snapshot('LISTENING');
    expect(project({...value,runtime:{...value.runtime,heartbeat_fresh:false}},now)).toBe('UNAVAILABLE');
    expect(project({...value,runtime:{...value.runtime,session_active:false}},now)).toBe('NO_BOT');
    expect(project({...value,policy:{enabled:false}},now)).toBe('OFF');
    expect(project(value,now+15000)).toBe('UNAVAILABLE');
    expect(project({...value,runtime:{...value.runtime,kws:{status:'failed',observed_at_ms:now}}},now)).toBe('ERROR');
  });
  it('does not infer listening from transcript, missing runtime or closed meetings',()=>{
    expect(project(undefined,now)).toBe('CHECKING');
    for (const value of [null,{},[],true,{runtime:{state:'LISTENING'}},{segments:[{text:'Speech'}]}]) expect(project(value,now)).toBe('UNAVAILABLE');
    expect(project(snapshot('LISTENING'),now,true)).toBe('ENDED');
  });
});
