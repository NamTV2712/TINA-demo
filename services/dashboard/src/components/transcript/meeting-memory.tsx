"use client";
import {useEffect,useState} from "react";
import {Button} from "@/components/ui/button";
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle,DialogTrigger} from "@/components/ui/dialog";
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
export function MeetingMemory({meetingId}:{meetingId:string}) {
  const [opened,setOpened]=useState(false);
  const base=`/api/tina/transcripts/by-id/${encodeURIComponent(meetingId)}/memory`;
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
  const content=<div style={{display:"grid",gap:16}}>
    <p>Suggested actions, decisions and facts from explicit phrases. Review the evidence before relying on them.</p>
    {error && <p role="alert">{error}</p>}
    {!doc && !error && <p role="status">Loading memory…</p>}
    {doc && <>
      <p role="status">{doc.windows.length} conversation windows · {doc.facts.length} suggestions · revision {doc.canonical_revision}</p>
      {!doc.windows.length && <p>No finalized speech yet.</p>}
      {doc.windows.map((window,index)=><details key={window.id} open={index === doc.windows.length-1}>
        <summary>Window {index+1} · {time(window.evidence[0].start_ms)} · {window.facts.length} suggestions</summary>
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
  return <Dialog open={opened} onOpenChange={setOpened}>
    <DialogTrigger asChild><Button variant="outline" size="sm">Meeting memory</Button></DialogTrigger>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>Meeting memory</DialogTitle><DialogDescription>Suggestions with quotes from the current transcript.</DialogDescription></DialogHeader>
      {content}
    </DialogContent>
  </Dialog>;
}
