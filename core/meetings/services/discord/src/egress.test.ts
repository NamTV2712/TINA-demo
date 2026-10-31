/**
 * L2 — transcript.v1 + lifecycle.v1 egress.
 *
 * The connector is a SECOND producer on the same bus as @tina/bot, so these checks validate the
 * emitted payloads against the PUBLISHED schemas (loaded by path) instead of against a copied
 * literal. The collector envelope is checked field by field because it deliberately extends
 * transcript.v1 `Transcription` with `native_meeting_id` (bot parity).
 *
 * Run: npx tsx src/egress.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Ajv, ValidateFunction } from 'ajv';
import addFormatsDefault from 'ajv-formats';
import {
  TRANSCRIPTION_STREAM,
  createHttpLifecycleSink,
  createRedisTranscriptSink,
  laneSinkAdapter,
  mutableChannel,
  toTranscriptSegment,
  type RedisTranscriptClient,
} from './egress.js';
import type { LifecycleEvent } from './ports.js';

const addFormats = addFormatsDefault as unknown as (ajv: Ajv) => Ajv;

let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = join(HERE, '..', '..', '..', 'contracts');

function validatorFor(path: string, def: string): ValidateFunction {
  const schema = JSON.parse(readFileSync(path, 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(schema);
  return ajv.compile({ $ref: `${schema.$id}#/$defs/${def}` });
}

const validateSegment = validatorFor(join(CONTRACTS, 'transcript.v1', 'transcript.schema.json'), 'TranscriptSegment');
const validateLifecycle = validatorFor(join(CONTRACTS, 'lifecycle.v1', 'lifecycle.schema.json'), 'LifecycleEvent');

function schemaErrors(validate: ValidateFunction): string {
  return (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
}

class FakeRedis implements RedisTranscriptClient {
  calls: Array<{ op: 'xAdd'; key: string; id: string; fields: Record<string, string> } | { op: 'publish'; channel: string; message: string }> = [];
  async xAdd(key: string, id: string, fields: Record<string, string>): Promise<unknown> {
    this.calls.push({ op: 'xAdd', key, id, fields });
    return '1-0';
  }
  async publish(channel: string, message: string): Promise<unknown> {
    this.calls.push({ op: 'publish', channel, message });
    return 1;
  }
}

const SEGMENT = {
  segment_id: 'conn-1:ch0:1700000000000',
  speaker: 'Alice',
  speaker_key: 'ch0',
  participant_id: '111111111111111111',
  text: 'hello from Discord',
  start: 1_700_000_000.0,
  end: 1_700_000_002.0,
  language: 'en',
  completed: true,
  absolute_start_time: '2023-11-14T22:13:20.000Z',
  absolute_end_time: '2023-11-14T22:13:22.000Z',
  source: 'glow-bound' as const,
  confidence: 0.92,
};

// ── durable transcript stream ───────────────────────────────────────────────────────
{
  const redis = new FakeRedis();
  const sink = createRedisTranscriptSink({
    client: redis,
    meetingId: 42,
    nativeMeetingId: '111111111111111111:222222222222222222',
    sessionUid: 'conn-1',
  });

  await sink.publish(SEGMENT);
  check('publish writes the durable stream first, then the live channel',
    redis.calls.map((c) => c.op).join(',') === 'xAdd,publish', JSON.stringify(redis.calls.map((c) => c.op)));
  check('the durable key is transcription_segments', redis.calls[0]?.op === 'xAdd' && (redis.calls[0] as any).key === TRANSCRIPTION_STREAM);
  check('the stream entry uses an auto id', (redis.calls[0] as any).id === '*');

  const envelope = JSON.parse((redis.calls[0] as any).fields.payload);
  check('envelope type is transcription', envelope.type === 'transcription');
  check('envelope keys the collector expects are present',
    envelope.meeting_id === 42 && envelope.session_uid === 'conn-1'
      && envelope.native_meeting_id === '111111111111111111:222222222222222222');
  check('envelope carries exactly one segment', Array.isArray(envelope.segments) && envelope.segments.length === 1);
  check('the segment validates against sealed transcript.v1', validateSegment(envelope.segments[0]) === true, schemaErrors(validateSegment));

  const live = JSON.parse((redis.calls[1] as any).message);
  check('the live channel is tc:meeting:{id}:mutable', (redis.calls[1] as any).channel === mutableChannel(42));
  check('the live envelope is a transcript bundle for the same meeting',
    live.type === 'transcript' && live.meeting.id === 42 && live.segment.segment_id === SEGMENT.segment_id);
}

// ── retract ─────────────────────────────────────────────────────────────────────────
{
  const redis = new FakeRedis();
  const sink = createRedisTranscriptSink({ client: redis, meetingId: 42, sessionUid: 'conn-1' });
  await sink.retract(['seg-a', 'seg-b']);
  const durable = JSON.parse((redis.calls[0] as any).fields.payload);
  const live = JSON.parse((redis.calls[1] as any).message);
  check('retract writes a transcript_retract envelope',
    durable.type === 'transcript_retract' && durable.segment_ids.join(',') === 'seg-a,seg-b');
  check('retract also withdraws the live rows',
    live.type === 'transcript_retract' && live.meeting.id === 42 && live.segment_ids.length === 2);

  redis.calls.length = 0;
  await sink.retract([]);
  check('an empty retract writes nothing', redis.calls.length === 0);
}

// ── segment translation stays inside the sealed shape ──────────────────────────────
{
  const translated = toTranscriptSegment({
    segment_id: 'seg-1',
    speaker: 'Speaker 2', // the lane's unattributed placeholder
    speaker_key: 'ch2',
    participant_id: 'u9',
    text: 'hi',
    start: 1_700_000_000,
    end: 1_700_000_001.5,
    completed: false,
    source: 'glow-bound',
  });
  check('an unattributed lane label becomes an empty speaker', translated.speaker === '');
  check('absolute times are derived from epoch seconds',
    translated.absolute_start_time === '2023-11-14T22:13:20.000Z'
      && translated.absolute_end_time === '2023-11-14T22:13:21.500Z');
  check('absent optional fields are omitted, not emitted as undefined',
    !('language' in translated) && !('confidence' in translated));
  check('the translated row validates against sealed transcript.v1', validateSegment(translated) === true, schemaErrors(validateSegment));

  const named = toTranscriptSegment({ ...SEGMENT });
  check('a named speaker and its attribution survive translation',
    named.speaker === 'Alice' && named.source === 'glow-bound' && named.confidence === 0.92);
}

// ── lane adapter: empty drafts are withdrawn ───────────────────────────────────────
{
  const redis = new FakeRedis();
  const sink = createRedisTranscriptSink({ client: redis, meetingId: 42, sessionUid: 'conn-1' });
  const adapter = laneSinkAdapter(sink, (e) => check('adapter reported an error unexpectedly', false, String(e)));

  adapter.draft({ ...SEGMENT, segment_id: 'draft-1', text: '  ', completed: false });
  await new Promise<void>((r) => setTimeout(r, 0));
  const retract = JSON.parse((redis.calls[0] as any).fields.payload);
  check('an empty draft is retracted instead of published', retract.type === 'transcript_retract' && retract.segment_ids[0] === 'draft-1');

  redis.calls.length = 0;
  adapter.segment({ ...SEGMENT, segment_id: 'final-1' });
  await new Promise<void>((r) => setTimeout(r, 0));
  const published = JSON.parse((redis.calls[0] as any).fields.payload);
  check('a completed turn is published', published.type === 'transcription' && published.segments[0].segment_id === 'final-1');
  check('the published segment validates', validateSegment(published.segments[0]) === true, schemaErrors(validateSegment));

  redis.calls.length = 0;
  adapter.finalize();
  check('finalize() emits no extra row (session end is lifecycle)', redis.calls.length === 0);
}

// ── lifecycle.v1 over HTTP ─────────────────────────────────────────────────────────
{
  const posts: Array<{ url: string; init: any }> = [];
  const sink = createHttpLifecycleSink({
    callbackUrl: 'http://meeting-api:8080/internal/bot/lifecycle',
    internalSecret: 's3cret',
    retries: 2,
    backoffMs: 0,
    sleep: async () => { /* no wait */ },
    fetchImpl: async (url, init) => {
      posts.push({ url, init });
      return { ok: true, status: 200 };
    },
  });
  const event: LifecycleEvent = {
    connection_id: 'conn-1',
    container_id: 'dc-1-test',
    status: 'active',
    timestamp: '2023-11-14T22:13:20.000Z',
  };
  await sink.emit(event);
  check('lifecycle POSTs to the callback URL', posts[0]?.url === 'http://meeting-api:8080/internal/bot/lifecycle');
  check('lifecycle sends the internal secret', posts[0]?.init.headers['x-internal-secret'] === 's3cret');
  check('lifecycle sends JSON', posts[0]?.init.headers['content-type'] === 'application/json');
  const body = JSON.parse(posts[0]!.init.body);
  check('the lifecycle event validates against sealed lifecycle.v1', validateLifecycle(body) === true, schemaErrors(validateLifecycle));
  check('container_id rides the terminal/active event', body.container_id === 'dc-1-test');

  let stamped: any;
  const stamping = createHttpLifecycleSink({
    callbackUrl: 'http://x/lifecycle',
    retries: 1,
    fetchImpl: async (_url, init) => { stamped = JSON.parse(init.body); return { ok: true, status: 200 }; },
  });
  await stamping.emit({ connection_id: 'c', status: 'joining' });
  check('a missing timestamp is stamped with the emit time',
    typeof stamped.timestamp === 'string' && !Number.isNaN(Date.parse(stamped.timestamp)));
}

