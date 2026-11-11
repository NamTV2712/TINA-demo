"use client";
import { useEffect, useRef, useState } from 'react';

interface Services {
  new_meeting_policy?:RoomPolicy;
  wake:{method:string;names:string[];platforms:string[];engine?:string;version?:string;device?:string;
    status?:string;sessions?:Array<{meeting_id:number;status:string}>};voice_pipeline_configured:boolean;default_prepare_new_bots:boolean;
  tts:{configured:boolean;ready:boolean;busy:boolean;model:string|null;voice:string|null;device:string|null};
}
const button={padding:'8px 12px',border:'1px solid var(--line2)',borderRadius:8,background:'var(--panel2)',color:'var(--t1)',cursor:'pointer',boxSizing:'border-box',maxWidth:'100%'} as const;
const card={padding:16,border:'1px solid var(--line2)',borderRadius:10,display:'grid',gridTemplateColumns:'minmax(0,1fr)',minWidth:0,gap:10} as const;

export function VoiceSettings(){
  const [services,setServices]=useState<Services|null>(null),[backend,setBackend]=useState('Unavailable');
  const [saved,setSaved]=useState('default'),[value,setValue]=useState('default');
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[previewBusy,setPreviewBusy]=useState(false);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[audioUrl,setAudioUrl]=useState('');
  const controller=useRef<AbortController|null>(null),audio=useRef<HTMLAudioElement|null>(null),alive=useRef(true);
  const kwsLabels:Record<string,string>={ready:'Ready',starting:'Starting…',failed:'Unavailable',off:'Disabled',
    unknown:'Needs a new bot',no_active_bot:'No active bot'};
  const kwsLabel = (status?:string) => kwsLabels[status||'']||'Checking…';
  const defaultVoice=services?.voice_pipeline_configured&&(value==='on'||(value==='default'&&services.default_prepare_new_bots));
  useEffect(()=>{
    alive.current=true;const abort=new AbortController();
    void Promise.all([fetch('/api/user/voice',{cache:'no-store',signal:abort.signal}),
      fetch('/api/bots/voice/services',{cache:'no-store',signal:abort.signal}),
      fetch('/api/user/transcription',{cache:'no-store',signal:abort.signal})]).then(async([prefs,status,asr])=>{
        if(!prefs.ok||!status.ok)throw Error('Could not load voice settings.');
        const [p,s,t]=await Promise.all([prefs.json(),status.json(),asr.ok?asr.json():{effective:undefined}]);
        if(abort.signal.aborted)return;
        const selection=p.prepare_new_bots==null?'default':p.prepare_new_bots?'on':'off';
        setSaved(selection);setValue(selection);setServices(s);setBackend(t.effective?.label||'Choose a model in Settings → Models → Transcription');
      }).catch(()=>{if(!abort.signal.aborted)setError('Could not load voice settings.');})
      .finally(()=>{if(!abort.signal.aborted)setLoading(false);});
    return()=>{alive.current=false;abort.abort();controller.current?.abort();audio.current?.pause();};
  },[]);
  useEffect(()=>{if(!audioUrl)return;void audio.current?.play().catch(()=>{if(alive.current)setNotice('Press Play to hear the preview.');});
    return()=>URL.revokeObjectURL(audioUrl);},[audioUrl]);
  async function save(){
    setBusy(true);setError('');setNotice('');
    try{const r=await fetch('/api/user/voice',{method:'PUT',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({prepare_new_bots:value==='default'?null:value==='on'})});
      if(!r.ok)throw Error();if(alive.current){setSaved(value);setNotice('Saved. Applies to new Google Meet bots.');}
    }catch{if(alive.current)setError('Could not save the default.');}finally{if(alive.current)setBusy(false);}
  }
  async function check(){
    setBusy(true);setError('');setNotice('');
    try{const r=await fetch('/api/bots/voice/services',{cache:'no-store'});if(!r.ok)throw Error();const s=await r.json();
      if(alive.current){setServices(s);setNotice(s.tts.ready?'TTS is connected.':'TTS is unavailable. Check the server configuration.');}
    }catch{if(alive.current)setError('Could not check voice services.');}finally{if(alive.current)setBusy(false);}
  }
  async function preview(){
    controller.current?.abort();const abort=new AbortController();controller.current=abort;
    setPreviewBusy(true);setError('');setNotice('');audio.current?.pause();
    try{const r=await fetch('/api/bots/voice/preview',{method:'POST',signal:abort.signal});
      if(!r.ok)throw Error(r.status===429?'Wait a few seconds before trying again.':'Could not create the preview. Check TTS.');
      const blob=await r.blob();if(!abort.signal.aborted&&alive.current)setAudioUrl(URL.createObjectURL(blob));
    }catch(e){if(!abort.signal.aborted&&alive.current)setError((e as Error).message);}
    finally{if(alive.current&&!abort.signal.aborted)setPreviewBusy(false);}
  }
  return <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr)',gap:12,maxWidth:620,minWidth:0}} aria-label="Voice assistant settings">
    <section style={card} aria-label="New meeting defaults">
      <div style={{display:'flex',gap:12,justifyContent:'space-between',flexWrap:'wrap'}}>
        <strong>New meeting defaults</strong>
        <span>{services?.new_meeting_policy?.engine==='livekit'?'LiveKit Agents':services?.new_meeting_policy?.engine==='tina'?'TINA':'Checking…'}</span>
      </div>
      <span style={{fontSize:12,color:'var(--t3)'}}>Applied automatically to new Google Meet meetings. No room setup needed.</span>
      <dl style={{display:'grid',gap:8,margin:0,fontSize:13}}>
        {([['enabled','Voice assistant'],['include_transcript','Meeting transcript'],
          ['allow_general_knowledge','General knowledge'],['allow_web_search','Public web search']] as const).map(([key,label])=>
          <div key={key} style={{display:'flex',justifyContent:'space-between',gap:12}}>
            <dt>{label}</dt><dd style={{margin:0,color:'var(--t2)'}}>{!services?.new_meeting_policy?'Unavailable':(key==='enabled'?defaultVoice:services.new_meeting_policy[key])?'On':'Off'}</dd>
          </div>)}
      </dl>
      <label htmlFor="voice-default" style={{fontSize:12,color:'var(--t3)'}}>Default for new Google Meet bots</label>
      <select id="voice-default" style={{...button,width:'100%'}} value={value} disabled={loading||busy} onChange={e=>setValue(e.target.value)}>
        <option value="default">Use deployment default{services?` (${services.default_prepare_new_bots?'on':'off'})`:''}</option>
        <option value="on">Enable voice</option><option value="off">Disable voice</option>
      </select>
      {saved!==value&&<button type="button" style={{...button,justifySelf:'start'}} disabled={loading||busy} onClick={save}>Save default</button>}
      <span style={{fontSize:12,color:'var(--t3)'}}>Saved meeting settings stay unchanged. Documents require sharing.</span>
    </section>
    <RoomVoiceSettings sessions={services?.wake.sessions||[]}/>
    <section style={card} aria-label="Wake phrases">
      <div style={{display:'flex',gap:12,justifyContent:'space-between',flexWrap:'wrap'}}>
        <strong>Wake word</strong><span role="status">{kwsLabel(services?.wake.status)}</span>
      </div>
      <div>{services?.wake.names.join(' · ')||'Loading phrases…'}</div>
      <span style={{fontSize:12,color:'var(--t3)'}}>{services?.wake.engine||'LiveKit WakeWord'} {services?.wake.version||''} · Local CPU · Google Meet</span>
      <span style={{fontSize:12,color:'var(--t3)'}}>Questions use {backend}. Starts with a new voice-enabled bot.</span>
      {!!services?.wake.sessions?.length&&<div style={{fontSize:12,color:'var(--t3)'}}>
        {services.wake.sessions.map(s=><div key={s.meeting_id}>Meeting #{s.meeting_id} · {kwsLabel(s.status)}</div>)}
      </div>}
    </section>
    <section style={card} aria-label="Speech output">
      <div style={{display:'flex',gap:12,justifyContent:'space-between',flexWrap:'wrap'}}><strong>Speech output</strong>
        <span role="status">{loading?'Checking…':services?.tts.ready?services.tts.busy?'Synthesizing…':'Ready':services?.tts.configured?'Offline':'Not configured'}</span></div>
      <dl style={{display:'flex',flexWrap:'wrap',gap:12,margin:0,fontSize:13}}>
        {[['Model',services?.tts.model],['Voice',services?.tts.voice],['Device',services?.tts.device?.toUpperCase()]].map(([label,value])=><div key={label} style={{flex:'1 1 110px',minWidth:0}}>
          <dt style={{fontSize:12,color:'var(--t3)'}}>{label}</dt><dd style={{margin:'4px 0 0',overflowWrap:'anywhere'}}>{value||'Unavailable'}</dd>
        </div>)}
      </dl>
      {services&&!services.voice_pipeline_configured&&<p role="status" style={{margin:0,fontSize:12,color:'var(--t3)'}}>The voice pipeline is disabled in deployment settings.</p>}
      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        <button type="button" style={button} disabled={loading||busy} onClick={check}>Refresh status</button>
        <button type="button" style={button} disabled={loading||previewBusy||!services?.tts.ready} onClick={preview}>{previewBusy?'Preparing preview…':'Preview voice'}</button>
      </div>
      <span style={{fontSize:12,color:'var(--t3)'}}>Preview plays in your browser only. Voice is set by the server.</span>
      {audioUrl&&<audio ref={audio} controls src={audioUrl} aria-label="TINA voice preview" style={{width:'100%'}}/>}
    </section>
    {error&&<p role="alert" style={{margin:0,color:'var(--warn)'}}>{error}</p>}
    {notice&&<p role="status" style={{margin:0,color:'var(--t2)'}}>{notice}</p>}
  </div>;
}

interface RoomPolicy {enabled:boolean;include_transcript:boolean;documents:string[];revision:number;wake_variants:string[];
  noise_suppression:boolean;allow_general_knowledge?:boolean;allow_web_search?:boolean;engine?:'tina'|'livekit'}
function RoomVoiceSettings({sessions}:{sessions:Array<{meeting_id:number;status:string}>}){
  const [meeting,setMeeting]=useState(''),[policy,setPolicy]=useState<RoomPolicy|null>(null);
  const [documents,setDocuments]=useState<Array<{path:string;title:string}>>([]),[reason,setReason]=useState('');
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [livekit,setLivekit]=useState(false);
  const identity=useRef(meeting);identity.current=meeting;
  useEffect(()=>{
    if(!meeting)return;const abort=new AbortController();setPolicy(null);setMessage('');setDocuments([]);setReason('');
    void Promise.all([fetch(`/api/meetings/${meeting}/voice-assistant`,{cache:'no-store',signal:abort.signal}),
      fetch(`/api/workspace/meeting-knowledge/${meeting}`,{cache:'no-store',signal:abort.signal})]).then(async([room,docs])=>{
      if(!room.ok)throw Error();const r=await room.json(),d=docs.ok?await docs.json():{documents:[]};
      if(abort.signal.aborted)return;setPolicy(r.policy);setDocuments(d.documents||[]);setLivekit(r.livekit_available===true);
      setReason(r.replies?.at(-1)?.reason||'');
    }).catch(()=>{if(!abort.signal.aborted)setMessage('Could not load room settings.');});
    return()=>abort.abort();
  },[meeting]);
  async function save(){
    if(!policy)return;const id=meeting;setBusy(true);setMessage('');
    try{const r=await fetch(`/api/meetings/${id}/voice-assistant`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(policy)});
      if(!r.ok)throw Error(r.status===409?'Room changed. Select the meeting again to reload.':'Could not save. Check shared sources and services.');
      const data=await r.json();if(identity.current===id){setPolicy(data.policy);setMessage('Saved. The current voice turn stops when settings change.');}
    }catch(e){if(identity.current===id)setMessage((e as Error).message);}
    finally{if(identity.current===id)setBusy(false);}
  }
  if(!sessions.length)return null;
  return <details style={{...card,display:'block'}} aria-label="Room answers">
    <summary style={{cursor:'pointer'}}>Meeting overrides (optional)</summary>
    <div style={{display:'grid',gap:10,paddingTop:12}}>
    <label htmlFor="voice-room">Active meeting</label>
    <select id="voice-room" value={meeting} disabled={busy} onChange={e=>setMeeting(e.target.value)} style={button}>
      <option value="">Choose a meeting</option>{sessions.map(s=><option key={s.meeting_id} value={s.meeting_id}>Meeting #{s.meeting_id}</option>)}
    </select>
    {meeting&&policy&&<>
      <label htmlFor="voice-runtime">Voice runtime</label>
      <select id="voice-runtime" value={policy.engine||'tina'} disabled={busy} style={button}
        onChange={e=>setPolicy({...policy,engine:e.target.value as 'tina'|'livekit'})}>
        <option value="tina">TINA</option><option value="livekit" disabled={!livekit}>LiveKit Agents{livekit?'':' · not configured'}</option>
      </select>
      {policy.engine==='livekit'&&<span style={{fontSize:12,color:'var(--t3)'}}>Up to 3 concurrent meetings. Uses your selected ASR, approved sources and local voice.</span>}
      {([['enabled','Enable voice'],['include_transcript','Use this meeting’s transcript'],
        ['allow_general_knowledge','Allow general knowledge'],['allow_web_search','Allow public web search']] as const).map(([key,label])=>
        <label key={key}><input type="checkbox" checked={!!policy[key]} disabled={busy} onChange={e=>setPolicy({...policy,[key]:e.target.checked})}/> {label}</label>)}
      {!!documents.length&&<details><summary>Shared documents ({policy.documents.length})</summary>
        {documents.map(doc=><label key={doc.path} style={{display:'block',marginTop:8}}><input type="checkbox" disabled={busy} checked={policy.documents.includes(doc.path)}
          onChange={e=>setPolicy({...policy,documents:e.target.checked?[...policy.documents,doc.path]:policy.documents.filter(p=>p!==doc.path)})}/> {doc.title}</label>)}
      </details>}
      <span style={{fontSize:12,color:'var(--t3)',lineHeight:1.5}}>General: “ASR là gì?” or “Kiến thức chung: …”. Web: “Tìm trên web về …”. Only the spoken search query goes to web search. Requires a compatible OpenAI Responses model; provider charges may apply.</span>
      {reason&&<span role="status" style={{fontSize:12,color:'var(--t3)'}}>Last answer: {reason.replaceAll('_',' ')}</span>}
      <button type="button" disabled={busy} style={{...button,justifySelf:'start'}} onClick={save}>Save room settings</button>
    </>}
    {message&&<p role="status" style={{margin:0,fontSize:12}}>{message}</p>}
    </div>
  </details>;
}
