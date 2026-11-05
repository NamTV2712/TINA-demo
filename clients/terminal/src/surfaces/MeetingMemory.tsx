"use client";
import styles from "./meetingDialogs.module.css";
import { useMeetingDialogEscape } from "./useMeetingDialogEscape";
import {useEffect,useId,useRef,useState} from "react";
interface Evidence {
  segment_id:string; revision:number; start_ms:number; end_ms:number; speaker_name:string; quote:string;
}
interface Fact { id:string; type:"action_item"|"decision"|"fact"; text:string; evidence:Evidence[] }
interface Memory {
  meeting_id:number; canonical_revision:number;
  windows:Array<{id:string; evidence:Evidence[]; facts:Fact[]}>; facts:Fact[];
}
const labels = {action_item:"Action", decision:"Decision", fact:"Fact"};
const time = (ms:number) => new Date(ms).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"});
export function MeetingMemory({meetingId,openRef,hideTrigger=false}:{meetingId:string;openRef?:{current:(()=>void)|null};hideTrigger?:boolean}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const titleId=useId();
  const [opened,setOpened]=useState(false);
  useMeetingDialogEscape(dialog, opened);
  const [suggestionsOnly,setSuggestionsOnly]=useState(false);
  const open=()=>{setOpened(true);dialog.current?.showModal();};
  useEffect(()=>{if(openRef)openRef.current=open;});
  const base=`/api/transcripts/by-id/${encodeURIComponent(meetingId)}/memory`;
  const [doc,setDoc]=useState<Memory|null>(null);
  const [error,setError]=useState("");
  useEffect(() => {
    setDoc(null); setError("");
    if (!opened) return;
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const response=await fetch(base, {cache:"no-store",signal:controller.signal});
        const data=await response.json();
        if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Meeting memory unavailable");
        if (data.meeting_id !== Number(meetingId)) throw new Error("Meeting changed; reopen memory");
        if (!controller.signal.aborted) {setDoc(data);setError("");}
      } catch(e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not load memory");
      } finally {
        if (!controller.signal.aborted) timer=setTimeout(refresh,5000);
      }
    }
    void refresh();
    return () => {controller.abort();clearTimeout(timer);};
  }, [opened,meetingId,base]);
  const content=<div className={styles.content}>
    {error && <p role="alert">{error}</p>}
    {!doc && !error && <p role="status">Loading memory…</p>}
    {doc && <>
      <div className={styles.stats} role="status"><span className={styles.stat}>{doc.windows.length} conversation windows</span><span className={styles.stat}>{doc.facts.length} {doc.facts.length === 1 ? "suggestion" : "suggestions"}</span><span className={styles.stat}>Revision {doc.canonical_revision}</span></div>
      {!doc.windows.length && <p className={styles.empty}>No finalized speech yet.</p>}
      {!!doc.windows.length && <label><input type="checkbox" checked={suggestionsOnly} onChange={e=>setSuggestionsOnly(e.target.checked)} />Only windows with suggestions</label>}
      {suggestionsOnly && !!doc.windows.length && !doc.windows.some(window=>window.facts.length) && <p className={styles.empty}>No suggestions yet. Turn off the filter to review conversation evidence.</p>}
      {doc.windows.map((window,index)=>suggestionsOnly && !window.facts.length ? null : <details key={window.id} open={window.facts.length > 0}>
        <summary>Window {index+1} · {window.evidence[0] ? time(window.evidence[0].start_ms) : "No timestamp"} · {window.facts.length} {window.facts.length === 1 ? "suggestion" : "suggestions"}</summary>
        {window.facts.map(fact=><section key={fact.id} style={{marginBlock:12}}>
          <strong>{labels[fact.type]} · candidate</strong>
          <p>{fact.text}</p>
          {fact.evidence.map(e=><blockquote key={e.segment_id} style={{borderLeft:"2px solid currentColor",paddingLeft:12,marginBlock:8}}>
            <q>{e.quote}</q><br/><small>{e.speaker_name} · {time(e.start_ms)}–{time(e.end_ms)} · text revision {e.revision} · {e.segment_id}</small>
          </blockquote>)}
        </section>)}
        <details><summary>Conversation evidence ({window.evidence.length})</summary>
          {window.evidence.map(e=><p key={e.segment_id}><small>{e.speaker_name} · {time(e.start_ms)} · revision {e.revision}</small><br/>{e.quote}</p>)}
        </details>
      </details>)}
    </>}
  </div>;
  return <>
    {!openRef && <button id={hideTrigger ? "tina-mm-open" : undefined} onClick={open} style={{background:"transparent",color:"var(--t2)",border:"1px solid var(--line2)",borderRadius:6,padding:"3px 8px",fontSize:12,cursor:"pointer",whiteSpace:"nowrap"}}>Meeting memory</button>}
    <dialog className={styles.dialog} ref={dialog} aria-labelledby={titleId} onClose={()=>setOpened(false)}>
      <header className={styles.header}>
        <div><h2 id={titleId}>Meeting memory</h2><p className={styles.description}>Suggested actions, decisions and facts from explicit phrases. Review the evidence before relying on them.</p></div>
        <button type="button" className={styles.close} onClick={()=>dialog.current?.close()}>Close</button>
      </header>
      <div className={styles.body}>{content}</div>
    </dialog>
  </>;
}
