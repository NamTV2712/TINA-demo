import { createHash } from 'node:crypto';

// Integers and UTF-8 sorted-key JSON make the digest portable to the Python collector.
export function fingerprint(value: any): string {
  const sort = (v: any): any => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex');
}
export const foundationId = (...parts: string[]): string => fingerprint(['tina:stt:v1', ...parts]);

export function snapshotBase(instance: string, meeting: any, document: any, sources: any[], references: (s: any) => any[]) {
  const authority = { system: 'desktop', instance_id: instance };
  const locator = { platform: meeting.platform, native_meeting_id: meeting.native_meeting_id, local_meeting_id: String(meeting.id) };
  const meeting_uid = foundationId('meeting', instance, locator.platform, locator.native_meeting_id, locator.local_meeting_id);
  const catalog = sources.map(s => ({ ...s, source_id: foundationId('source', meeting_uid, s.session_id, s.channel) }))
    .sort((a, b) => a.source_id.localeCompare(b.source_id));
  return { version: 'stt-foundation.v1', meeting_uid, authority, locator,
    sources: catalog, segments: document.segments.map((s: any) => ({
      segment_id: s.segment_id, segment_uid: foundationId('segment', meeting_uid, s.segment_id),
      start_us: Math.round(s.start_ms * 1000), end_us: Math.round(s.end_ms * 1000),
      raw_text: s.raw_text, text: s.text, revision: s.revision, speaker: s.speaker,
      ...(s.speaker_id !== undefined ? { speaker_id: s.speaker_id, speaker_revision: s.speaker_revision } : {}),
      history: s.history.map((h: any) => ({ revision: h.revision, text: h.text, kind: h.kind, at: h.at })),
      audio: references(s).map(r => ({ ...r, source_id: catalog.find(c => c.session_id === r.session_id && c.channel === r.channel)!.source_id }))
        .map(({session_id, channel, ...r}: any) => r),
    })).sort((a: any, b: any) => a.start_us - b.start_us || a.segment_uid.localeCompare(b.segment_uid)) };
}
