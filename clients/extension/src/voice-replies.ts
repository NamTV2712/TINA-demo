/** Client view of core meeting-voice.v1; never converted into ASR transcript segments. */
export interface VoiceReply { request_id: string; text: string; played_text?:string; state: string; created_at_ms: number;
  answer_kind?:'meeting'|'general'|'web';links?:Array<{url:string;title:string}> }
export const replyLabel: Record<string, string> = { queued: 'Đang chuẩn bị đọc', started: 'Đang đọc', completed: 'Đã đọc', stopped: 'Đã dừng', failed: 'Phát thất bại', unconfirmed: 'Chưa xác nhận phát xong' };
export function voiceReplies(value: unknown): VoiceReply[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Unsupported voice replies.');
  const rows = new Map<string, VoiceReply>();
  for (const item of value) {
    if (!item || typeof item.request_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.request_id)
        || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 4000
        || typeof item.state !== 'string' || !Object.prototype.hasOwnProperty.call(replyLabel, item.state) || !Number.isSafeInteger(item.created_at_ms)
        || item.created_at_ms < 0 || item.created_at_ms > 8.64e15) throw new Error('Unsupported voice reply.');
    if(item.played_text!=null&&(typeof item.played_text!=='string'||item.played_text.length>4000
      ||!item.text.trim().replace(/\s+/gu,' ').startsWith(item.played_text)))throw new Error('Unsupported played text.');
    if(item.answer_kind!=null&&!['meeting','general','web'].includes(item.answer_kind))throw new Error('Unsupported answer kind.');
    if(item.links!=null&&(!Array.isArray(item.links)||item.links.length>6||item.links.some((link:unknown)=>{
      if(!link||typeof link!=='object')return true;
      const row=link as Record<string,unknown>;
      if(typeof row.url!=='string'||row.url.length>4096||typeof row.title!=='string'||row.title.length>300)return true;
      try{const url=new URL(row.url);return !['http:','https:'].includes(url.protocol)||!!url.username||!!url.password;}catch{return true;}
    })))throw new Error('Unsupported public sources.');
    rows.set(item.request_id, { request_id: item.request_id, text: item.text, state: item.state, created_at_ms: item.created_at_ms,
      ...(item.played_text==null?{}:{played_text:item.played_text}),
      ...(item.answer_kind==null?{}:{answer_kind:item.answer_kind}),...(item.links==null?{}:{links:item.links}) });
  }
  return [...rows.values()].sort((a, b) => a.created_at_ms - b.created_at_ms);
}
