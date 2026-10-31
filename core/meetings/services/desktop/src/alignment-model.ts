import { createHash } from 'node:crypto';
import { fingerprint } from './foundation.js';
import { stableUuid, type SpeakerState } from './speaker-registry.js';
import type { DiarizationJob } from './speaker-diarization.js';

export const alignmentHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export interface CaptureReference { session_id: string; channel: number; start_sample: number; end_sample: number; start_ms: number; end_ms: number }
export interface AlignedWord { index: number; text: string; start_ms: number | null; end_ms: number | null; aligned: boolean }
export interface AlignmentItem {
  segment_id: string; expected_revision: number; text_sha256: string; capture: CaptureReference;
  state: 'pending' | 'aligned' | 'skipped' | 'stale'; audio_sha256?: string; model?: string;
  duration_ms?: number; words?: AlignedWord[]; reason?: string;
}
export interface AlignmentJob {
  version: 'transcript-alignment.v1'; id: string; status: 'running' | 'paused' | 'completed' | 'cancelled' | 'interrupted' | 'failed';
  backend: string; model: string; text_kind: 'accepted'; created_at: string; finished_at?: string;
  error?: string; items: AlignmentItem[];
}
export interface AlignmentResult extends AlignmentItem { job_id: string }
export interface AttributedWord extends AlignedWord { speaker_id: string | null; speaker_name: string; speaker_source: 'confirmed' | 'diarization' | 'unknown' }
export interface AlignedPhrase { speaker_id: string | null; speaker_name: string; text: string; start_ms: number; end_ms: number; word_indices: number[] }

export function validateAlignment(value: unknown, audio: Buffer, text: string): Pick<AlignmentItem, 'audio_sha256' | 'text_sha256' | 'duration_ms' | 'model' | 'words'> {
  const result = value as any, duration = (audio.length - 44) / 32, tokens = text.match(/\S+/gu) ?? [];
  if (!result || result.audio_sha256 !== alignmentHash(audio) || result.text_sha256 !== alignmentHash(text)
      || typeof result.model !== 'string' || !result.model || result.model.length > 256
      || !Number.isFinite(result.duration_ms) || Math.abs(result.duration_ms - duration) > 1
      || !Array.isArray(result.words) || result.words.length !== tokens.length) throw new Error('Invalid alignment provenance');
  let previousStart = -1, previousEnd = -1;
  const words = result.words.map((word: any, index: number): AlignedWord => {
    if (!word || word.index !== index || word.text !== tokens[index] || typeof word.aligned !== 'boolean') throw new Error('Alignment changed source tokens');
    const start = word.start_ms, end = word.end_ms;
    if (word.aligned) {
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= duration || end <= start || end > duration + 1
          || start < previousStart || end < previousEnd) throw new Error('Invalid alignment time');
      previousStart = start; previousEnd = end;
      return { index, text: tokens[index], aligned: true, start_ms: Math.min(start, duration), end_ms: Math.min(end, duration) };
    }
    if (start !== null || end !== null) throw new Error('Unaligned word claims a time');
    return { index, text: tokens[index], aligned: false, start_ms: null, end_ms: null };
  });
  return { model: result.model, duration_ms: duration, audio_sha256: result.audio_sha256, text_sha256: result.text_sha256, words };
}

/** Conservative word policy from collector/diarization.py, in milliseconds. */
function wordVoice(start: number, end: number, job: DiarizationJob): number | null {
  const duration = end - start; if (duration < 40) return null;
  const turns = job.turns.filter(t => t.start_ms < end && t.end_ms > start);
  const edges = [...new Set([start, end, ...turns.flatMap(t => [Math.max(start, t.start_ms), Math.min(end, t.end_ms)])])].sort((a, b) => a - b);
  const owned = new Map<number, number>(); let overlap = 0;
  for (let i = 1; i < edges.length; i++) {
    const voices = new Set(turns.filter(t => t.start_ms < edges[i] && t.end_ms > edges[i - 1]).map(t => t.speaker));
    if (voices.size === 1) { const voice = [...voices][0]; owned.set(voice, (owned.get(voice) ?? 0) + edges[i] - edges[i - 1]); }
    else if (voices.size > 1) overlap += edges[i] - edges[i - 1];
  }
  const ranked = [...owned].sort((a, b) => b[1] - a[1]);
  return ranked.length && overlap <= .1 * duration && ranked[0][1] >= .75 * duration && (ranked[1]?.[1] ?? 0) <= .15 * duration ? ranked[0][0] : null;
}

export function projectAlignment(key: string, item: AlignmentResult, state: SpeakerState, diarization: DiarizationJob | null) {
  const binding = state.segments[item.segment_id], identity = binding && state.speakers[binding.speaker_id];
  const fixed = binding && (binding.manual || identity?.manual || identity?.source === 'local_mic' || identity?.source === 'meet_dom');
  const part = diarization?.applied_at && diarization.status === 'completed' ? diarization.parts.find(p => p.session === item.capture.session_id
    && p.start_sample <= item.capture.start_sample && p.end_sample >= item.capture.end_sample) : undefined;
  const analysisIdentity = diarization && fingerprint({ audio: diarization.audio_sha256, model: diarization.model, num_speakers: diarization.num_speakers, turns: diarization.turns });
  const words: AttributedWord[] = (item.words ?? []).map(word => {
    let id: string | null = null, source: AttributedWord['speaker_source'] = 'unknown';
    if (fixed) { id = binding.speaker_id; source = 'confirmed'; }
    else if (part && diarization && word.aligned) {
      const offset = part.offset_ms + (item.capture.start_sample - part.start_sample) / 16;
      const voice = wordVoice(offset + word.start_ms!, offset + word.end_ms!, diarization);
      const candidate = voice === null ? null : stableUuid(`tina:desktop:speaker:${key}:diarization:${analysisIdentity}:${voice}`);
      if (candidate && state.speakers[candidate]) { id = candidate; source = 'diarization'; }
    }
    return { ...word, speaker_id: id, speaker_name: id ? state.speakers[id]?.name || 'Unknown speaker' : 'Unknown speaker', speaker_source: source };
  });
  const phrases: AlignedPhrase[] = [];
  let phrase: AlignedPhrase | undefined;
  for (const word of words) {
    if (!word.aligned) { phrase = undefined; continue; }
    if (!phrase || phrase.speaker_id !== word.speaker_id || word.start_ms! - phrase.end_ms > 800) {
      phrase = { speaker_id: word.speaker_id, speaker_name: word.speaker_name, text: word.text, start_ms: word.start_ms!, end_ms: word.end_ms!, word_indices: [word.index] }; phrases.push(phrase);
    } else { phrase.text += ' ' + word.text; phrase.end_ms = word.end_ms!; phrase.word_indices.push(word.index); }
  }
  return { words, phrases };
}

