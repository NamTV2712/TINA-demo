/** Whitespace-token diff; bound memory for long legacy transcripts. */
export function transcriptDiff(before: string, after: string): Array<{ kind: 'keep' | 'add' | 'remove'; text: string }> {
  const a = before.normalize('NFC').trim().split(/\s+/u).filter(Boolean);
  const b = after.normalize('NFC').trim().split(/\s+/u).filter(Boolean);
  if (a.length * b.length > 250000) return [{ kind: 'remove', text: before }, { kind: 'add', text: after }];
  const rows = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  const result: Array<{ kind: 'keep' | 'add' | 'remove'; text: string }> = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { result.push({ kind: 'keep', text: a[i++] }); j++; }
    else if (j < b.length && (i === a.length || rows[i][j + 1] >= rows[i + 1][j])) result.push({ kind: 'add', text: b[j++] });
    else result.push({ kind: 'remove', text: a[i++] });
  }
  return result;
}

/** Same-origin local review; transcript strings enter textContent/value, never HTML. */
export function transcriptReviewPage(base: string): string {
  const encoded = JSON.stringify(base).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>TINA · Transcript review</title><style>
[hidden]{display:none!important}
body{font:16px system-ui;background:#0d2522;color:#deede7;max-width:860px;margin:40px auto;padding:0 20px}
button,select,textarea,input{font:inherit;color:inherit;background:#203e39;border:1px solid #668d81;border-radius:8px;padding:10px;box-sizing:border-box}
select,textarea{width:100%;margin:8px 0 18px}button{cursor:pointer;margin-right:12px}button:disabled{opacity:.5;cursor:default}audio{display:block;width:100%;margin:12px 0}ins{background:#245d4d;color:#c6ffe7;text-decoration:underline}del{background:#5c3030;color:#ffd2c8}#error{color:#f5b4a4}label{display:block}summary{cursor:pointer}
</style><h1>Transcript review</h1><p>The original transcript and audio stay intact. Edits create revisions.</p>
<p id="error" role="alert"></p><p id="status" role="status">Loading…</p><button id="reload">Reload</button>
<section aria-labelledby="speaker-title"><h2 id="speaker-title">Speaker identities</h2>
<p>Voice groups are anonymous until you confirm a name. Local mic and verified participant metadata stay separate from system audio.</p>
<div id="speakers"></div><p id="speaker-count"></p>
<label>Number of remote voices (-1 = automatic)<input id="speaker-number" type="number" min="-1" max="20" value="-1"></label>
<button id="analyze-speakers">Analyze system-audio speakers</button><button id="cancel-speakers" hidden>Cancel analysis</button><button id="apply-speakers" hidden>Apply speaker groups</button>
<p id="speaker-analysis-status" role="status"></p></section>
<section aria-labelledby="language-review-title"><h2 id="language-review-title">Chờ kiểm tra ngôn ngữ</h2>
<p>Các đoạn này chưa vào transcript chính hay Meeting Memory. Nghe audio để đối chiếu; kết quả chạy lại chỉ là gợi ý.</p><div id="language-reviews"></div></section>
<section aria-labelledby="refine-title"><h2 id="refine-title">Second-pass ASR</h2>
<p>Re-decode saved utterances up to 30 seconds after capture stops. Review suggestions before applying.</p>
<details><summary>Vocabulary hints (optional)</summary><label>Vocabulary hints (comma separated)<textarea id="glossary" rows="2" maxlength="700" placeholder="TINA, Qwen, tên người, tên dự án"></textarea></label></details>
<button id="refine">Refine after meeting</button><button id="cancel-refine" hidden>Cancel</button>
<p id="refine-status" role="status"></p></section>
<section aria-labelledby="alignment-title"><h2 id="alignment-title">Word timing</h2>
<p>Align accepted text with saved audio. Words without reliable timing stay plain text. Alignment does not correct recognition errors.</p>
<button id="align-words">Align words</button><button id="cancel-alignment" hidden>Cancel alignment</button>
<p id="alignment-status" role="status"></p><div id="aligned-words"></div><audio id="word-audio" controls preload="none" hidden></audio></section>
<label><input id="changed-only" type="checkbox"> Only changed segments</label><p id="filter-status" role="status"></p>
<label>Segment<select id="segments"></select></label><section><h2>Compare with audio</h2><audio id="audio" controls preload="none"></audio><p id="audio-note"></p></section>
<label>Speaker for this segment<select id="assigned-speaker"></select></label><button id="assign-speaker">Assign speaker</button>
<section id="suggestion" hidden><p id="diff" aria-label="Suggested changes"></p><label>Refinement suggestion<textarea id="refined" readonly rows="4"></textarea></label>
<p id="refine-note"></p><button id="apply-refine">Apply refinement</button></section>
<label>Original transcript<textarea id="raw" readonly rows="3"></textarea></label>
<label>Corrected transcript<textarea id="text" rows="5" maxlength="10000"></textarea></label>

<button id="save">Save revision</button><button id="restore">Restore original</button>

<details><summary>Revision history</summary><div id="history"></div></details>
<section aria-labelledby="memory-title"><h2 id="memory-title">Meeting memory candidates</h2><p>Suggestions retain exact transcript evidence. A named speaker is not an inferred assignee.</p><div id="memory"></div></section>
<script>
const transcriptDiff=${transcriptDiff.toString()};
const base=${encoded}, byId=id=>document.getElementById(id);let doc,selected,job,registry,analysis,memory,canonical,alignment,busy=false,timer,speakerTimer,alignmentTimer,wordUrl,wordSourceKey,dirtySpeaker=false;
function render(reset=true){selected=doc?.segments.find(s=>s.segment_id===byId('segments').value);byId('raw').value=selected?.raw_text||'';if(reset)byId('text').value=selected?.text||'';
byId('segments').disabled=busy;byId('text').disabled=busy;byId('reload').disabled=busy;
byId('status').textContent=doc?doc.status+' · revision '+(selected?.revision||0):'Loading';byId('history').textContent='';
for(const h of selected?.history||[]){const p=document.createElement('p');p.textContent='Revision '+h.revision+' · '+h.at+' — '+h.text;byId('history').append(p)}
const editable=selected&&!busy&&['completed','failed','interrupted'].includes(doc.status);byId('save').disabled=!editable;byId('restore').disabled=!editable||!selected.revision;
byId('audio').hidden=selected?.audio.length!==1;if(selected?.audio.length===1){const src=base+'/segments/'+encodeURIComponent(selected.segment_id)+'/audio';if(byId('audio').getAttribute('src')!==src)byId('audio').src=src;}else byId('audio').removeAttribute('src');
byId('audio-note').textContent=doc?.archive_error||(!selected?.audio.length?'Source audio is unavailable for this segment.':selected.audio.length!==1?'Multiple capture sessions overlap this segment; automatic audio playback is unavailable.':'Audio uses capture timestamps; gaps stay silent.');renderRefinement();renderSpeakerAssignment();renderAnalysis();renderAlignment();}
function renderSpeakerAssignment(){const select=byId('assigned-speaker');select.textContent='';const unknown=document.createElement('option');unknown.value='';unknown.textContent='Unknown speaker';select.append(unknown);
for(const entry of registry?.speakers||[]){const option=document.createElement('option');option.value=entry.speaker_id;option.textContent=(entry.name||'Unknown voice')+' · '+entry.speaker_id.slice(0,8);select.append(option)}
select.value=registry?.segments[selected?.segment_id]?.speaker_id||'';select.disabled=busy||!selected;byId('assign-speaker').disabled=busy||!selected;}
function renderSpeakers(){const root=byId('speakers');root.textContent='';for(const entry of (registry?.speakers||[]).slice(0,100)){const card=document.createElement('section'),label=document.createElement('label'),input=document.createElement('input'),save=document.createElement('button'),unknown=document.createElement('button');
label.textContent=(entry.name||'Unknown voice')+' · '+entry.segment_count+' segments · '+entry.source+' · '+entry.speaker_id.slice(0,8);input.value=entry.name||'';input.maxLength=120;input.placeholder=entry.candidate_name?'Unconfirmed hint: '+entry.candidate_name:'Enter a confirmed name';input.oninput=()=>{dirtySpeaker=true};label.append(input);
save.textContent='Confirm name';save.onclick=()=>speakerRequest('/speakers/'+entry.speaker_id,'PATCH',{expected_revision:entry.revision,name:input.value});unknown.textContent='Set unknown';unknown.onclick=()=>speakerRequest('/speakers/'+entry.speaker_id,'PATCH',{expected_revision:entry.revision,name:null});card.append(label,save,unknown);root.append(card)}
byId('speaker-count').textContent=(registry?.speakers.length||0)+' speaker identities'+((registry?.speakers.length||0)>100?' · showing first 100':'');}
function renderAnalysis(){const job=analysis?.job,running=job?.status==='running';byId('analyze-speakers').disabled=busy||running||['running','paused'].includes(alignment?.job?.status)||!analysis?.configured||doc?.status==='active';byId('cancel-speakers').hidden=!running;byId('cancel-speakers').disabled=busy;byId('apply-speakers').hidden=job?.status!=='completed'||!!job.applied_at;byId('apply-speakers').disabled=busy||doc?.status==='active';
byId('speaker-analysis-status').textContent=!analysis?.configured?'Configure the local diarization worker to analyze system audio.':job?job.status+' · '+job.items.filter(s=>s.cluster!==null).length+'/'+job.items.length+' segments proposed for a single voice'+(job.applied_at?' · applied':'')+(job.error?' · '+job.error:''):'Ready after capture stops. Analysis supports up to 30 minutes; overlaps and uncertain spans stay unknown.';
clearTimeout(speakerTimer);if(running)speakerTimer=setTimeout(async()=>{try{analysis=await request('/diarization');renderAnalysis()}catch(e){byId('error').textContent=e.message}},1000);}
function refinementActive(){return job&&['running','paused','cancelling'].includes(job.status)}
function renderAlignment(){const job=alignment?.job,active=job&&['running','paused'].includes(job.status);byId('align-words').disabled=busy||active||analysis?.job?.status==='running'||refinementActive()||!alignment?.available||!['completed','failed','interrupted'].includes(doc?.status);byId('cancel-alignment').hidden=!active;byId('cancel-alignment').disabled=busy;
byId('alignment-status').textContent=!alignment?.available?'Configure the local alignment worker first.':job?job.status+' · '+job.items.filter(i=>i.state==='aligned').length+'/'+job.items.length+' aligned segments'+(job.error?' · '+job.error:''):'Ready after capture stops. Each segment needs continuous verified audio up to 30 seconds.';
const selectedItem=job?.items.find(i=>i.segment_id===selected?.segment_id);if(selectedItem?.reason)byId('alignment-status').textContent+=' · '+selectedItem.reason;
const root=byId('aligned-words');root.textContent='';const segment=canonical?.segments.find(s=>s.segment_id===selected?.segment_id),current=segment?.revision===selected?.revision&&segment?.text===selected?.text&&segment?.alignment.status==='aligned';const sourceKey=current?segment.segment_id+':'+segment.revision+':'+segment.alignment.job_id:'';if(wordSourceKey&&sourceKey!==wordSourceKey){byId('word-audio').pause();byId('word-audio').removeAttribute('src');byId('word-audio').hidden=true;if(wordUrl)URL.revokeObjectURL(wordUrl);wordUrl=null;wordSourceKey=null}if(current){for(const word of segment.words){const el=document.createElement(word.aligned?'button':'span');el.textContent=word.text+' ';if(word.aligned){el.title=word.speaker_name+' · '+((word.start_ms-segment.start_ms)/1000).toFixed(2)+'s';el.onclick=()=>playAlignedWord(segment,word)}else el.title='No reliable word timing';root.append(el)}}else root.textContent='No current word timing for this segment.';
clearTimeout(alignmentTimer);if(active)alignmentTimer=setTimeout(async()=>{try{[alignment,canonical]=await Promise.all([request('/alignment'),request('/canonical')]);renderAlignment();if(!['running','paused'].includes(alignment.job?.status))refreshCurrent()}catch(e){byId('error').textContent=e.message}},1000);}
async function playAlignedWord(segment,word){if(busy||selected?.segment_id!==segment.segment_id||byId('text').value!==selected.text){byId('error').textContent='Save or reload your text edit before word playback.';return}try{const query=new URLSearchParams({word_index:String(word.index),job_id:segment.alignment.job_id,expected_revision:String(segment.revision)});const response=await fetch(base+'/segments/'+encodeURIComponent(segment.segment_id)+'/aligned-audio?'+query,{cache:'no-store'});if(!response.ok){const error=await response.json();throw Error(error.error||'Word audio unavailable')}const blob=await response.blob();if(selected?.segment_id!==segment.segment_id||selected?.revision!==segment.revision||byId('text').value!==selected.text)return;wordSourceKey=segment.segment_id+':'+segment.revision+':'+segment.alignment.job_id;if(wordUrl)URL.revokeObjectURL(wordUrl);wordUrl=URL.createObjectURL(blob);byId('word-audio').src=wordUrl;byId('word-audio').hidden=false;await byId('word-audio').play()}catch(e){byId('error').textContent=e.message}}
async function alignWords(action){if(dirtySpeaker||selected&&byId('text').value!==selected.text){byId('error').textContent='Save or reload your edits before alignment.';return}busy=true;render(false);try{await request('/alignment/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});await load()}catch(e){byId('error').textContent=e.message}finally{busy=false;render(false)}}
function renderMemory(){const root=byId('memory');root.textContent='';for(const fact of memory?.facts||[]){const card=document.createElement('article'),title=document.createElement('p');title.textContent=fact.type+' · candidate: '+fact.text;card.append(title);for(const evidence of fact.evidence){const line=document.createElement('p');line.textContent=evidence.speaker_name+' · '+new Date(evidence.start_ms).toLocaleTimeString()+' · text revision '+evidence.revision+' · '+evidence.quote;card.append(line)}root.append(card)}if(!memory?.facts.length)root.textContent='No explicit action, decision or fact candidates in the accepted transcript.';}
async function speakerRequest(path,method,body){if(selected&&byId('text').value!==selected.text){byId('error').textContent='Save or reload your text edit before changing speakers.';return}busy=true;render(false);try{await request(path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});dirtySpeaker=false;await load()}catch(e){byId('error').textContent=e.message}finally{busy=false;render(false)}}
function renderRefinement(){const active=job&&['running','paused','cancelling'].includes(job.status),item=job?.items.find(s=>s.segment_id===selected?.segment_id),done=job?.items.filter(s=>s.state!=='pending').length||0;
byId('refine').disabled=busy||active||['running','paused'].includes(alignment?.job?.status)||analysis?.job?.status==='running'||!doc||!['completed','failed','interrupted'].includes(doc.status)||!doc.segments.some(s=>s.audio.length===1&&s.end_ms-s.start_ms<=30000);
byId('cancel-refine').hidden=!active;byId('cancel-refine').disabled=busy||job?.status==='cancelling';
byId('refine-status').textContent=job?job.status+' · '+done+'/'+job.items.length+' segments · '+job.backend+' / '+job.model+(job.error?' · '+job.error:''):doc&&!doc.segments.some(s=>s.audio.length)?'Saved source audio is required. Older sessions cannot be refined.':'Ready after capture stops.';
byId('diff').textContent='';if(item?.text&&selected){for(const part of transcriptDiff(item.state==='applied'?selected.history.find(h=>h.revision===item.expected_revision)?.text||selected.raw_text:selected.text,item.text)){const span=document.createElement(part.kind==='add'?'ins':part.kind==='remove'?'del':'span');span.textContent=part.text+' ';byId('diff').append(span)}}
byId('suggestion').hidden=!item;byId('refined').value=item?.text||'';
const stale=item&&selected&&item.state!=='applied'&&item.expected_revision!==selected.revision,dirty=selected&&byId('text').value!==selected.text;
byId('refine-note').textContent=stale?'Transcript changed since this suggestion. Run refinement again.':dirty?'Save or reload your edit before applying a suggestion.':item?.reason|| (item?.state==='applied'?'Applied as a revision.':item?.state==='ready'?'A second pass is not guaranteed to be more accurate. Compare with the original audio.':item?.state||'');
byId('apply-refine').disabled=busy||active||doc?.status==='active'||item?.state!=='ready'||stale||dirty;}
async function request(path,options){const r=await fetch(base+path,{cache:"no-store",...options});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d}
function options(){const previous=byId('segments').value;byId('segments').textContent='';const visible=(doc?.segments||[]).filter(s=>!byId('changed-only').checked||changed(s));for(const s of visible){const o=document.createElement('option');o.value=s.segment_id;o.textContent=(s.speaker||'Speaker')+' · '+s.text.slice(0,90);byId('segments').append(o)}if(visible.some(s=>s.segment_id===previous))byId('segments').value=previous;byId('filter-status').textContent=visible.length+' / '+(doc?.segments.length||0)+' segments';}
function changed(s){const item=job?.items.find(i=>i.segment_id===s.segment_id);return s.text!==s.raw_text||!!(item?.text&&item.text!==s.text&&item.state==='ready');}
async function load(preserve=false){try{const nextDoc=await request('/document'),snapshots=await Promise.all([request('/speakers'),request('/diarization'),request('/memory'),request('/canonical'),request('/alignment')]);if(preserve&&(dirtySpeaker||selected&&byId('text').value!==selected.text)){byId('error').textContent='Transcript or speaker changed elsewhere. Save or reload your edit before continuing.';return false}doc=nextDoc;[registry,analysis,memory,canonical,alignment]=snapshots;dirtySpeaker=false;options();byId('error').textContent='';renderSpeakers();render();renderMemory();await loadLanguageReviews();return true}catch(e){byId('error').textContent=e.message;return false}}
async function loadLanguageReviews(){const data=await request('/asr-reviews');const root=byId('language-reviews');root.textContent='';if(!data.items.length){root.textContent='Không có đoạn chờ kiểm tra.';return}for(const item of data.items){const card=document.createElement('details'),title=document.createElement('summary'),raw=document.createElement('p'),retry=document.createElement('p'),audio=document.createElement('audio');title.textContent=new Date(item.at).toLocaleTimeString()+' · '+item.original.language;raw.textContent='ASR gốc: '+item.original.text;retry.textContent=item.retry?'Gợi ý chạy lại: '+item.retry.text:'Chạy lại chưa thành công: '+item.retry_error;audio.controls=true;audio.preload='none';audio.src=base+'/asr-reviews/'+encodeURIComponent(item.id)+'/audio';card.append(title,raw,retry,audio);root.append(card)}}
async function save(text){if(!selected)return;busy=true;render(false);let saved=false;try{doc=await request('/segments/'+encodeURIComponent(selected.segment_id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_revision:selected.revision,text})});byId('error').textContent='';options();saved=true}catch(e){byId('error').textContent=e.message}finally{busy=false;render(saved)}}
async function poll(){clearTimeout(timer);try{job=await request('/refinement');options();render(false);if(job&&['running','paused','cancelling'].includes(job.status))timer=setTimeout(poll,1000)}catch(e){byId('error').textContent=e.message}}
async function refine(action){busy=true;render(false);try{const body=action==='apply'?{job_id:job.id,segment_id:selected.segment_id,expected_revision:selected.revision}:action==='start'?{glossary:byId('glossary').value.split(',').map(s=>s.trim()).filter(Boolean)}:undefined;
const data=await request('/refinement/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});byId('error').textContent='';if(action==='apply'){doc=data;options();render()}else job=data;await poll()}catch(e){byId('error').textContent=e.message}finally{busy=false;render(false)}}
byId('changed-only').onchange=()=>{options();render()};let revisionSocket,reconnect,refreshRetry,closed=false;const seenRevisions=new Map();
function refreshCurrent(){if(!doc)return;if(dirtySpeaker||selected&&byId('text').value!==selected.text){byId('error').textContent='Transcript or speaker changed elsewhere. Save or reload your edit before continuing.';return}load(true).then(ok=>{if(ok)poll();else if(!closed)refreshRetry=setTimeout(refreshCurrent,1000)})}
function connectRevisions(){revisionSocket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
revisionSocket.onopen=()=>{const parts=base.split('/');revisionSocket.send(JSON.stringify({action:'subscribe',meetings:[{platform:decodeURIComponent(parts[2]),native_id:decodeURIComponent(parts[3])}]}));refreshCurrent()};
revisionSocket.onmessage=e=>{let event;try{event=JSON.parse(e.data)}catch{return}const speaker=event.type==='speaker.revised'&&event.version==='speaker-revision.v1',text=event.type==='transcript.revised'&&event.version==='transcript-revision.v1',key=speaker?'speaker:'+event.speaker_id:event.segment_id;if((!speaker&&!text)||event.meeting_id!==doc?.meeting_id||!Number.isSafeInteger(event.revision)||event.revision<1||event.revision<=(seenRevisions.get(key)||0))return;seenRevisions.set(key,event.revision);refreshCurrent()};
revisionSocket.onclose=()=>{if(!closed)reconnect=setTimeout(connectRevisions,1000)};revisionSocket.onerror=()=>revisionSocket.close();}
window.addEventListener('beforeunload',()=>{closed=true;clearTimeout(reconnect);clearTimeout(refreshRetry);clearTimeout(timer);clearTimeout(speakerTimer);clearTimeout(alignmentTimer);if(wordUrl)URL.revokeObjectURL(wordUrl);revisionSocket?.close()});connectRevisions();
byId('align-words').onclick=()=>alignWords('start');byId('cancel-alignment').onclick=()=>alignWords('cancel');
byId('analyze-speakers').onclick=()=>speakerRequest('/diarization/start','POST',{num_speakers:Number(byId('speaker-number').value)});byId('cancel-speakers').onclick=()=>speakerRequest('/diarization/cancel','POST',{});byId('apply-speakers').onclick=()=>speakerRequest('/diarization/apply','POST',{job_id:analysis.job.id});byId('assign-speaker').onclick=()=>speakerRequest('/speakers/assign','POST',{segment_id:selected.segment_id,expected_revision:registry.revision,speaker_id:byId('assigned-speaker').value||null});
byId('segments').onchange=()=>render();byId('reload').onclick=async()=>{await load();await poll()};byId('save').onclick=()=>save(byId('text').value);byId('restore').onclick=()=>save(null);
byId('text').oninput=renderRefinement;byId('refine').onclick=()=>refine('start');byId('cancel-refine').onclick=()=>refine('cancel');byId('apply-refine').onclick=()=>refine('apply');load().then(poll);
</script></html>`;
}
