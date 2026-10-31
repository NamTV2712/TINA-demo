import { createHash } from 'node:crypto';
import type { TranscriptSegment } from '@tina/gmeet-pipeline';
import { isArchiveOnlyCaptureSource } from './audio-routing.js';

export type SpeakerSource = 'local_mic' | 'meet_dom' | 'manual' | 'diarization' | 'unattributed';
export interface SpeakerEntry {
  speaker_id: string; name: string | null; candidate_name: string | null; participant_id: string | null;
  status: 'unknown' | 'observed' | 'confirmed'; source: SpeakerSource; revision: number; manual: boolean;
  history: Array<{ revision: number; name: string | null; source: SpeakerSource; at: string }>;
}
export interface SpeakerState {
  revision: number; speakers: Record<string, SpeakerEntry>; bindings: Record<string, string>;
  segments: Record<string, { speaker_id: string; revision: number; manual: boolean; raw_speaker: string }>;
}
export const emptySpeakers = (): SpeakerState => ({ revision: 0, speakers: Object.create(null), bindings: Object.create(null), segments: Object.create(null) });

export function stableUuid(value: string): string {
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const bytes = createHash('sha1').update(namespace).update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const sourceChannel = (segment: Pick<TranscriptSegment, 'speaker_key'>): number | undefined => {
  const match = segment.speaker_key?.match(/^ch-(\d+):/);
  return match ? Number(match[1]) : undefined;
};
export function recordSpeaker(entry: SpeakerEntry, name: string | null, source: SpeakerSource, status: SpeakerEntry['status']): void {
  if (entry.history.length >= 100) throw new Error('Speaker history limit reached');
  entry.name = name; entry.source = source; entry.status = status; entry.revision++;
  entry.history.push({ revision: entry.revision, name, source, at: new Date().toISOString() });
}
export function registerSpeaker(state: SpeakerState, meeting: string, binding: string,
  source: SpeakerSource, name: string | null = null, candidate: string | null = null, participant: string | null = null): SpeakerEntry {
  const id = state.bindings[binding] ?? stableUuid(`tina:desktop:speaker:${meeting}:${binding}`);
  if (!state.speakers[id]) {
    const entry: SpeakerEntry = { speaker_id: id, name: null, candidate_name: candidate, participant_id: participant,
      status: 'unknown', source, revision: 0, manual: false, history: [] };
    recordSpeaker(entry, name, source, name ? 'observed' : 'unknown'); state.speakers[id] = entry;
  }
  state.bindings[binding] = id;
  return state.speakers[id];
}
export function observeSpeakers(state: SpeakerState, meeting: { platform: string; native_meeting_id: string },
  segments: TranscriptSegment[], captureSession?: string): void {
  const key = `${meeting.platform}/${meeting.native_meeting_id}`;
  for (const segment of segments) {
    if (!segment.segment_id) continue;
    const channel = sourceChannel(segment);
    if (channel !== undefined && isArchiveOnlyCaptureSource(channel)) continue;
    const prior = state.segments[segment.segment_id];
    const participant = meeting.platform === 'google_meet' && segment.source === 'glow-bound'
      && typeof segment.participant_id === 'string' && segment.participant_id.length > 0 && segment.participant_id.length <= 512
      ? segment.participant_id : null;
    if (prior && (prior.manual || state.speakers[prior.speaker_id]?.manual || state.speakers[prior.speaker_id]?.source === 'diarization' || !participant)) continue;
    const local = channel === 1000;
    const binding = local ? 'local-microphone' : participant ? `meet:${participant}`
      : channel !== undefined && channel !== 999 ? `track:${captureSession ?? 'legacy'}:${segment.speaker_key}` : `unknown:${segment.segment_id}`;
    const raw = (segment.speaker || '').normalize('NFC').trim().slice(0, 120);
    const candidate = raw && !/^(?:you|system audio|unknown(?: speaker)?|speaker(?: [a-z0-9]+)?|seg_\d+)$/i.test(raw) ? raw : null;
    const entry = registerSpeaker(state, key, binding, local ? 'local_mic' : participant ? 'meet_dom' : 'unattributed',
      local ? 'You' : participant ? candidate : null, channel === 999 ? null : candidate, participant);
    if (prior?.speaker_id !== entry.speaker_id) {
      state.revision++;
      state.segments[segment.segment_id] = { speaker_id: entry.speaker_id, revision: state.revision, manual: false, raw_speaker: prior?.raw_speaker ?? segment.speaker };
    }
  }
}
export function speakerFor(state: SpeakerState, segmentId: string) {
  const binding = state.segments[segmentId], entry = binding && state.speakers[binding.speaker_id];
  return { speaker_id: entry?.speaker_id ?? null, speaker_name: entry?.name || 'Unknown speaker',
    speaker_revision: entry ? Math.max(entry.revision, binding.revision) : 0 };
}
export function renameSpeaker(state: SpeakerState, speakerId: string, expected: number, value: unknown): SpeakerEntry {
  const entry = state.speakers[speakerId];
  if (!entry) throw new RangeError('Speaker not found');
  if (entry.revision !== expected) throw new Error('Speaker changed; reload before saving');
  if (value !== null && (typeof value !== 'string' || /[\x00-\x1f\x7f]/u.test(value))) throw new RangeError('Invalid speaker name');
  const name = typeof value === 'string' ? value.normalize('NFC').replace(/\s+/gu, ' ').trim() : null;
  if (name !== null && (!name || name.length > 120)) throw new RangeError('Use a speaker name of 1–120 characters');
  recordSpeaker(entry, name, 'manual', name ? 'confirmed' : 'unknown'); entry.manual = true; state.revision++;
  return entry;
}
export function assignSpeaker(state: SpeakerState, meeting: string, segmentId: string, expected: number, speakerId: string | null): SpeakerEntry {
  if (state.revision !== expected) throw new Error('Speaker assignments changed; reload before saving');
  if (!state.segments[segmentId]) throw new RangeError('Segment not found');
  const entry = speakerId === null ? registerSpeaker(state, meeting, `manual-unknown:${segmentId}`, 'manual') : state.speakers[speakerId];
  if (!entry) throw new RangeError('Speaker not found');
  state.revision++;
  state.segments[segmentId] = { speaker_id: entry.speaker_id, revision: state.revision, manual: true, raw_speaker: state.segments[segmentId].raw_speaker };
  recordSpeaker(entry, entry.name, entry.source, entry.status);
  return entry;
}

export interface DiarizationTurn { start_ms: number; end_ms: number; speaker: number }
/** Same conservative whole-segment policy as Meeting API collector/diarization.py. */
export function attributedVoice(start: number, end: number, turns: DiarizationTurn[]): number | null {
  if (end - start < 500) return null;
  const relevant = turns.filter(t => t.start_ms < end && t.end_ms > start);
  const edges = [...new Set([start, end, ...relevant.flatMap(t => [Math.max(start, t.start_ms), Math.min(end, t.end_ms)])])].sort((a, b) => a - b);
  const owned = new Map<number, number>();
  for (let i = 1; i < edges.length; i++) {
    const speakers = new Set(relevant.filter(t => t.start_ms < edges[i] && t.end_ms > edges[i - 1]).map(t => t.speaker));
    if (speakers.size === 1) { const voice = [...speakers][0]; owned.set(voice, (owned.get(voice) ?? 0) + edges[i] - edges[i - 1]); }
  }
  const ranked = [...owned].sort((a, b) => b[1] - a[1]);
  return ranked.length && ranked[0][1] >= Math.max(500, .75 * (end - start)) && (ranked[1]?.[1] ?? 0) <= .15 * (end - start) ? ranked[0][0] : null;
}
