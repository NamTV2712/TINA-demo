// Public benchmark WAVs → an isolated real Desktop pipeline; never open a microphone or a meeting.
import assert from 'node:assert/strict';
import { readFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startDesktop } from '../../../core/meetings/services/desktop/dist/desktop.js';
import { encodeAudioFrame } from '../../../core/meetings/modules/capture-codec/dist/index.js';

const require = createRequire(new URL('../../../core/meetings/services/desktop/package.json', import.meta.url));
const { WebSocket } = require('ws');
const [manifestPath, endpoint, output, mode] = process.argv.slice(2);
assert(manifestPath && /^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint) && output,
  'Usage: node replay.mjs MANIFEST http://127.0.0.1:PORT OUTPUT.jsonl [--controls|--refinement]');
assert(mode === undefined || ['--controls', '--refinement'].includes(mode), 'Only --controls or --refinement is supported');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const chosen = mode === '--refinement' ? manifest.samples.filter(s => s.role !== 'warmup')
  : ['vi_vn', 'en_us'].flatMap(config => manifest.samples.filter(s => s.role === 'test' && s.config === config).slice(0, 5));
if (mode === '--controls') chosen.push(...manifest.samples.filter(s => s.role === 'silence' || s.role === 'control'));

function readPcm(path) {
  const wav = readFileSync(path);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  let pcm, format, bits;
  for (let off = 12; off + 8 <= wav.length;) {
    const kind = wav.toString('ascii', off, off + 4), length = wav.readUInt32LE(off + 4), start = off + 8;
    assert(start + length <= wav.length, 'Truncated WAV');
    if (kind === 'fmt ') {
      format = wav.readUInt16LE(start);
      assert.equal(wav.readUInt16LE(start + 2), 1);
      assert.equal(wav.readUInt32LE(start + 4), 16000);
      bits = wav.readUInt16LE(start + 14);
      assert((format === 1 && bits === 16) || (format === 3 && bits === 32), 'Replay requires PCM16 or float32 WAV');
    }
    if (kind === 'data') pcm = format === 3
      ? Float32Array.from({ length: length / 4 }, (_, i) => wav.readFloatLE(start + i * 4))
      : Float32Array.from({ length: length / 2 }, (_, i) => wav.readInt16LE(start + i * 2) / 32768);
    off = start + length + (length % 2);
  }
  assert(format && pcm?.length);
  return pcm;
}

