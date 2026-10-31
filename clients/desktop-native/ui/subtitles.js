const {invoke}=window.__TAURI__.core;
const $=(id)=>document.getElementById(id);

const POLL_MS=600;
const MIN_SIZE=14;
const MAX_SIZE=38;
const STORAGE_KEY='tina.caption.size';

let fontSize=readSize();
let signature='';
let looping=false;
let timer=0;
let followTail=true;

function readSize(){
  const stored=Number(localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(stored)&&stored>=MIN_SIZE&&stored<=MAX_SIZE?Math.round(stored):22;
}

function applySize(){
  document.documentElement.style.setProperty('--caption-size',`${fontSize}px`);
  $('smaller').disabled=fontSize<=MIN_SIZE;
  $('larger').disabled=fontSize>=MAX_SIZE;
  try{localStorage.setItem(STORAGE_KEY,String(fontSize));}catch{}
}

function line(speaker,text,pending,translation){
  const row=document.createElement('div');
  row.className=pending?'line pending':'line translated-line';
  if(speaker){
    const who=document.createElement('span');
    who.className='speaker';
    who.textContent=speaker;
    row.append(who);
  }
  const body=document.createElement('span');
  body.className='caption-lines';
  const original=document.createElement('span');
  original.className='caption-original';
  original.textContent=text;
  body.append(original);
  if(translation){
    const translated=document.createElement('span');
    translated.className='caption-translation';
    translated.textContent=translation;
    body.append(translated);
  }
  row.append(body);
  return row;
}

function render(state){
  const segments=Array.isArray(state.segments)?state.segments:[];
  const pending=String(state.pending||'').trim();
  const error=typeof state.error==='string'?state.error:'';
  const key=JSON.stringify([
    Boolean(state.connected),
    error,
    state.target_language||'',
    segments.map(segment=>[
      segment.id,segment.speaker,segment.text,
      segment.translation?.target_language,segment.translation?.text
    ]),
    pending
  ]);
  if(key===signature)return;
  signature=key;

  const container=$('lines');
  const wasFollowing=followTail;
  const previousTop=container.scrollTop;
  const rows=segments.map(segment=>{
    const hasTranslation=segment.translation?.target_language===state.target_language;
    const translation=hasTranslation?String(segment.translation.text||''):'';
    return line(segment.speaker||'Audio',String(segment.text||''),false,translation);
  });
  if(pending)rows.push(line('',pending,true,''));
  if(!rows.length)rows.push(line('',state.connected?'Listening…':'Connecting to TINA Desktop…',false));
  container.replaceChildren(...rows);
  if(wasFollowing)container.scrollTop=container.scrollHeight;
  else container.scrollTop=previousTop;
  followTail=container.scrollHeight-container.scrollTop-container.clientHeight<32;

  const status=$('status');
  status.hidden=!error;
  status.textContent=error;
}

async function poll(){
  try{render(await invoke('captions_snapshot',{limit:50}));}catch{}
}

$('lines').addEventListener('scroll',()=>{
  const container=$('lines');
  followTail=container.scrollHeight-container.scrollTop-container.clientHeight<32;
});

async function loop(){
  if(looping)return;
  looping=true;
  await poll();
  looping=false;
  if(!document.hidden)timer=window.setTimeout(loop,POLL_MS);
}

$('smaller').addEventListener('click',()=>{
  fontSize=Math.max(MIN_SIZE,fontSize-2);
  applySize();
});
$('larger').addEventListener('click',()=>{
  fontSize=Math.min(MAX_SIZE,fontSize+2);
  applySize();
});
$('hide').addEventListener('click',async()=>{
  try{await invoke('toggle_subtitles');}catch{}
});

document.addEventListener('visibilitychange',()=>{
  window.clearTimeout(timer);
  if(!document.hidden)void loop();
});

const OPACITY_KEY='tina.caption.opacity';
let opacity=readOpacity();

function readOpacity(){
  const stored=Number(localStorage.getItem(OPACITY_KEY));
  return Number.isFinite(stored)&&stored>=30&&stored<=98?stored:90;
}

function applyOpacity(){
  document.documentElement.style.setProperty('--subtitle-tint-alpha',(opacity/100).toFixed(2));
  const slider=$('opacitySlider');
  if(slider)slider.value=String(opacity);
  try{localStorage.setItem(OPACITY_KEY,String(opacity));}catch{}
}

const opacityBtn=$('opacityBtn');
const opacityPop=$('opacityPop');
if(opacityBtn&&opacityPop){
  opacityBtn.addEventListener('click',e=>{
    e.stopPropagation();
    opacityPop.hidden=!opacityPop.hidden;
  });
  $('opacitySlider')?.addEventListener('input',e=>{
    opacity=Number(e.target.value)||90;
    applyOpacity();
  });
  document.addEventListener('click',e=>{
    if(!e.target.closest('#opacityPop')&&!e.target.closest('#opacityBtn')){
      opacityPop.hidden=true;
    }
  });
}

applySize();
applyOpacity();
void loop();
