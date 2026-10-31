/** Recover a source interval from the existing captured-signal + observation sidecars. */
import {createReadStream,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';

export async function readCaptureAudio(tape:string,observations:string,source:number,start:number,end:number) {
  if(!Number.isSafeInteger(source)||source<0||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end-start>16000*30)throw new Error('Use a source and a sample interval of at most 30 seconds');
  const frames=new Map<number,{start:number;end:number}>();
  for await(const line of createInterface({input:createReadStream(observations),crlfDelay:Infinity})) {
    const record=JSON.parse(line),o=record.observation;
    if(record.source!=='audio-timeline'||o?.type!=='source-frame'||o.speakerIndex!==source||o.start_sample>=end||o.end_sample<=start)continue;
    if(!Number.isSafeInteger(o.frame_seq)||!Number.isSafeInteger(o.start_sample)||!Number.isSafeInteger(o.end_sample)||o.start_sample<0||o.end_sample<=o.start_sample||o.end_sample-o.start_sample>16000*90)throw new Error('Invalid archived source clock');
    if(frames.has(o.frame_seq)||frames.size>=20000)throw new Error('Ambiguous or excessive archived frame metadata');
    frames.set(o.frame_seq,{start:o.start_sample,end:o.end_sample});
  }
  const pcm=new Float32Array(end-start),present=new Uint8Array(end-start);
  for await(const line of createInterface({input:createReadStream(tape),crlfDelay:Infinity})) {
    const frame=JSON.parse(line),span=frames.get(frame.seq);
    if(!span||frame.speakerIndex!==source)continue;
    const data=Buffer.from(frame.pcm,'base64');
    if(data.length!==(span.end-span.start)*4||frame.pcm_len!==span.end-span.start)throw new Error('Archived PCM does not match the source clock');
    for(let i=Math.max(start,span.start);i<Math.min(end,span.end);i++) {
      const value=data.readFloatLE((i-span.start)*4);
      if(!Number.isFinite(value)||present[i-start])throw new Error('Invalid or overlapping archived PCM');
      pcm[i-start]=value;present[i-start]=1;
    }
  }
  const missing:Array<{startSample:number;endSample:number}>=[];let open:number|null=null;
  for(let i=0;i<present.length;i++){
    if(!present[i]&&open===null)open=start+i;
    if(present[i]&&open!==null){missing.push({startSample:open,endSample:start+i});open=null;}
  }
  if(open!==null)missing.push({startSample:open,endSample:end});
  return {samples:missing.length?null:pcm,missing};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [tape,observations,source,start,end,target]=process.argv.slice(2);
  if(!target)throw new Error('Usage: audio-archive.js capture.jsonl observations.jsonl source start_sample end_sample output.wav');
  const result=await readCaptureAudio(tape,observations,Number(source),Number(start),Number(end));
  if(!result.samples){console.error(JSON.stringify({missing:result.missing}));process.exitCode=2;}
  else {
    const pcm=result.samples,wav=Buffer.alloc(44+pcm.byteLength);
    wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(3,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(64000,28);wav.writeUInt16LE(4,32);wav.writeUInt16LE(32,34);wav.write('data',36);wav.writeUInt32LE(pcm.byteLength,40);
    for(let i=0;i<pcm.length;i++)wav.writeFloatLE(pcm[i],44+i*4);
    writeFileSync(target,wav,{mode:0o600});
  }
}