for (const sample of chosen) {
  const directory = mkdtempSync(join(tmpdir(), 'tina-fleurs-replay-'));
  let desktop, capture, observer;
  const row = { id: sample.id, config: sample.config, role: sample.role, reference: sample.reference, duration_s: sample.duration_s, ok: false };
  if (mode === '--refinement') Object.assign(row, { dataset: sample.dataset, group: sample.group, cluster: sample.cluster });
  try {
    const pcm = readPcm(sample.path);
    if (mode === '--refinement') {
      while ((await (await fetch('http://127.0.0.1:8056/health')).json()).live_sessions > 0) {
        console.log(JSON.stringify({ phase: 'waiting-for-user-capture', id: sample.id })); await delay(5000);
      }
    }
    desktop = await startDesktop({ gatewayPort: 0, ingestPort: 0, txUrl: endpoint, txToken: '', txModel: 'custom', quiet: true, recordingsDir: directory });
    const native = sample.id, key = `desktop/${native}`;
    observer = new WebSocket(`ws://127.0.0.1:${desktop.gatewayPort}/ws`);
    await once(observer, 'open');
    let started, firstText = null;
    observer.on('message', data => {
      const m = JSON.parse(data.toString());
      if (m.type === 'health') row.pipeline_error = `${m.source}:${m.kind}`;
      if (m.type === 'transcript' && m.meeting === key && firstText === null &&
          [...(m.confirmed || []), ...(m.pending || [])].some(s => s.text?.trim())) firstText = performance.now();
    });
    capture = new WebSocket(`ws://127.0.0.1:${desktop.ingestPort}/ingest?platform=desktop&native_meeting_id=${encodeURIComponent(native)}`);
    const ready = once(capture, 'message');
    await once(capture, 'open');
    assert.equal(JSON.parse((await ready)[0].toString()).type, 'ready');
    if (mode === '--refinement') console.log(JSON.stringify({ phase: 'live-start', id: sample.id }));
    started = performance.now();
    const epoch = Date.now();
    for (let offset = 0; offset < pcm.length; offset += 1600) {
      await delay(Math.max(0, started + offset / 16 - performance.now()));
      row.max_send_lag_ms = Math.max(row.max_send_lag_ms || 0, performance.now() - started - offset / 16);
      capture.send(Buffer.from(encodeAudioFrame(0, epoch + offset / 16, pcm.subarray(offset, offset + 1600), 'FLEURS')));
    }
    await delay(Math.max(0, started + pcm.length / 16 - performance.now()));
    const audioEnded = performance.now();
    capture.close();
    let transcript;
    const deadline = performance.now() + 120000;
    while (performance.now() < deadline) {
      const r = await fetch(`http://127.0.0.1:${desktop.gatewayPort}/transcripts/desktop/${encodeURIComponent(native)}`);
      assert(r.ok);
      transcript = await r.json();
      if (transcript.status === 'completed') break;
      await delay(50);
    }
    assert.equal(transcript?.status, 'completed', 'Finalization exceeded 120s');
    row.ok = !row.pipeline_error;
    row.text = (transcript.segments || []).map(s => s.text).join(' ');
    row.segments = (transcript.segments || []).map(s => ({ start: s.start, end: s.end, text: s.text }));
    row.first_text_s = firstText === null ? null : (firstText - started) / 1000;
    row.finalization_delay_s = (performance.now() - audioEnded) / 1000;
    row.latency_s = (performance.now() - started) / 1000;
    if (mode === '--refinement') {
      console.log(JSON.stringify({ phase: 'live-end', id: sample.id }));
      row.external_capture_after_live = (await (await fetch('http://127.0.0.1:8056/health')).json()).live_sessions > 0;
      const base = `http://127.0.0.1:${desktop.gatewayPort}/transcripts/desktop/${encodeURIComponent(native)}`;
      const doc = await (await fetch(base + '/document')).json();
      row.refinement = { status: 'not_applicable', items: [] }; row.refinement_s = 0;
      row.refined_text = row.text;
      if (doc.segments.length) {
        console.log(JSON.stringify({ phase: 'refinement-start', id: sample.id }));
        const refining = performance.now();
        try {
          const response = await fetch(base + '/refinement/start', { method: 'POST' });
          assert.equal(response.status, 202, 'Refinement admission failed');
          let job = await response.json();
          const limit = performance.now() + Math.max(120000, doc.segments.length * 35000);
          while (['running', 'paused', 'cancelling'].includes(job.status) && performance.now() < limit) {
            await delay(50); job = await (await fetch(base + '/refinement')).json();
          }
          assert(!['running', 'paused', 'cancelling'].includes(job.status), 'Refinement exceeded deadline');
          row.refinement = job;
          const candidates = new Map(job.items.filter(s => s.state === 'ready').map(s => [s.segment_id, s.text]));
          // Hypothetical accept-all-ready proposal; missing/failed suggestions retain live text.
          row.refined_text = doc.segments.map(s => candidates.get(s.segment_id) ?? s.text).join(' ');
          const after = await (await fetch(base + '/document')).json();
          assert.deepEqual(after.segments, doc.segments, 'Benchmark must not apply suggestions');
        } catch (error) { row.refinement_error = String(error.message || error); }
        row.refinement_s = (performance.now() - refining) / 1000;
        console.log(JSON.stringify({ phase: 'refinement-end', id: sample.id }));
      }
      row.refinement_ok = !row.refinement_error && !row.refinement.items.some(s => s.state === 'failed');
    }
  } catch (error) {
    row.error = String(error.message || error);
    row.text = '';
    row.latency_s = row.latency_s ?? 0;
  } finally {
    if (mode === '--refinement') console.log(JSON.stringify({ phase: 'sample-end', id: sample.id }));
    capture?.terminate(); observer?.terminate();
    await desktop?.close();
    rmSync(directory, { recursive: true, force: true });
  }
  appendFileSync(output, JSON.stringify(row) + '\n');
  console.log(JSON.stringify({ phase: 'replay', id: row.id, ok: row.ok, first_text_s: row.first_text_s, finalization_delay_s: row.finalization_delay_s }));
}
