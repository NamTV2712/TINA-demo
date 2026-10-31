/**
 * L3 — recording sink (recording.v1 PER-CHUNK durable upload). OFFLINE, NO disk (HTTP only to a
 * localhost capture server for the wire arm).
 *
 * #491/#412: the 0.12 bot accumulated the whole recording in Node memory and uploaded ONE master at
 * graceful close — a SIGKILL lost everything. This sink uploads EACH timeslice immediately. This
 * test is the P22/#224-class regression pin that absence lacked. It asserts:
 *   • each chunk() uploads IMMEDIATELY (before any close), in seq order, with bytes forwarded;
 *   • a simulated mid-meeting kill (close never called, no final) leaves every finished part
 *     ALREADY durable — no all-or-nothing loss (V2/#412);
 *   • the empty is_final chunk is FORWARDED (the COMPLETED signal), never dropped;
 *   • close() with no prior final sends EXACTLY ONE empty is_final fallback (the live Stop race),
 *     and fires at most once; a never-fed session's close is a no-op;
 *   • over the real RecordingService HTTP wire, session_uid == inv.connectionId on every chunk,
 *     seq monotone, only the last is_final (the split/404-guard contract).
 * Run: npx tsx src/recording.test.ts
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBotRecordingSink, type ChunkUploader } from './recording.js';
import type { Invocation } from './config.js';
import type { RecordingMasterFormat } from '@tina/recording';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

const inv = (over: Partial<Invocation> = {}): Invocation => ({
  platform: 'google_meet', meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'TINA',
  redisUrl: 'redis://localhost:6379', recordingEnabled: true, connectionId: 'conn-xyz', ...over,
});

/** A record of one delivered chunk (what the injected uploader saw). */
interface Seen { seq: number; isFinal: boolean; format: string; len: number }
function fakeUploader(): { seen: Seen[]; upload: ChunkUploader; waitForUploads: (count: number) => Promise<void> } {
  const seen: Seen[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const waitForUploads = (count: number): Promise<void> => {
    if (seen.length >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = {
        count,
        resolve: () => {
          if (timer) clearTimeout(timer);
          resolve();
        },
      };
      timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`timed out waiting for ${count} uploads; saw ${seen.length}`));
      }, 2000);
      waiters.push(waiter);
    });
  };
  const upload: ChunkUploader = (seq, isFinal, format, bytes) => {
    seen.push({ seq, isFinal, format, len: bytes.length });
    for (const waiter of [...waiters]) {
      if (seen.length >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  return { seen, upload, waitForUploads };
}

async function main(): Promise<void> {
  // ── 1) each timeslice uploads IMMEDIATELY, in seq order, bytes forwarded ─────────────────────
  {
    const { seen, upload, waitForUploads } = fakeUploader();
    const sink = createBotRecordingSink({ inv: inv(), uploadChunk: upload });
    const threeUploads = waitForUploads(3);
    sink.chunk('google_meet/m1', 0, false, 'webm', new Uint8Array([1, 2, 3]));
    sink.chunk('google_meet/m1', 1, false, 'webm', new Uint8Array([4, 5]));
    sink.chunk('google_meet/m1', 2, false, 'webm', new Uint8Array([6]));
    await threeUploads;
    check('per-chunk: 3 chunks → 3 immediate uploads BEFORE any close', seen.length === 3, String(seen.length));
    check('per-chunk: none accumulated as a whole-recording master', seen.every((s) => s.len <= 3), JSON.stringify(seen));
    check('per-chunk: all non-final', seen.every((s) => !s.isFinal), JSON.stringify(seen));
    check('per-chunk: seq order 0,1,2', seen.map((s) => s.seq).join(',') === '0,1,2', seen.map((s) => s.seq).join(','));
    check('per-chunk: bytes forwarded verbatim (3,2,1)', seen.map((s) => s.len).join(',') === '3,2,1', seen.map((s) => s.len).join(','));
  }

  // ── 2) kill-before-close: no close, no final → the N finished parts are ALREADY durable (#412) ──
  {
    const { seen, upload, waitForUploads } = fakeUploader();
    const sink = createBotRecordingSink({ inv: inv(), uploadChunk: upload });
    const fourUploads = waitForUploads(4);
    for (let i = 0; i < 4; i++) sink.chunk('google_meet/m2', i, false, 'webm', new Uint8Array([i]));
    await fourUploads;
    // simulate SIGKILL: close() is NEVER called — nothing was buffered waiting for it.
    check('crash: N=4 parts durable before any close (no all-or-nothing loss)', seen.length === 4, String(seen.length));
    check('crash: no final signal sent (recording stays in_progress; finalize-on-read still serves it)',
      seen.every((s) => !s.isFinal), JSON.stringify(seen));
  }

  // ── 3) the empty is_final chunk is FORWARDED (COMPLETED signal), not dropped ─────────────────
  {
    const { seen, upload, waitForUploads } = fakeUploader();
    const sink = createBotRecordingSink({ inv: inv(), uploadChunk: upload });
    const twoUploads = waitForUploads(2);
    sink.chunk('google_meet/m3', 0, false, 'webm', new Uint8Array([9, 9]));
    sink.chunk('google_meet/m3', 1, true, 'webm', new Uint8Array(0)); // empty final = COMPLETED signal
    await twoUploads;
    check('final: empty is_final forwarded (not dropped)', seen.length === 2, String(seen.length));
    const fin = seen[seen.length - 1];
    check('final: last upload is isFinal=true, 0 bytes', !!fin && fin.isFinal && fin.len === 0, JSON.stringify(fin));
  }

  // ── 4) close() with no prior final → EXACTLY ONE empty is_final fallback (live Stop race) ────
  {
    const { seen, upload } = fakeUploader();
    const sink = createBotRecordingSink({ inv: inv(), uploadChunk: upload });
    sink.chunk('google_meet/m4', 0, false, 'webm', new Uint8Array([1]));
    sink.chunk('google_meet/m4', 1, false, 'webm', new Uint8Array([2]));
    await sink.close('google_meet/m4');   // host-side close (the WS dropped) — synthesize the final signal
    check('fallback: 2 data uploads + 1 synthesized final', seen.length === 3, String(seen.length));
    const fin = seen[2];
    check('fallback: final is isFinal=true, 0 bytes, seq after the last part (2)',
      !!fin && fin.isFinal && fin.len === 0 && fin.seq === 2, JSON.stringify(fin));
    await sink.close('google_meet/m4');   // idempotent
    check('fallback: fires at most once (second close is a no-op)',
      seen.filter((s) => s.isFinal).length === 1, String(seen.filter((s) => s.isFinal).length));
  }

  // ── 5) close() AFTER a real final → no extra fallback (no double final) ──────────────────────
  {
    const { seen, upload } = fakeUploader();
    const sink = createBotRecordingSink({ inv: inv(), uploadChunk: upload });
    sink.chunk('google_meet/m5', 0, false, 'webm', new Uint8Array([1]));
    sink.chunk('google_meet/m5', 1, true, 'webm', new Uint8Array(0));
    await sink.close('google_meet/m5');
    check('no-double-final: a real final was sent → close adds nothing',
      seen.filter((s) => s.isFinal).length === 1 && seen.length === 2, JSON.stringify(seen));
  }

  // ── close waits for an in-flight final and retries its completion signal ────────────────────────
  {
    let firstFinalStartedResolve!: () => void;
    const firstFinalStarted = new Promise<void>((resolve) => { firstFinalStartedResolve = resolve; });
    let fallbackStartedResolve!: () => void;
    const fallbackStarted = new Promise<void>((resolve) => { fallbackStartedResolve = resolve; });
    let releaseFallback: (() => void) | undefined;
    let finalAttempts = 0;
    const upload: ChunkUploader = (seq, isFinal, format, bytes) => {
      if (!isFinal) return;
      finalAttempts++;
      if (finalAttempts === 1) {
        firstFinalStartedResolve();
        return Promise.reject(new Error('temporary final upload failure'));
      }
      fallbackStartedResolve();
      return new Promise<void>((resolve) => { releaseFallback = resolve; });
    };
    const sink = createBotRecordingSink({ inv: inv(), uploadChunk: upload });
    sink.chunk('google_meet/m5-close-race', 0, true, 'webm', new Uint8Array(0));
    const closeResult = Promise.resolve(sink.close('google_meet/m5-close-race')).then(() => 'closed', () => 'failed');
    await firstFinalStarted;

    const outcome = await Promise.race([
      fallbackStarted.then(() => 'fallback'),
      closeResult,
    ]);
    check('close: a failed final is followed by an awaited completion fallback',
      outcome === 'fallback' && finalAttempts === 2, `outcome=${outcome}, attempts=${finalAttempts}`);

    releaseFallback?.();
    const finalResult = await closeResult;
    check('close: resolves after fallback and reports the failed original chunk',
      finalResult === 'failed' && finalAttempts === 2, `result=${finalResult}, attempts=${finalAttempts}`);
  }

  // ── 6) close() on a never-fed session is a no-op (no phantom recording) ──────────────────────
  {
    const { seen, upload } = fakeUploader();
    const sink = createBotRecordingSink({ inv: inv(), uploadChunk: upload });
    await sink.close('google_meet/never');
    check('empty session: close is a no-op (no upload)', seen.length === 0, String(seen.length));
  }

  // ── 7) the DEFAULT uploader on the real RecordingService HTTP wire: session_uid == connectionId ──
  {
    interface Wire { audio_start_ms?: number; session_uid?: string; chunk_seq?: number; is_final?: boolean; format?: string; size?: number }
    const wire: Wire[] = [];
    const server = http.createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (d: Buffer) => parts.push(d));
      req.on('end', () => {
        const text = Buffer.concat(parts).toString('latin1');
        const m = text.match(/name="metadata"[\s\S]*?\r\n\r\n(\{[\s\S]*?\})\r\n/);
        let meta: Record<string, unknown> = {};
        if (m) { try { meta = JSON.parse(m[1]); } catch { /* ignore */ } }
        wire.push({
          audio_start_ms: meta.audio_start_ms as number, session_uid: meta.session_uid as string, chunk_seq: meta.chunk_seq as number,
          is_final: meta.is_final as boolean, format: meta.format as string,
          size: meta.file_size_bytes as number,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/recordings/upload`;

    const sink = createBotRecordingSink({
      inv: inv({ connectionId: 'conn-xyz', meeting_id: 42, recordingUploadUrl: url, internalSecret: 's' }),
    });
    sink.started?.(1792522376000);
    sink.chunk('google_meet/w', 0, false, 'webm', new Uint8Array([1, 2, 3, 4]));
    sink.chunk('google_meet/w', 1, false, 'webm', new Uint8Array([5, 6]));
    sink.chunk('google_meet/w', 2, true, 'webm', new Uint8Array(0));
    await sink.close('google_meet/w');
    await new Promise<void>((r) => server.close(() => r()));

    check('wire: 3 chunks POSTed to meeting-api', wire.length === 3, String(wire.length));
    check('wire: session_uid == inv.connectionId on EVERY chunk (never nativeMeetingId/master key)',
      wire.length === 3 && wire.every((w) => w.session_uid === 'conn-xyz'),
      JSON.stringify(wire.map((w) => w.session_uid)));
    check('wire: capture epoch survives every upload', wire.every(w => w.audio_start_ms === 1792522376000));
    check('wire: seq order 0,1,2', wire.map((w) => w.chunk_seq).join(',') === '0,1,2', wire.map((w) => w.chunk_seq).join(','));
    check('wire: only the LAST chunk is_final', wire.map((w) => w.is_final).join(',') === 'false,false,true',
      wire.map((w) => w.is_final).join(','));
  }

  if (failed) { console.error(`\n❌ recording (L3): ${failed} check(s) FAILED.`); process.exit(1); }
  console.log('\n✅ recording (L3): each recording.v1 timeslice uploads immediately (seq-ordered, session_uid==connectionId); a mid-meeting kill leaves every finished part durable; the empty is_final signal is forwarded; close() synthesizes the final signal at most once (injected uploader + real RecordingService HTTP wire · no whole-recording buffering).');
}

void main();
