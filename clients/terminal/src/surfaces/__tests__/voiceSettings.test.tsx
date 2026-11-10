import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {SettingsDialog} from '../settings';
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
const services={wake:{method:'livekit_wakeword',engine:'LiveKit WakeWord',version:'2.1.1',device:'cpu',status:'no_active_bot',
  sessions:[] as Array<{meeting_id:number;status:string}>,names:['TINA ơi','hey TINA'],platforms:['google_meet']},voice_pipeline_configured:true,default_prepare_new_bots:true,
  new_meeting_policy:{enabled:true,include_transcript:true,documents:[],revision:0,wake_variants:[],noise_suppression:true,
    allow_general_knowledge:true,allow_web_search:true,engine:'livekit'},
  tts:{configured:true,ready:true,busy:false,model:'vieneu-v3-turbo',voice:'Trúc Ly',device:'cpu'}};

it('Settings exposes local KWS, question ASR and actual TTS metadata; saving only updates this account default',async()=>{
  const fetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    if(path==='/api/user/voice')return Response.json(init?.method==='PUT'?JSON.parse(init.body as string):{prepare_new_bots:null});
    if(path==='/api/user/transcription')return Response.json({effective:{label:'VieGem + LM'}});
    if(path==='/api/bots/voice/services')return Response.json(services);
    return new Response('',{status:404});
  });vi.stubGlobal('fetch',fetch);
  render(<SettingsDialog onClose={()=>{}}/>);
  fireEvent.click(screen.getByRole('button',{name:'Voice assistant'}));
  await screen.findByText('Trúc Ly');expect(screen.getByText(/Questions use VieGem \+ LM/)).toBeTruthy();
  expect(screen.getByText(/LiveKit WakeWord 2.1.1/)).toBeTruthy();
  expect(screen.getByText(/No active bot/)).toBeTruthy();
  expect(screen.getByText('TINA ơi · hey TINA')).toBeTruthy();
  const defaults=within(screen.getByRole('region',{name:'New meeting defaults'}));
  expect(defaults.getByText('LiveKit Agents')).toBeTruthy();
  expect(defaults.getAllByText('On')).toHaveLength(4);
  expect(screen.queryByLabelText('Active meeting')).toBeNull();
  expect(screen.queryByText('Meeting overrides (optional)')).toBeNull();
  fireEvent.change(screen.getByLabelText('Default for new Google Meet bots'),{target:{value:'off'}});
  expect(defaults.getAllByText('On')).toHaveLength(3);
  expect(defaults.getByText('Off')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Save default'}));
  await waitFor(()=>expect(fetch.mock.calls.some(([url,init])=>url==='/api/user/voice'&&init?.method==='PUT'&&init.body==='{"prepare_new_bots":false}')).toBe(true));
  expect(fetch.mock.calls.some(([url])=>String(url).includes('/meetings/'))).toBe(false);
});

it('Refresh shows actual per-bot KWS readiness and failure instead of claiming deployment readiness',async()=>{
  let status='ready';
  vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
    if(String(input)==='/api/user/voice')return Response.json({prepare_new_bots:null});
    if(String(input)==='/api/user/transcription')return Response.json({effective:{label:'Gipformer 1.5'}});
    if(String(input)==='/api/bots/voice/services')return Response.json({...services,wake:{...services.wake,status,sessions:[{meeting_id:14,status}]}});
    return new Response('',{status:404});
  }));
  render(<SettingsDialog onClose={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'Voice assistant'}));
  await screen.findByText('Meeting #14 · Ready');
  status='failed';fireEvent.click(screen.getByRole('button',{name:'Refresh status'}));
  await screen.findByText('Meeting #14 · Unavailable');
  expect(screen.getByText(/Questions use Gipformer 1.5/)).toBeTruthy();
});

it('preview is local WAV playback and its URL is revoked when settings closes',async()=>{
  const create=vi.fn(()=> 'blob:synthetic'),revoke=vi.fn();
  vi.stubGlobal('URL',class extends URL{static createObjectURL=create;static revokeObjectURL=revoke;});
  vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue();vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
  const fetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    if(path==='/api/user/voice')return Response.json({prepare_new_bots:null});
    if(path==='/api/user/transcription')return Response.json({});
    if(path==='/api/bots/voice/services')return Response.json(services);
    if(path==='/api/bots/voice/preview')return new Response(new Blob(['synthetic'],{type:'audio/wav'}));
    return new Response('',{status:404});
  });vi.stubGlobal('fetch',fetch);
  const view=render(<SettingsDialog onClose={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'Voice assistant'}));
  await screen.findByText('Trúc Ly');fireEvent.click(screen.getByRole('button',{name:'Preview voice'}));
  expect(await screen.findByLabelText('TINA voice preview')).toBeTruthy();
  expect(fetch.mock.calls.find(([url])=>url==='/api/bots/voice/preview')?.[1]?.method).toBe('POST');
  view.unmount();expect(revoke).toHaveBeenCalledWith('blob:synthetic');
});

