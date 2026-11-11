/** Explicit, caller-bound interruption; ordinary speech never grants a new turn. */
import {VoiceTrigger, invocation, type VoiceHypothesis} from './voice-trigger.js';

export class VoiceInterruption {
  private trigger: VoiceTrigger;
  private expires: number;
  constructor(private caller: {channel:number;participant:string}, private after:number,
    private now:()=>number=Date.now) {
    this.trigger=new VoiceTrigger(now,[],true);
    this.expires=now()+210000;this.reset();
  }
  private reset(){this.trigger.continueAfter(this.after,this.caller,this.expires);}
  feed(value:VoiceHypothesis, spoken:string) {
    const result=this.trigger.feed(value),fresh=this.trigger.heard;
    if(!fresh||!['wake','update'].includes(result))return null;
    const text=invocation(fresh.text,['hey TINA','hey ti na'])??fresh.text.trim();
    const match=/^(dừng lại|ngừng lại|khoan(?: đã| một chút)?|ý tôi là|stop|wait|i mean)(?=$|[^\p{L}\p{N}_])[\s,.!?:;…—–-]*/iu.exec(text);
    const normalized=(s:string)=>' '+s.normalize('NFKC').toLocaleLowerCase('vi').replace(/[^\p{L}\p{N}]+/gu,' ').trim()+' ';
    const echo = spoken.trim() && (normalized(spoken) === normalized(text)
      || text.trim().split(/\s+/u).length >= 3 && normalized(spoken).includes(normalized(text)));
    if(!match||fresh.endMs-Math.max(fresh.startMs,fresh.speechStartMs??fresh.startMs)<150
        ||echo){this.reset();return null;}
    if(result!=='wake')return null;
    const correction=/^(ý tôi là|i mean)$/iu.test(match[1]);
    const question=correction?text:text.slice(match[0].length).trim();
    return {value:fresh,question,resume:!!question||!/^(dừng lại|ngừng lại|stop)$/iu.test(match[1])};
  }
}
