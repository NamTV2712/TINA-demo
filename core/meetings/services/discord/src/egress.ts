/**
 * transcript.v1 + lifecycle.v1 egress for the Discord connector.
 *
 * The wire formats are the published contracts, not connector-private shapes:
 *   • durable feed: XADD `transcription_segments` with `{type:'transcription', meeting_id,
 *     native_meeting_id, session_uid, segments:[…]}` — the collector's envelope; a flat segment
 *     is silently dropped (`collector/ingest.py:return 0`).
 *   • live feed: PUBLISH `tc:meeting:{id}:mutable` with `{type:'transcript', meeting:{id}, segment}`.
 *   • lifecycle: POST the lifecycle.v1 event verbatim to the meeting-api callback, with
 *     `x-internal-secret` when configured.
 *
 * Mirrors `@tina/bot`'s adapters deliberately: the connector is a second producer on the same
 * bus, so its tests validate the emitted payloads against the SEALED schemas (egress.test.ts)
 * rather than trusting a copied literal.
 */
import { createClient } from 'redis';
import type { LanePort, LifecycleEvent, LifecyclePort } from './ports.js';

/** The redis stream the collector consumes. */
export const TRANSCRIPTION_STREAM = 'transcription_segments';
export const mutableChannel = (meetingId: string | number): string => `tc:meeting:${meetingId}:mutable`;

// ── transcript.v1 ─────────────────────────────────────────────────────────────────────

/** The transcript.v1 row this connector produces (structural mirror of the sealed contract). */
export interface ConnectorTranscriptSegment {
  segment_id: string;
  speaker: string;
  speaker_key?: string;
  participant_id?: string;
  text: string;
  start: number;
  end: number;
  language?: string | null;
  completed: boolean;
  absolute_start_time?: string;
  absolute_end_time?: string;
  source?: 'glow-bound' | 'provisional-cluster-id' | 'caption' | 'merged' | 'chat';
  confidence?: number;
}
export interface ConnectorTranscriptSink {
  publish(segment: ConnectorTranscriptSegment): Promise<void>;
  retract(segmentIds: string[]): Promise<void>;
}

export interface RedisTranscriptClient {
  xAdd(key: string, id: string, fields: Record<string, string>): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
}

export interface RedisTranscriptSinkOptions {
  client: RedisTranscriptClient;
  meetingId: string | number;
  nativeMeetingId?: string;
  sessionUid?: string;
}

/** Build the transcript.v1 producer. Service name on the segment is the connector's; the
 *  platform attribution rides `native_meeting_id`/`session_uid` as it does for every bot. */
export function createRedisTranscriptSink(opts: RedisTranscriptSinkOptions): ConnectorTranscriptSink {
  const { client, meetingId, nativeMeetingId, sessionUid } = opts;
  const channel = mutableChannel(meetingId);
  return {
    async publish(segment) {
      const payload = JSON.stringify({
        type: 'transcription',
        meeting_id: meetingId,
        native_meeting_id: nativeMeetingId,
        session_uid: sessionUid,
        segments: [segment],
      });
      // Both legs are awaited in order: the durable feed first, then the live one. A caller that
      // sees the live row can then assume the durable row exists (same ordering as @tina/bot).
      await client.xAdd(TRANSCRIPTION_STREAM, '*', { payload });
      await client.publish(channel, JSON.stringify({
        type: 'transcript', meeting: { id: meetingId }, segment,
      }));
    },
    async retract(segmentIds) {
      if (!segmentIds.length) return;
      await client.xAdd(TRANSCRIPTION_STREAM, '*', {
        payload: JSON.stringify({
          type: 'transcript_retract',
          meeting_id: meetingId,
          native_meeting_id: nativeMeetingId,
          session_uid: sessionUid,
          segment_ids: segmentIds,
        }),
      });
      await client.publish(channel, JSON.stringify({
        type: 'transcript_retract', meeting: { id: meetingId }, segment_ids: segmentIds,
      }));
    },
  };
}

/** Lazy node-redis wrapper: the connector boots before redis may be reachable, and a failed
 *  first publish must not kill the Gateway session. Concurrent first use shares ONE connect. */
export function redisClientFrom(redisUrl: string): RedisTranscriptClient & { quit(): Promise<void> } {
  const client = createClient({ url: redisUrl });
  client.on('error', (err: unknown) => {
    console.error(`[discord] redis error: ${(err as Error)?.message ?? String(err)}`);
  });
  let connecting: Promise<void> | undefined;
  const ensure = (): Promise<void> => {
    if (client.isOpen) return Promise.resolve();
    connecting ??= client.connect().then(() => undefined).finally(() => { connecting = undefined; });
    return connecting;
  };
  return {
    async xAdd(key, id, fields) { await ensure(); return client.xAdd(key, id, fields); },
    async publish(channel, message) { await ensure(); return client.publish(channel, message); },
    async quit() { if (client.isOpen) await client.quit(); },
  };
}