it('room answer permissions preserve the full CAS policy and do not touch other rooms',async()=>{
  const policy={enabled:true,include_transcript:true,documents:['wiki/shared.md'],revision:9,wake_variants:['custom name'],noise_suppression:true,
    allow_general_knowledge:false,allow_web_search:false};
  const fetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    if(path==='/api/user/voice')return Response.json({prepare_new_bots:null});
    if(path==='/api/user/transcription')return Response.json({});
    if(path==='/api/bots/voice/services')return Response.json({...services,wake:{...services.wake,sessions:[{meeting_id:14,status:'ready'}]}});
    if(path==='/api/meetings/14/voice-assistant')return Response.json({policy:init?.method==='PUT'?{...JSON.parse(init.body as string),revision:10}:policy,replies:[{reason:'retrieval_empty'}]});
    if(path==='/api/workspace/meeting-knowledge/14')return Response.json({documents:[{path:'wiki/shared.md',title:'Shared'}]});
    return new Response('',{status:404});
  });vi.stubGlobal('fetch',fetch);
  render(<SettingsDialog onClose={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'Voice assistant'}));
  await screen.findByText('Meeting #14 · Ready');fireEvent.click(screen.getByText('Meeting overrides (optional)'));fireEvent.change(screen.getByLabelText('Active meeting'),{target:{value:'14'}});
  await screen.findByText('Last answer: retrieval empty');
  fireEvent.click(screen.getByLabelText('Allow general knowledge'));fireEvent.click(screen.getByLabelText('Allow public web search'));
  fireEvent.click(screen.getByRole('button',{name:'Save room settings'}));
  await screen.findByText('Saved. The current voice turn stops when settings change.');
  const body=JSON.parse(fetch.mock.calls.find(([url,init])=>url==='/api/meetings/14/voice-assistant'&&init?.method==='PUT')![1]!.body as string);
  expect(body).toEqual({...policy,allow_general_knowledge:true,allow_web_search:true});
});

it('LiveKit runtime is an explicit room choice and preserves source permissions',async()=>{
  const policy={enabled:true,include_transcript:true,documents:['wiki/shared.md'],revision:4,wake_variants:[],noise_suppression:true,
    allow_general_knowledge:true,allow_web_search:false,engine:'tina'};
  const fetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    if(path==='/api/user/voice')return Response.json({prepare_new_bots:null});
    if(path==='/api/user/transcription')return Response.json({});
    if(path==='/api/bots/voice/services')return Response.json({...services,wake:{...services.wake,sessions:[{meeting_id:14,status:'ready'}]}});
    if(path==='/api/meetings/14/voice-assistant')return Response.json({policy:init?.method==='PUT'?{...JSON.parse(init.body as string),revision:5}:policy,livekit_available:true});
    if(path==='/api/workspace/meeting-knowledge/14')return Response.json({documents:[]});
    return new Response('',{status:404});
  });vi.stubGlobal('fetch',fetch);
  render(<SettingsDialog onClose={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'Voice assistant'}));
  await screen.findByText('Meeting #14 · Ready');fireEvent.click(screen.getByText('Meeting overrides (optional)'));fireEvent.change(screen.getByLabelText('Active meeting'),{target:{value:'14'}});
  const runtime=await screen.findByLabelText('Voice runtime');fireEvent.change(runtime,{target:{value:'livekit'}});
  expect(screen.getByText(/Up to 3 concurrent meetings/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Save room settings'}));
  await screen.findByText('Saved. The current voice turn stops when settings change.');
  const body=JSON.parse(fetch.mock.calls.find(([url,init])=>url==='/api/meetings/14/voice-assistant'&&init?.method==='PUT')![1]!.body as string);
  expect(body).toEqual({...policy,engine:'livekit'});
});

it('new room defaults show LiveKit and four enabled options without saving or granting documents',async()=>{
  const policy={enabled:true,include_transcript:true,documents:[],revision:0,wake_variants:[],noise_suppression:true,
    allow_general_knowledge:true,allow_web_search:true,engine:'livekit'};
  const fetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    if(path==='/api/user/voice')return Response.json({prepare_new_bots:null});
    if(path==='/api/user/transcription')return Response.json({});
    if(path==='/api/bots/voice/services')return Response.json({...services,wake:{...services.wake,sessions:[{meeting_id:14,status:'ready'}]}});
    if(path==='/api/meetings/14/voice-assistant')return Response.json({policy,livekit_available:true});
    if(path==='/api/workspace/meeting-knowledge/14')return Response.json({documents:[{path:'wiki/linked.md',title:'Linked'}]});
    return new Response('',{status:404});
  });vi.stubGlobal('fetch',fetch);
  render(<SettingsDialog onClose={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'Voice assistant'}));
  await screen.findByText('Meeting #14 · Ready');fireEvent.click(screen.getByText('Meeting overrides (optional)'));fireEvent.change(screen.getByLabelText('Active meeting'),{target:{value:'14'}});
  expect((await screen.findByLabelText('Voice runtime') as HTMLSelectElement).value).toBe('livekit');
  for(const label of ['Enable voice','Use this meeting’s transcript','Allow general knowledge','Allow public web search'])
    expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('Linked') as HTMLInputElement).checked).toBe(false);
  expect(fetch.mock.calls.some(([,init])=>init?.method==='PUT')).toBe(false);
});
