/** Keep a channel's sample domain across microphone/context restarts in one ingest session. */
export class SourceSampleClock {
  private channels=new Map<number,{epoch:number;offset:number;lastInput:number;lastEnd:number;lastCapture:number}>();
  reset():void {this.channels.clear();}
  map(source:number,captureMs:number,startSample:number,length:number):number|null {
    if(!Number.isFinite(captureMs)||!Number.isSafeInteger(startSample)||startSample<0||!Number.isSafeInteger(length)||length<1)throw new Error('Invalid source clock');
    let clock=this.channels.get(source);
    if(!clock){
      if(this.channels.size>=16)return null;
      clock={epoch:captureMs-startSample/16,offset:0,lastInput:startSample,lastEnd:startSample,lastCapture:captureMs};this.channels.set(source,clock);
    }
    if(captureMs<clock.lastCapture)return null;
    if(startSample<clock.lastInput && captureMs>clock.lastCapture)
      clock.offset=Math.max(clock.lastEnd,Math.round((captureMs-clock.epoch)*16))-startSample;
    const mapped=startSample+clock.offset;
    clock.lastInput=startSample;clock.lastEnd=Math.max(clock.lastEnd,mapped+length);clock.lastCapture=captureMs;
    return mapped;
  }
}