// ── lifecycle retries, then gives up without throwing ──────────────────────────────
{
  let attempts = 0;
  const sink = createHttpLifecycleSink({
    callbackUrl: 'http://x/lifecycle',
    retries: 3,
    backoffMs: 0,
    sleep: async () => { /* no wait */ },
    fetchImpl: async () => {
      attempts++;
      if (attempts < 3) throw new Error('connection refused');
      return { ok: true, status: 200 };
    },
  });
  await sink.emit({ connection_id: 'c', status: 'joining' });
  check('lifecycle retries a transient failure and then succeeds', attempts === 3, String(attempts));

  let giveUpAttempts = 0;
  const broken = createHttpLifecycleSink({
    callbackUrl: 'http://x/lifecycle',
    retries: 2,
    backoffMs: 0,
    sleep: async () => { /* no wait */ },
    fetchImpl: async () => {
      giveUpAttempts++;
      return { ok: false, status: 503 };
    },
  });
  let threw = false;
  try {
    await broken.emit({ connection_id: 'c', status: 'completed', completion_reason: 'stopped' });
  } catch {
    threw = true;
  }
  check('an undeliverable terminal event is logged, never thrown', !threw && giveUpAttempts === 2, String(giveUpAttempts));
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall egress checks passed');
process.exit(failed ? 1 : 0);