// ── lifecycle.v1 ──────────────────────────────────────────────────────────────────────

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export interface HttpLifecycleOptions {
  callbackUrl: string;
  internalSecret?: string;
  fetchImpl?: FetchLike;
  retries?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** POST lifecycle.v1 events. A delivery failure is logged, never thrown: losing a status report
 *  must not take down a live voice session (the terminal one is re-derived by the reaper). */
export function createHttpLifecycleSink(opts: HttpLifecycleOptions): LifecyclePort {
  const {
    callbackUrl,
    internalSecret,
    fetchImpl = globalThis.fetch as unknown as FetchLike,
    retries = 5,
    backoffMs = 500,
    sleep = realSleep,
  } = opts;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (internalSecret) headers['x-internal-secret'] = internalSecret;
  const attempts = Math.max(1, retries);

  return {
    async emit(event: LifecycleEvent) {
      const body = JSON.stringify({ ...event, timestamp: event.timestamp ?? new Date().toISOString() });
      let lastErr = 'unknown';
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const res = await fetchImpl(callbackUrl, { method: 'POST', headers, body });
          if (res.ok) return;
          lastErr = `HTTP ${res.status}`;
        } catch (e) {
          lastErr = (e as Error)?.message ?? String(e);
        }
        if (attempt < attempts) await sleep(backoffMs * 2 ** (attempt - 1));
      }
      console.error(`[discord] lifecycle.v1 ${event.status} POST failed after ${attempts} attempt(s): ${lastErr}`);
    },
  };
}

/** A lifecycle sink for boot-time failures that have no callback URL yet — stdout only. */
export function consoleLifecycleSink(): LifecyclePort {
  return {
    async emit(e) {
      console.log(`[discord] lifecycle.v1 ${e.status}${e.completion_reason ? ` (${e.completion_reason})` : ''}${e.reason ? ` — ${e.reason}` : ''}`);
    },
  };
}

/** Compose the two egress adapters for one session. Kept here so the composition root has one
 *  place that decides which meeting id keys the transcript channel. */
export function createSessionEgress(opts: {
  redisUrl: string;
  meetingId: string | number;
  nativeMeetingId?: string;
  sessionUid?: string;
  lifecycle: LifecyclePort;
}): { transcripts: ConnectorTranscriptSink; lifecycle: LifecyclePort; close(): Promise<void> } {
  const redis = redisClientFrom(opts.redisUrl);
  return {
    transcripts: createRedisTranscriptSink({
      client: redis,
      meetingId: opts.meetingId,
      nativeMeetingId: opts.nativeMeetingId,
      sessionUid: opts.sessionUid,
    }),
    lifecycle: opts.lifecycle,
    close: () => redis.quit(),
  };
}

/** The lane's sink bridge: gmeet lane segments → transcript.v1 rows. Drafts with no text are
 *  withdrawn by id; everything else is published (completed distinguishes final from partial). */
export function laneSinkAdapter(
  transcripts: ConnectorTranscriptSink,
  onError: (e: unknown) => void = (e) => console.error(`[discord] transcript publish failed: ${String(e)}`),
): { segment(seg: any): void; draft(seg: any): void; finalize(): void } {
  const forward = (seg: any): void => {
    const operation = seg.completed === false && !String(seg.text ?? '').trim()
      ? transcripts.retract([seg.segment_id])
      : transcripts.publish(toTranscriptSegment(seg));
    void operation.catch(onError);
  };
  return { segment: forward, draft: forward, finalize() { /* session end is lifecycle, not a segment */ } };
}

const UNATTRIBUTED = /^(?:seg_\d+|Speaker(?: \d+)?|Speaker [A-Z]+)$/;

/** The gmeet lane's segment → the connector's transcript.v1 row. `source` stays the lane's own
 *  attribution (`glow-bound` for a named channel), never re-labelled as diarization. Every
 *  optional field is omitted rather than emitted as `undefined`: transcript.v1 is
 *  `additionalProperties:false`, and an explicit `undefined` is a present-but-invalid property to
 *  a schema validator even though `JSON.stringify` would drop it. */
export function toTranscriptSegment(seg: any): ConnectorTranscriptSegment {
  const iso = (s: number): string => new Date(s * 1000).toISOString();
  const out: ConnectorTranscriptSegment = {
    segment_id: seg.segment_id,
    speaker: UNATTRIBUTED.test(String(seg.speaker ?? '')) ? '' : String(seg.speaker ?? ''),
    text: seg.text,
    start: seg.start,
    end: seg.end,
    completed: seg.completed,
    absolute_start_time: seg.absolute_start_time ?? iso(seg.start),
    absolute_end_time: seg.absolute_end_time ?? iso(seg.end),
  };
  if (seg.speaker_key !== undefined) out.speaker_key = seg.speaker_key;
  if (seg.participant_id !== undefined) out.participant_id = seg.participant_id;
  if (seg.language !== undefined) out.language = seg.language;
  if (seg.source !== undefined) out.source = seg.source;
  if (seg.confidence !== undefined) out.confidence = seg.confidence;
  return out;
}
