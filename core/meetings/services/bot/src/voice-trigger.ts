/** Pure, bounded assembly of ASR-addressed turns; source clocks fence repeats/late results. */
export interface VoiceHypothesis {
  channel: number; speakerKey: string; participant?: string | null;
  startMs: number; endMs: number; text: string; final: boolean;
  segments?: Array<{ text: string; startMs: number; endMs: number }>;
  asrStartedAtMs?: number; asrCompletedAtMs?: number;
  speechStartMs?: number;
}
export const VOICE_NAMES = ['TINA', 'Tina', 'TINA ơi', 'tin ơi', 'ti na ơi', 'tiên na ơi', 'tinh anh ơi','tin anh ơi'] as const;
export function invocation(text: string, variants: string[] = []): string | null {
  const value = text.normalize('NFKC').trim();
  for (const name of [...VOICE_NAMES, ...variants].sort((a, b) => b.length - a.length)) {
    const escaped = name.trim().normalize('NFKC').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!escaped) continue;
    const match = new RegExp(`^${escaped}(?=$|[^\\p{L}\\p{N}_])(?:[\\s,.!?:;…—–-]*)`, 'iu').exec(value);
    if (match) return value.slice(match[0].length).trim();
  }
  return null;
}
export function speechSentences(text: string): string[] {
  // Intl handles Vietnamese sentence boundaries and keeps decimal/abbreviation context.
  const sentences = [...new Intl.Segmenter('vi', { granularity: 'sentence' }).segment(text)].map(s => s.segment.trim()).filter(Boolean);
  const parts: string[] = [];
  for (const sentence of sentences) {
    let current = '';
    for (const word of sentence.split(/\s+/u)) {
      if (current && current.length + word.length + 1 > 360) { parts.push(current); current = ''; }
      current += (current ? ' ' : '') + word;
    }
    if (current) parts.push(current);
  }
  return parts;
}

