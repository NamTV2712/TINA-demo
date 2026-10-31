import { fingerprint } from './foundation.js';
import { stableUuid } from './speaker-registry.js';
import type { AttributedWord, AlignedPhrase } from './alignment-model.js';

export interface CanonicalSegment {
  segment_id: string; start_ms: number; end_ms: number; raw_text: string; text: string; revision: number;
  audio: unknown[]; speaker_id: string | null; speaker_name: string; speaker_revision: number;
  words: AttributedWord[]; phrases: AlignedPhrase[];
  alignment: { status: 'segment_fallback' | 'aligned'; job_id: string | null; model: string | null; audio_sha256: string | null; text_sha256: string | null };
}
export interface CanonicalTranscript {
  version: 'canonical-transcript.v1'; meeting_id: number; revision: number; source_revision: string;
  updated_at: string; segments: CanonicalSegment[];
}
const boundary = (pattern: string) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`, 'iu');
const cues = {
  action_item: boundary("tôi sẽ|mình sẽ|em sẽ|anh sẽ|chị sẽ|chúng ta cần|cần phải|i will|i'll|we will|we need to|action item|phụ trách"),
  decision: boundary('thống nhất|quyết định|chốt là|we agree|we agreed|we decided|decision is'),
  fact: boundary('hiện tại|thực tế là|the current|currently|the status is'),
};
const negated = boundary("chưa|không|not|never|haven't|hasn't|didn't");
const deadline = /(?<![\p{L}\p{N}_])(?:deadline|hạn chót|trước|by|due)(?![\p{L}\p{N}_])\s+([^.!?;]{1,80})/iu;

/** Conservative VI/EN candidate extraction, matching collector/memory.py; identities come only from canonical. */
export function conversationMemory(canonical: CanonicalTranscript) {
  const groups: CanonicalSegment[][] = [];
  for (const segment of canonical.segments) {
    let last = groups.at(-1);
    if (!last || segment.end_ms - last[0].start_ms > 60_000 || last.reduce((n, s) => n + s.text.length, 0) + segment.text.length > 6000) {
      last = []; groups.push(last);
    }
    last.push(segment);
  }
  const windows = groups.map(group => {
    const evidence = group.map(s => ({ segment_id: s.segment_id, revision: s.revision, start_ms: s.start_ms, end_ms: s.end_ms,
      speaker_id: s.speaker_id, speaker_name: s.speaker_name, quote: s.text }));
    const facts = evidence.flatMap(item => Object.entries(cues).flatMap(([type, cue]) => {
      const match = cue.exec(item.quote);
      if (!match || item.quote.includes('?') || negated.test(item.quote.slice(0, match.index + match[0].length))) return [];
      return [{ id: stableUuid(`tina:desktop:fact:${canonical.meeting_id}:${type}:${fingerprint(item)}`), type,
        text: item.quote, status: 'candidate', assignee_id: null, deadline_text: type === 'action_item' ? deadline.exec(item.quote)?.[1].trim() ?? null : null,
        deadline_date: null, evidence: [item] }];
    }));
    return { id: stableUuid(`tina:desktop:window:${canonical.meeting_id}:${group[0].segment_id}`), source_revision: fingerprint(evidence),
      start_ms: group[0].start_ms, end_ms: Math.max(...group.map(s => s.end_ms)), evidence, facts };
  });
  return { version: 'meeting-memory.v1', meeting_id: canonical.meeting_id, canonical_revision: canonical.revision,
    extractor: 'rules.vi-en.v1', windows, facts: windows.flatMap(w => w.facts) };
}
