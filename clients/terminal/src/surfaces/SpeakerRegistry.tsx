"use client";
import styles from "./meetingDialogs.module.css";
import { useMeetingDialogEscape } from "./useMeetingDialogEscape";
import {useEffect,useRef,useState,useId} from "react";
interface Speaker {
  speaker_id: string; segment_count?:number; name: string | null; candidate_name: string | null;
  status: "unknown" | "observed" | "confirmed"; source: string; participant_id: string | null; revision: number;
  history: Array<{revision:number;name:string|null;status:string;source:string;at:string}>;
}
interface Registry { meeting_id:number; speakers:Speaker[] }
interface Analysis { id:string; status:string; error?:string; applied_at?:string; applied_segments?:number; items:Array<{cluster:number|null;recording_key:string}> }

export function SpeakerRegistry({meetingId,openRef,hideTrigger=false}:{meetingId:string;openRef?:{current:(()=>void)|null};hideTrigger?:boolean}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [opened,setOpened]=useState(false);
  useMeetingDialogEscape(dialog, opened);
  const titleId=useId();
  const open=()=>{dialog.current?.showModal();setOpened(true);void load();};
  useEffect(()=>{if(openRef)openRef.current=open;});
  const base=`/api/transcripts/by-id/${encodeURIComponent(meetingId)}/speakers`;
  function saved() { window.dispatchEvent(new CustomEvent("tina:transcript-corrected",{detail:{meetingId}})); }
  const [doc, setDoc] = useState<Registry | null>(null);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const speaker = doc?.speakers.find(s => s.speaker_id === selected);
  const identity = useRef(meetingId); identity.current = meetingId;
  useEffect(() => { setName(speaker?.name ?? speaker?.candidate_name ?? ""); }, [speaker?.speaker_id, speaker?.revision]);
  async function request(path = "", options?: RequestInit): Promise<Registry> {
    const response = await fetch(base + path, {...options, cache:"no-store"});
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Speaker identities unavailable");
    if (identity.current !== meetingId) throw new Error("Meeting changed; reopen speakers");
    return data;
  }
  function accept(data: Registry) {
    setDoc(data);
    setSelected(previous => data.speakers.some(s => s.speaker_id === previous) ? previous : data.speakers[0]?.speaker_id ?? "");
  }
  async function load() {
    setBusy(true); setError("");
    try { accept(await request()); }
    catch(e) { setError(e instanceof Error ? e.message : "Could not load speakers"); }
    finally { setBusy(false); }
  }
  async function save(value: string | null) {
    if (!speaker) return;
    setBusy(true); setError("");
    try {
      accept(await request("/" + encodeURIComponent(speaker.speaker_id), {method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:value,expected_revision:speaker.revision})}));
      saved();
    } catch(e) { setError(e instanceof Error ? e.message : "Could not save speaker"); }
    finally { setBusy(false); }
  }
  const [analysis,setAnalysis]=useState<Analysis|null>(null);
  const [count,setCount]=useState(-1);
  const analyzing=!!analysis && ["running","paused","cancelling"].includes(analysis.status);
  async function analyze(action?:"start"|"cancel"|"apply") {
    const response=await fetch(base.replace(/\/speakers$/, "/diarization")+(action ? "/"+action : ""), {
      method:action ? "POST" : "GET", cache:"no-store", headers:{"Content-Type":"application/json"},
      ...(action ? {body:JSON.stringify(action === "start" ? {num_speakers:count} : action === "apply" ? {job_id:analysis?.id} : {})} : {}),
    });
    const data=await response.json();
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Speaker analysis unavailable");
    if (identity.current !== meetingId) return;
    if (action === "apply") { accept(data);saved();await analyze(); }
    else setAnalysis(data);
  }
  async function runAnalysis(action:"start"|"cancel"|"apply") {
    setBusy(true);setError("");
    try { await analyze(action); }
    catch(e) { setError(e instanceof Error ? e.message : "Speaker analysis unavailable"); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    setAnalysis(null);
    if (!opened) return;
    let alive=true;
    const refresh=() => void analyze().catch(e => {if(alive)setError(e instanceof Error ? e.message : "Speaker analysis unavailable");});
    refresh();
    const timer=setInterval(refresh,3000);
    return () => {alive=false;clearInterval(timer);};
  },[opened,meetingId]);
  const content = <div className={styles.content}>
    {error && <p role="alert">{error} <button disabled={busy} onClick={() => void load()}>Reload</button></p>}
    {busy && <p role="status">Working…</p>}
    {doc?.speakers.length === 0 && <p className={styles.empty}>No speakers recorded yet. <button disabled={busy} onClick={() => void load()}>Reload</button></p>}
    {!!doc?.speakers.length && <label>Speaker<select aria-label="Speaker identity" value={selected} disabled={busy} onChange={e => setSelected(e.target.value)}>
      {doc.speakers.map(s => <option key={s.speaker_id} value={s.speaker_id}>{s.name || "Unknown speaker"}{!s.name && s.candidate_name ? ` · heard as ${s.candidate_name}` : ""} · {s.speaker_id.slice(0,8)}{s.segment_count ? ` · ${s.segment_count} segments` : ""}</option>)}
    </select></label>}
    {speaker && <>
      <h3>Speaker name</h3>
      <p role="status">{speaker.status === "confirmed" ? "Confirmed by you" : speaker.status === "observed" ? "Observed in Google Meet" : "Identity unknown"} · revision {speaker.revision}</p>
      {speaker.candidate_name && <p>Observed label: {speaker.candidate_name}</p>}
      <label>Name<input aria-label="Speaker name" value={name} maxLength={120} disabled={busy} onChange={e => setName(e.target.value)} /></label>
      <div className={styles.actions}>
        <button className={styles.primary} disabled={busy || !name.trim()} onClick={() => void save(name.trim())}>Confirm / save name</button>
        <button disabled={busy || (speaker.status === "unknown" && speaker.source === "manual")} onClick={() => void save(null)}>Use unknown</button>
      </div>
      <details><summary>Assignment history ({speaker.history.length})</summary>{speaker.history.map(h => <p key={h.revision}>{h.revision} · {h.name || "Unknown speaker"} · {h.source === "manual" ? "User assignment" : h.source === "meet_dom" ? "Google Meet metadata" : h.source === "diarization" ? "Recording voice grouping" : "Unattributed audio"}<br /><time dateTime={h.at}>{new Date(h.at).toLocaleString()}</time></p>)}</details>
    </>}
    <section aria-label="Recording speaker analysis" className={styles.card}>
      <h3>Recording analysis</h3>
      <label>Voices in recording<select aria-label="Number of voices" value={count} disabled={busy||analyzing} onChange={e=>setCount(Number(e.target.value))}>
        <option value={-1}>Detect automatically</option>{Array.from({length:10},(_,i)=><option key={i+1} value={i+1}>{i+1}</option>)}
      </select></label>
      <div className={styles.actions}>
        <button className={styles.primary} disabled={busy||analyzing} onClick={()=>void runAnalysis("start")}>Analyze recording speakers</button>
        {analyzing && <button disabled={busy||analysis?.status==="cancelling"} onClick={()=>void runAnalysis("cancel")}>Cancel analysis</button>}
        {analysis?.status==="completed" && !analysis.applied_at && <button disabled={busy} onClick={()=>void runAnalysis("apply")}>Apply speaker groups</button>}
      </div>
      {analysis && <p role="status">{analysis.status}{analysis.applied_at ? ` · ${analysis.applied_segments ?? 0} segments updated · ${analysis.items.filter(i=>i.cluster===null).length} uncertain` : analysis.status==="completed" ? ` · ${new Set(analysis.items.filter(i=>i.cluster!==null).map(i=>i.recording_key+":"+i.cluster)).size} voice groups · ${analysis.items.filter(i=>i.cluster===null).length} uncertain segments` : ""}</p>}
      {analysis?.error && <p role="alert">{analysis.error}</p>}
      <small>Existing Meet identities and names you confirmed stay unchanged. Uncertain audio stays unknown.</small>
    </section>
  </div>;
  return <>
    {!openRef && <button id={hideTrigger ? "tina-sr-open" : undefined} onClick={open} style={{background:"transparent",color:"var(--t2)",border:"1px solid var(--line2)",borderRadius:6,padding:"3px 8px",fontSize:12,cursor:"pointer",whiteSpace:"nowrap"}}>Speaker identities</button>}
    <dialog className={styles.dialog} onClose={()=>setOpened(false)} ref={dialog} aria-labelledby={titleId}>
      <header className={styles.header}>
        <div><h2 id={titleId}>Speaker identities</h2><p className={styles.description}>Confirm who is speaking, or analyze the recording after the meeting.</p></div>
        <button type="button" className={styles.close} onClick={() => dialog.current?.close()}>Close</button>
      </header>
      <div className={styles.body}>{content}</div>
    </dialog>
  </>;
}