export function turnPauseMs(text: string): number {
  const value = text.normalize('NFKC').trim();
  // shortcut: lexical pause cues only; replace after a held-out Vietnamese turn-ending evaluation.
  const unfinished = /(?:…|\.{2,}|[,;:])$/u.test(value)
    || /(?:^|\s)(?:và|nhưng|nếu|vì|để|về|của|phần|giúp tôi|cho tôi|ý tôi là|and|but|because|about|with|i mean)\s*[.!]?$/iu.test(value);
  return unfinished ? 2000 : 0;
}
interface Candidate { parts: VoiceHypothesis[]; confirmed: boolean; matches: number; seen: number; started: number; direct?: boolean; acoustic?: boolean; }
export interface AcousticWake { channel: number; participant?: string | null; startMs: number; endMs: number; }
export class VoiceTrigger {
  private candidate?: Candidate;
  private acoustic?: AcousticWake & {started: number};
  private after = 0;
  private continuation?: {channel: number; participant?: string | null; expires: number};
  heard?: VoiceHypothesis;
  reason: 'waiting' | 'invalid_asr' | 'stale_asr' | 'name_not_matched' | 'name_unconfirmed' | 'ambiguous_window' | 'other_channel' = 'waiting';
  constructor(private now: () => number = Date.now, private variants: string[] = [], private acousticOnly = false) {}
  reset(after = this.now(), variants = this.variants) { this.after = after; this.variants = variants; this.candidate = undefined; this.acoustic = undefined; this.heard = undefined; this.continuation = undefined; }
  wake(value: AcousticWake) {
    if (!Number.isInteger(value.channel) || value.channel < 0 || value.channel >= 65536
        || !Number.isFinite(value.startMs) || !Number.isFinite(value.endMs) || value.endMs <= value.startMs
        || value.endMs < this.after || value.endMs > this.now() + 1000) return false;
    const after = Math.max(this.after, value.startMs);
    this.reset(after); this.acoustic = {...value, startMs: after, started: this.now()};
    return true;
  }
  continueAfter(after: number, caller: {channel: number; participant?: string | null}, expires = this.now() + 10000) {
    this.reset(after); this.continuation = {...caller, expires};
  }
  get answeringContinuation() { return this.candidate?.direct === true && !this.candidate.acoustic; }
  get hasContinuation() { return this.continuation !== undefined && this.now() < this.continuation.expires; }
  get continuationCaller() { return this.hasContinuation ? {...this.continuation!} : undefined; }
  get acceptAfter() { return this.after; }
  get caller() {
    const first = this.candidate?.parts[0];
    return first ? {...first, participant: first.participant ?? this.acoustic?.participant} : this.acoustic;
  }
  get channel() { return this.candidate?.parts.at(-1)?.channel ?? this.acoustic?.channel; }
  get startMs() { return this.candidate?.parts[0]?.startMs ?? this.acoustic?.startMs; }
  get endMs() { return this.candidate?.parts.at(-1)?.endMs; }
  get active() { return this.candidate?.confirmed === true || this.acoustic !== undefined; }
  get pending() { return this.candidate !== undefined || this.acoustic !== undefined; }
  feed(value: VoiceHypothesis): 'wake' | 'update' | 'ignore' | 'discard' {
    this.reason = 'waiting';
    this.heard = undefined;
    const speechStart = Math.max(value.startMs, value.speechStartMs ?? value.startMs);
    if (!Number.isInteger(value.channel) || value.channel < 0 || !Number.isFinite(value.startMs) || !Number.isFinite(value.endMs)
        || !Number.isFinite(speechStart) || speechStart > value.endMs
        || value.endMs <= value.startMs || value.endMs > this.now() + 1000
        || typeof value.text !== 'string' || value.text.length > 4000) {
      this.reason = 'invalid_asr'; return 'ignore';
    }
    if (speechStart < this.after) {
      // Background PCM can keep the channel onset old; only timed ASR speech intervals prove fresh words.
      const segments = value.segments;
      const normalize = (text: string) => text.trim().replace(/\s+/gu, ' ');
      const valid = segments && segments.length <= 256 && segments.every((s, i) =>
        typeof s.text === 'string' && Number.isFinite(s.startMs) && Number.isFinite(s.endMs)
        && s.startMs >= value.startMs && s.endMs <= value.endMs + 2 && s.endMs > s.startMs
        && (!i || s.startMs >= segments[i - 1].endMs - 2))
        && normalize(segments.map(s => s.text).join(' ')) === normalize(value.text);
      const fresh = valid ? segments.filter(s => s.startMs >= this.after) : [];
      if (!fresh.length) { this.reason = 'stale_asr'; return 'ignore'; }
      value = { ...value, startMs: fresh[0].startMs, speechStartMs: fresh[0].startMs,
        text: fresh.map(s => s.text).join(' '), segments: fresh };
    }
    this.heard = value;
    let text = value.text.trim();
    if (!text) return 'ignore';
    if (this.acoustic && (value.channel !== this.acoustic.channel
        || this.acoustic.participant && value.participant && value.participant !== this.acoustic.participant)) {
      this.reason = 'other_channel'; return 'ignore';
    }
    if (this.acoustic && value.endMs < this.acoustic.endMs - 800) {
      this.reason = 'stale_asr'; return 'ignore';
    }
    let c = this.candidate;
    if (c && (this.expired() || (!this.acousticOnly && !c.confirmed && value.channel !== c.parts[0].channel && invocation(text, this.variants) !== null))) {
      this.candidate = undefined; c = undefined;
    }
    const acoustic = this.acoustic !== undefined;
    // Acoustic evidence authorizes the call; removing a recognized prefix changes only this copy.
    if (acoustic && (!c || c.parts.length === 1 && value.startMs === c.parts[0].startMs)) {
      text = invocation(text, [...this.variants, 'hey TINA', 'hey ti na', 'hây ti na', 'ti na', 'anh ơi']) ?? text;
    }
    if (!c) {
      if (this.acousticOnly && !acoustic && (!this.hasContinuation || value.channel !== this.continuation!.channel
          || this.continuation!.participant && value.participant !== this.continuation!.participant)) {
        this.reason = 'name_not_matched'; return 'ignore';
      }
      const direct = acoustic || invocation(text, this.variants) === null;
      if (direct && this.continuation && text.toLocaleLowerCase('vi').replace(/[^\p{L}]/gu, '') === 'dạemnghe') return 'ignore';
      if (direct && !acoustic && (!this.continuation || this.now() >= this.continuation.expires
          || value.channel !== this.continuation.channel
          || (this.continuation.participant && value.participant !== this.continuation.participant))) {
        this.reason = 'name_not_matched'; return 'ignore';
      }
      this.continuation = undefined;
      this.candidate = { parts: [{ ...value, text }], confirmed: value.final, matches: 1, seen: this.now(),
        started: this.acoustic?.started ?? this.now(), direct, acoustic };
      this.reason = value.final ? 'waiting' : 'name_unconfirmed';
      return value.final ? 'wake' : 'update';
    }
    const first = c.parts[0], last = c.parts.at(-1)!;
    if (value.channel !== first.channel) { this.reason = 'other_channel'; return 'ignore'; }
    if ((value.participant && last.participant && value.participant !== last.participant)
        || value.startMs < last.startMs || this.now() - c.started > 20_000 || value.startMs - last.endMs > 5000) return this.discard();
    if (value.startMs === last.startMs) {
      if (value.endMs < last.endMs) return 'ignore';
      if (!c.direct && c.parts.length === 1 && invocation(text, this.variants) === null) return this.discard('name_not_matched');
      last.text = text; last.endMs = value.endMs; last.segments = value.segments; last.final = value.final;
    } else {
      if (value.startMs < last.endMs - 2) {
        const prefix = last.segments?.filter(s => s.endMs <= value.startMs + 2);
        const boundary = prefix?.at(-1)?.endMs;
        if (!prefix?.length || boundary === undefined || Math.abs(boundary - value.startMs) > 2) return this.discard();
        last.text = prefix.map(s => s.text).join(' '); last.endMs = boundary;
      }
      if (c.parts.length >= 24) return this.discard();
      c.parts.push({ ...value, text });
    }
    c.matches++; c.seen = this.now();
    if (!c.confirmed && (value.final || c.matches >= 2)) { c.confirmed = true; return 'wake'; }
    return 'update';
  }
  private discard(reason: 'ambiguous_window' | 'name_not_matched' = 'ambiguous_window'): 'discard' { this.reset(this.now()); this.reason = reason; return 'discard'; }
  question(quietEndMs: number | undefined): string | null {
    const c = this.candidate;
    if (!c || !c.confirmed || quietEndMs === undefined) return null;
    const last = c.parts.at(-1)!;
    // Both clocks come from capture samples; only rounding slack is safe for a short final word.
    if (last.endMs < quietEndMs - 2 || this.now() - c.seen < 300) return null;
    const text = c.parts.map(p => p.text).join(' ');
    const question = c.direct ? text : invocation(text, this.variants);
    const pause = question ? turnPauseMs(question) : 0;
    if (pause > 0 && this.now() - quietEndMs < pause) return null;
    return question !== null && question.length <= 2000 ? question : null;
  }
  expired() {
    const c = this.candidate;
    if (!c) return this.acoustic !== undefined && this.now() - this.acoustic.started > 20_000;
    const joined = c.parts.map(p => p.text).join(' ');
    const text = c.direct ? joined : invocation(joined, this.variants);
    return this.now() - c.started > (text ? 20_000 : 5000);
  }
}
