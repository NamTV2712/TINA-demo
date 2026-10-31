/**
 * Background service worker — capture ownership, controls and ingest transport.
 *
 * Owns the single WebSocket to the desktop ingest (ws://localhost:9099/ingest).
 * Because it runs in the extension's own context with host permissions, its
 * WebSocket is NOT subject to Google Meet's page CSP. It receives per-speaker
 * PCM chunks from the content script, encodes each into a capture.v1 binary
 * frame (@tina/capture-codec encodeAudioFrame) and streams it to the desktop.
 *
 * Control flow: panel → START/STOP here → open/close WS and tell the meeting
 * tab's content script to begin/end capture.
 */

import { detectMeeting, isMixedHost, MeetingRef } from './meeting';
import { resolveEndpoints } from './endpoints';
import {SourceSampleClock} from './audio-clock.js';
import {PcmReplayBuffer} from './pcm-replay.js';
import { encodeAudioFrame, encodeEvent, encodeRecordingChunk, decodeRecordingChunk, AUDIO_ACK_MODE } from '@tina/capture-codec';
import { type CaptureStatus, isActive, onFrameObserved, noSignalCheck } from './capture-liveness';

interface SessionState {
  status: CaptureStatus;
  sessionId: string | null;
  startedAt: number | null;
  pendingAudioFrames: number;
  pendingAudioBytes: number;
  /** Capture suspended (audio/hints dropped) but the session stays alive —
   *  resume continues the SAME meeting. Stop ends it. */
  paused: boolean;
  tabId: number | null;
  meetingId: number | null;
  platform: string | null;
  nativeMeetingId: string | null;
  streams: number;
  error: string | null;
  transcription?: { backend: string; label: string; model: string; source: string };
  /** build-stamp.txt as read when THIS service worker loaded. The panel compares
   *  it to the on-disk stamp to detect a stale SW (reload deferred during capture). */
  swBuild: string;
  /** Newer build sitting on disk while reload is deferred (set by the stamp
   *  watcher). Lets the panel show "Reload now" even when the panel itself is
   *  equally stale (panelBuild == swBuild blind spot). */
  diskBuild: string;
}

const state: SessionState = {
  status: 'idle',
  sessionId: null,
  startedAt: null,
  pendingAudioFrames: 0,
  pendingAudioBytes: 0,
  paused: false,
  tabId: null,
  meetingId: null,
  platform: null,
  nativeMeetingId: null,
  streams: 0,
  error: null,
  swBuild: '',
  diskBuild: '',
};

// Endpoint resolution is deployment-aware (src/endpoints.ts): the chosen
// `deployment` preset (default 'desktop' → ws://localhost:9099/ingest +
// http://localhost:8056) unless explicit ingestUrl/gatewayUrl override it. ONE
// build thus serves desktop + lite + compose + helm. Every endpoint read below
// goes through resolveEndpoints(cfg) — there is no separate default constant.

let ws: WebSocket | null = null;
let stopping: Promise<void> | null = null;
let sessionConfig: Record<string, any> = {};
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retries = 0;
let sourcesStarted = false;
let recordingAcksSupported = false;
let ingestReady = false;
let recordingWritable = true;
let pcmAckSession: string | null = null;
const pcmReplay = new PcmReplayBuffer();
let finalRecordingSeq: number | null = null;
let finalRecordingAck: number | null = null;
let terminalError: string | null = null;
const recordingBacklog = new Map<number, ArrayBuffer>();
let recordingBacklogBytes = 0;
let tabStreamTabId: number | null = null;
const controlWaiters = new Map<string, { token: string; done: (value: any) => void }>();

async function pageControl(type: string, token: string): Promise<void> {
  if (state.tabId === null || state.platform === 'note' || state.platform === 'youtube') return;
  const requestId = crypto.randomUUID();
  const result = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { controlWaiters.delete(requestId); reject(new Error('Page capture control timed out')); }, 15000);
    controlWaiters.set(requestId, { token, done: value => { clearTimeout(timer); controlWaiters.delete(requestId); resolve(value); } });
    chrome.tabs.sendMessage(state.tabId!, { type, sessionId: token, requestId, paused: state.paused }).catch(error => {
      clearTimeout(timer); controlWaiters.delete(requestId); reject(error);
    });
  });
  if (!result?.ok) throw new Error(result?.error || 'Page capture control failed');
}
async function offscreenControl(type: string, token: string, extra: object = {}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: any;
  try {
    result = await Promise.race([
      chrome.runtime.sendMessage({ type, sessionId: token, paused: state.paused, ...extra }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Offscreen control timed out')), 15000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
  if (!result?.ok) throw new Error(result?.error || 'Offscreen capture control failed');
}
function captureFailure(message: string): void {
  terminalError = message;
  void stopCapture().finally(() => { if (!state.sessionId) { state.status = 'error'; state.error = message; broadcastStatus(); } });
}
function shipRecording(frame: ArrayBuffer): boolean {
  const chunk = decodeRecordingChunk(frame);
  if (!chunk) return false;
  if (chunk.isFinal) finalRecordingSeq = chunk.seq;
  const previous = recordingBacklog.get(chunk.seq);
  const bytes = recordingBacklogBytes - (previous?.byteLength ?? 0) + frame.byteLength;
  if (bytes > 10 * 1024 * 1024) { captureFailure('Recording acknowledgement buffer is full; capture stopped.'); return false; }
  recordingBacklog.set(chunk.seq, frame); recordingBacklogBytes = bytes;
  if (ws?.readyState === WebSocket.OPEN && ingestReady && recordingWritable) {
    if (ws.bufferedAmount > 10 * 1024 * 1024) { captureFailure('Recording send queue is full; capture stopped.'); return false; }
    ws.send(frame);
    if (!recordingAcksSupported) { recordingBacklog.delete(chunk.seq); recordingBacklogBytes -= frame.byteLength; }
  }
  return true;
}


/** tabCapture stream id, minted on the toolbar-click gesture (that click is the
 *  only event that grants activeTab, which getMediaStreamId requires). Used for
 *  MIXED-lane tabs (YouTube + Zoom + Teams) where the offscreen mixed captor is
 *  the audio source. */
let tabStreamId: string | null = null;

/** MIXED-lane platforms: the whole tab's audio is one mixed stream the desktop
 *  diarizes (channel 999, via the offscreen tabCapture), as opposed to Google
 *  Meet's per-participant in-page <audio> capture. Zoom and Teams additionally
 *  feed speaker-name hints from their inpage zoom-/msteams-speakers DOM. */
const MIXED = new Set(['youtube', 'zoom', 'teams']);
const isMixed = (p: string | null | undefined): boolean => !!p && MIXED.has(p);

// ── P21 capture liveness: state is EARNED by observed frames, not the Start command.
const NO_SIGNAL_MS = 6000;
let startedAt = 0;     // when the WS went 'ready' (warm-up grace baseline)
let lastFrameAt = 0;   // last audio frame actually observed (0 = none yet this session)
let framesSeen = 0;    // audio frames observed this session

/** Per-tab meeting ref captured from a JOIN URL the tab navigated through. Teams'
 *  new web app (teams.cloud.microsoft) and Zoom's web client STRIP the meeting id
 *  from the URL once you're in — only the join link (/meet/<id>, /j/<id>) carries
 *  it. We remember it per tab and reuse it when the in-meeting URL no longer has it. */
const tabMeeting = new Map<number, MeetingRef>();
const rememberMeeting = (tabId: number, url?: string): void => {
  const m = url ? detectMeeting(url) : null;
  if (m && tabId != null) tabMeeting.set(tabId, m);
};
const meetingForTab = (tabId: number | null | undefined, url?: string): MeetingRef | null =>
  (url ? detectMeeting(url) : null) || (tabId != null ? tabMeeting.get(tabId) ?? null : null);

function broadcastStatus(): void {
  state.pendingAudioFrames = pcmReplay.size; state.pendingAudioBytes = pcmReplay.bytes;
  chrome.runtime.sendMessage({ type: 'STATUS', state }).catch(() => { /* panel may be closed */ });
}

/** Ensure the offscreen document exists. USER_MEDIA covers the voice-notepad mic
 *  AND the tabCapture getUserMedia; AUDIO_PLAYBACK covers re-playing the captured
 *  tab audio to the speakers (tab capture otherwise mutes the tab). */
async function ensureOffscreen(): Promise<void> {
  const has = await (chrome.offscreen as any).hasDocument?.().catch(() => false);
  if (has) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: 'Microphone and meeting/media audio capture and re-play',
  }).catch((e) => { if (!String(e).includes('single offscreen')) throw e; });
}

/** Start the mixed tab-audio capture (offscreen) for the current media session. */
async function startTabAudio(token = state.sessionId): Promise<void> {
  if (!token || token !== state.sessionId || stopping) return;
  if (!tabStreamId || tabStreamTabId !== state.tabId) throw new Error('Click the TINA toolbar icon on the captured tab to enable tab audio.');
  await ensureOffscreen();
  if (token !== state.sessionId || stopping) return;
  await offscreenControl('TAB_CAPTURE_START', token, { streamId: tabStreamId, includeMic: state.platform === 'zoom' || state.platform === 'teams' });
}

async function startCaptureForTab(tabId: number, url: string, meetingRef?: MeetingRef): Promise<void> {
  await orphanCleanup;
  await stopping;
  const cfg = await chrome.storage.local.get(['apiKey', 'deployment', 'ingestUrl', 'gatewayUrl', 'language', 'transcriptSource']);
  if (cfg.transcriptSource === 'bot') return;
  if (isActive(state.status)) return;
  if (pcmReplay.size) { state.error = 'Queued audio is not delivered yet. Retry audio delivery before starting another capture.'; broadcastStatus(); return; }
  const meeting = meetingRef || meetingForTab(tabId, url)
    || { platform: 'note', nativeMeetingId: `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` };
  const token = crypto.randomUUID();
  state.sessionId = token; state.startedAt = null;
  state.status = 'connecting'; state.paused = false; state.tabId = tabId;
  state.platform = meeting.platform; state.nativeMeetingId = meeting.nativeMeetingId;
  state.error = null; state.transcription = undefined;
  sourcesStarted = false; terminalError = null; retries = 0;
  finalRecordingSeq = null; finalRecordingAck = null; recordingAcksSupported = false; recordingWritable = true;
  broadcastStatus();
  if (token !== state.sessionId || stopping) return;
  sessionConfig = cfg;
  connectIngest(token);
}
function connectIngest(token: string, draining = false): void {
  if (token !== state.sessionId || (stopping && !draining)) return;
  ingestReady = false; pcmAckSession = null;
  if (!stopping) state.status = 'connecting'; broadcastStatus();
  const endpoints = resolveEndpoints(sessionConfig);
  let endpoint: URL;
  try { endpoint = new URL(endpoints.ingestUrl); if (!['ws:', 'wss:'].includes(endpoint.protocol)) throw new Error(); }
  catch { captureFailure('Invalid capture server URL'); return; }
  const apiKey = sessionConfig.apiKey || '';
  for (const [name, value] of Object.entries({ platform: state.platform!, native_meeting_id: state.nativeMeetingId!, language: sessionConfig.language || 'auto', client_session: token, audio_ack: AUDIO_ACK_MODE })) endpoint.searchParams.set(name, value);
  let protocols: string[] | undefined;
  if (endpoints.deployment === 'desktop') {
    endpoint.searchParams.delete('api_key');
    if (apiKey) {
      let binaryKey = '';
      for (const byte of new TextEncoder().encode(apiKey)) binaryKey += String.fromCharCode(byte);
      const encodedKey = btoa(binaryKey).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      protocols = ['tina-extension.v1', `tina-api-key.${encodedKey}`];
    }
  } else {
    endpoint.searchParams.set('api_key', apiKey);
  }
  let socket: WebSocket;
  try { socket = protocols ? new WebSocket(endpoint.toString(), protocols) : new WebSocket(endpoint.toString()); }
  catch { captureFailure('Invalid capture server URL'); return; }
  ws = socket; socket.binaryType = 'arraybuffer';
  const current = () => ws === socket && state.sessionId === token && (!stopping || draining);
  const handshake = setTimeout(() => { if (current()) socket.close(); }, 8000);
  socket.onmessage = ev => {
    if (ws !== socket || state.sessionId !== token) return;
    try {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      if (msg.type === 'audio-ack') {
        if (msg.capture_session === pcmAckSession) pcmReplay.acknowledge(msg.source, msg.start_sample, msg.end_sample);
        flushAudio(); return;
      }
      if (msg.type === 'recording-ack') {
        const frame = recordingBacklog.get(msg.seq);
        if (frame) { recordingBacklog.delete(msg.seq); recordingBacklogBytes -= frame.byteLength; }
        if (msg.isFinal) finalRecordingAck = msg.seq;
        return;
      }
      if (stopping && msg.type !== 'ready' && msg.type !== 'error') return;
      if (msg.type === 'ready') {
        clearTimeout(handshake);
        if (msg.audio_ack !== AUDIO_ACK_MODE || typeof msg.capture_session !== 'string') { captureFailure('Desktop must be updated to acknowledge queued PCM safely.'); return; }
        ingestReady = true; pcmAckSession = msg.capture_session;
        pcmReplay.replay(); flushAudio();
        recordingWritable = !sourcesStarted || msg.recording_resume === true;
        if (!recordingWritable) { captureFailure('Desktop cannot resume the recording. Buffered PCM will be saved before capture stops.'); return; }
        recordingAcksSupported = msg.recording_ack === true;
        timelineSupported = msg.audio_timeline === 'sample-index.v1';
        state.meetingId = msg.meeting_id; state.transcription = msg.transcription;
        if (!stopping) state.status = 'starting'; state.startedAt ??= Date.now();
        startedAt = Date.now(); lastFrameAt = 0; framesSeen = 0;
        retries = 0; state.error = null;
        for (const frame of recordingBacklog.values()) socket.send(frame);
        broadcastStatus(); shipTelemetry('session-ready');
        if (stopping) return;
        if (!sourcesStarted) {
          sourcesStarted = true;
          void (async () => {
            if (state.platform === 'note') { await ensureOffscreen(); if (current()) await offscreenControl('NOTE_CAPTURE_START', token); }
            else if (isMixed(state.platform)) {
              await startTabAudio(token);
              if (current()) await pageControl('BEGIN_CAPTURE', token);
            } else await pageControl('BEGIN_CAPTURE', token);
          })().catch(error => { if (current()) captureFailure(String(error?.message || error)); });
        }
      } else if (msg.type === 'error') captureFailure(msg.message || 'Capture server error');
      else if (msg.type === 'superseded' || msg.type === 'ended') void stopCapture(false);
    } catch { /* Ignore malformed server frames. */ }
  };
  socket.onerror = () => { if (current()) { state.error = 'Capture connection interrupted'; broadcastStatus(); } };
  socket.onclose = () => {
    clearTimeout(handshake);
    if (!current()) return;
    ws = null; ingestReady = false; pcmAckSession = null;
    if (stopping) return;
    if (++retries > 4) { captureFailure('Capture server unreachable; source capture stopped. Retry queued audio delivery after reconnecting.'); return; }
    state.status = 'connecting'; state.error = 'Reconnecting capture; retaining audio for delivery.'; broadcastStatus();
    retryTimer = setTimeout(() => { retryTimer = null; connectIngest(token); }, Math.min(1000 * 2 ** (retries - 1), 8000));
  };
}

/** Manual start from the panel — targets the active tab. */
async function startCaptureActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url) {
    state.status = 'error'; state.error = 'No active tab'; broadcastStatus(); return;
  }
  return startCaptureForTab(tab.id, tab.url);
}

/** Auto-start when a meeting tab reports it's in a meeting (if enabled + configured). */
async function maybeAutoStart(tabId?: number, url?: string, meetingRef?: MeetingRef): Promise<void> {
  if (!tabId || !url) return;
  if (isActive(state.status)) return;
  const cfg = await chrome.storage.local.get(['autoStart', 'apiKey', 'transcriptSource']);
  if (cfg.transcriptSource === 'bot') return;
  if (cfg.autoStart === false) return;          // default ON
  if (!cfg.apiKey) return;                       // need an API key configured first
  if (!meetingRef && !meetingForTab(tabId, url)) return;
  startCaptureForTab(tabId, url, meetingRef);
}

async function stopCapture(finalize = true): Promise<void> {
  if (stopping) return stopping;
  const token = state.sessionId;
  if (!token) { state.status = 'idle'; broadcastStatus(); return; }
  const ended = { platform: state.platform, native_meeting_id: state.nativeMeetingId };
  state.status = 'stopping'; broadcastStatus();
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  stopping = (async () => {
    let fault = terminalError;
    try {
      const actions = sourcesStarted ? [pageControl('END_CAPTURE', token)] : [];
      if (sourcesStarted && (state.platform === 'note' || isMixed(state.platform))) actions.push(offscreenControl('CAPTURE_STOP', token));
      const results = await Promise.allSettled(actions);
      for (const result of results) if (result.status === 'rejected') fault ||= String(result.reason?.message || result.reason);
      if ((pcmReplay.size || recordingBacklog.size) && (!ws || ws.readyState !== WebSocket.OPEN)) connectIngest(token, true);
      const deliveryDeadline = Date.now() + 5000;
      while ((pcmReplay.size || recordingBacklog.size) && Date.now() < deliveryDeadline) { flushAudio(); await new Promise(r => setTimeout(r, 20)); }
      if (pcmReplay.size) fault ||= `Audio delivery incomplete: ${pcmReplay.size} frame(s) retained. Use Retry audio delivery.`;
      fault ||= terminalError;
      const deadline = Date.now() + 5000;
      while (ws?.readyState === WebSocket.OPEN && ws.bufferedAmount > 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
      if (ws?.bufferedAmount) fault ||= 'Recording transport did not drain before stop.';
      if (recordingAcksSupported && recordingWritable && finalRecordingSeq !== null) {
        const ackDeadline = Date.now() + 5000;
        while (finalRecordingAck !== finalRecordingSeq && ws?.readyState === WebSocket.OPEN && Date.now() < ackDeadline) await new Promise(r => setTimeout(r, 20));
        if (finalRecordingAck !== finalRecordingSeq) fault ||= 'Recording final chunk was not acknowledged.';
      }
      if (recordingBacklog.size) fault ||= 'Connection lost before all recording chunks could be delivered.';
      if (finalize && state.meetingId && !pcmReplay.size) {
        const gateway = resolveEndpoints(sessionConfig).gatewayUrl.replace(/\/+$/, '');
        const response = await fetch(`${gateway}/extension/sessions/end`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': sessionConfig.apiKey || '' }, body: JSON.stringify(ended), signal: AbortSignal.timeout(5000) });
        if (!response.ok) fault ||= `Capture finalization failed (${response.status})`;
      }
    } catch (error: any) { fault ||= String(error?.message || error); }
    finally {
      const socket = ws; ws = null; state.sessionId = pcmReplay.size ? token : null;
      ingestReady = false; pcmAckSession = null;
      try { socket?.close(); } catch { /* Already disconnected. */ }
      tabStreamId = null; tabStreamTabId = null;
      state.status = fault ? 'error' : 'idle'; state.error = fault;
      state.paused = false; state.meetingId = null; state.streams = 0;
      startedAt = 0; lastFrameAt = 0; framesSeen = 0;
      sourceClock.reset(); trackFrames.clear(); timelineSupported = false;
      recordingBacklog.clear(); recordingBacklogBytes = 0; sourcesStarted = false;
      finalRecordingSeq = null; finalRecordingAck = null; recordingAcksSupported = false;
      lastSpeakerMap = {}; for (const key of Object.keys(pageDiags)) delete pageDiags[key];
      broadcastStatus();
    }
  })();
  try { await stopping; } finally { stopping = null; }
}
async function setPaused(paused: boolean): Promise<void> {
  const token = state.sessionId;
  if (!token || stopping || !sourcesStarted) return;
  if (paused) state.paused = true;
  try {
    const operations = [pageControl(paused ? 'CAPTURE_PAUSE' : 'CAPTURE_RESUME', token)];
    if (state.platform === 'note' || isMixed(state.platform)) operations.push(offscreenControl(paused ? 'CAPTURE_PAUSE' : 'CAPTURE_RESUME', token));
    await Promise.all(operations);
    if (token === state.sessionId) { state.paused = paused; startedAt = Date.now(); lastFrameAt = 0; broadcastStatus(); }
  } catch (error: any) { captureFailure(String(error?.message || error)); }
}
let pauseControl: Promise<void> = Promise.resolve();

// Pack and forward one per-speaker PCM chunk.
const sourceClock=new SourceSampleClock();
const trackFrames = new Map<number, { frames: number; lastAt: number }>();
function flushAudio(): void {
  const socket = ws;
  if (!socket || socket.readyState !== WebSocket.OPEN || !ingestReady || !pcmAckSession) return;
  try { pcmReplay.flush(frame => socket.send(frame), () => socket.bufferedAmount < 512 * 1024); }
  catch { socket.close(); } // Retain unsent bytes for the next handshake.
}
setInterval(flushAudio, 50);
let timelineSupported=false;
function sendAudio(index:number,pcm:number[],speakerName?:string,captureMs?:number,startSample?:number):void {
  if (state.paused || stopping || !isActive(state.status)) return;
  if (!Number.isSafeInteger(index) || index < 0 || index >= 0x40000000 || !Array.isArray(pcm) || !pcm.length || pcm.length > 16000 * 30
      || pcm.some(v => !Number.isFinite(v)) || !Number.isFinite(captureMs) || !Number.isSafeInteger(startSample) || startSample! < 0) {
    captureFailure('Audio source has no valid sample clock. Refresh the meeting tab before restarting.'); return;
  }
  try {
    const start = sourceClock.map(index, captureMs!, startSample!, pcm.length);
    if (start === null) throw new Error('Audio source limit or stale capture clock');
    const frame = encodeAudioFrame(index, captureMs!, Float32Array.from(pcm), speakerName, start);
    if (!pcmReplay.enqueue({ source: index, startSample: start, endSample: start + pcm.length, wire: frame })) return;
    lastFrameAt = Date.now(); framesSeen++;
    const t = trackFrames.get(index) || { frames: 0, lastAt: 0 }; t.frames++; t.lastAt = Date.now(); trackFrames.set(index, t);
    const promoted = ingestReady ? onFrameObserved(state.status) : state.status;
    if (promoted !== state.status) { state.status = promoted; state.error = null; broadcastStatus(); }
    flushAudio();
  } catch (error: any) { captureFailure(String(error?.message || error)); }
}

// Relay one recording.v1 chunk (offscreen tee) over the ingest WS. The frame is
// ALREADY a capture-codec REC1 frame (encoded offscreen) — relay it as bytes; the
// desktop's decodeRecordingChunk discriminates it from an audio frame. Same WS,
// same paused/open guards as audio.
function sendRecordingFrame(frame: number[]): boolean {
  if (!Array.isArray(frame) || frame.length > 10 * 1024 * 1024 || frame.some(v => !Number.isInteger(v) || v < 0 || v > 255)) return false;
  return shipRecording(Uint8Array.from(frame).buffer);
}

// Forward one RECORDING chunk (recording.v1) from the GMEET inpage tee over the
// same WS. The inpage's @tina/record-chunker emits base64 WebM/WAV (raw, NOT yet
// a REC1 frame — unlike the offscreen tee, which pre-encodes); we decode + frame
// it for the desktop's recording.v1 consumer (master.<fmt> on the final chunk).
// Gated by `paused` like audio. (The mixed-lane offscreen tee uses RECORDING_CHUNK
// → sendRecordingFrame above, which relays an already-encoded frame verbatim.)
function sendRecordingChunk(seq: number, isFinal: boolean, mimeType: string, base64: string): boolean {
  if (!Number.isSafeInteger(seq) || seq < 0 || typeof base64 !== 'string' || base64.length > 14 * 1024 * 1024) return false;
  const fmt = (mimeType || '').toLowerCase().includes('wav') ? 'wav' : 'webm';
  const bin = atob(base64 || '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return shipRecording(encodeRecordingChunk(seq, isFinal, fmt, bytes));
}

// ── Telemetry: merged extension state → ingest server /telemetry ──────────
// Page diag (attribution/captured-element state) + session state + per-track
// frame counters, POSTed every 10s while a session is live (plus on status
// changes). Server keeps a ring buffer readable via GET /telemetry — debugging
// needs no client-side copy-paste. Transcript text never enters telemetry (page
// diag scrubs DOM free-text to random words on exit).
const pageDiags: Record<string, any> = {};
let lastSpeakerMap: Record<string, string> = {};
async function shipTelemetry(reason: string): Promise<void> {
  try {
    const cfg = await chrome.storage.local.get(['deployment', 'ingestUrl']);
    const ingest: string = resolveEndpoints(cfg).ingestUrl;
    const url = ingest.replace(/^ws/, 'http').replace(/\/ingest.*$/, '/telemetry');
    const frames: Record<string, any> = {};
    for (const [idx, t] of trackFrames) frames[idx] = { frames: t.frames, msSinceAudio: Date.now() - t.lastAt };
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reason,
        state: { ...state },
        speakerMap: lastSpeakerMap,
        trackFrames: frames,
        wsOpen: !!ws && ws.readyState === WebSocket.OPEN,
        page: Object.values(pageDiags).find((d: any) => d?.top) || null,
        frames: pageDiags,
      }),
    });
  } catch { /* telemetry must never break capture */ }
}
setInterval(() => {
  if (isActive(state.status) || state.status === 'error') shipTelemetry('interval');
}, 10000);

// P21 no-frames watchdog: a started/active capture with no observed frame for
// NO_SIGNAL_MS flips to 'no-signal' with an actionable cause (P18 liveness, client-side) —
// the "Listening — capturing 0 stream(s)" case becomes a visible, self-diagnosing state.
setInterval(() => {
  const r = noSignalCheck({
    status: state.status, paused: state.paused, frames: framesSeen,
    lastFrameAt, startedAt, now: Date.now(), noSignalMs: NO_SIGNAL_MS, mixed: isMixed(state.platform),
  });
  if (r && r.status !== state.status) { state.status = r.status; state.error = r.error; broadcastStatus(); shipTelemetry('no-signal'); }
}, 2000);

const mediaMessages = new Set(['audio', 'RECORDING_CHUNK', 'recording-chunk', 'speakers', 'diag', 'dom_probe', 'speaker_activity', 'chat-message', 'capture-started', 'capture-stopped', 'capture-control-result']);
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fromPage = sender.tab?.id === state.tabId && state.tabId !== null;
  const fromOffscreen = !sender.tab && sender.url === chrome.runtime.getURL('offscreen.html');
  if (mediaMessages.has(msg.type)) {
    if (!state.sessionId || msg.sessionId !== state.sessionId || (!fromPage && !fromOffscreen)) { sendResponse({ ok: false }); return; }
    if (msg.type === 'capture-control-result') {
      if (fromPage && sender.frameId === 0) {
        const waiter = controlWaiters.get(msg.requestId);
        if (waiter && waiter.token === msg.sessionId) waiter.done(msg);
        else if (msg.ok === false && !stopping) captureFailure(msg.error || 'Page capture failed');
      }
      sendResponse({ ok: true }); return;
    }
    if ((state.paused || stopping) && !['RECORDING_CHUNK', 'recording-chunk', 'capture-stopped'].includes(msg.type)) { sendResponse({ ok: false }); return; }
    try {
      switch (msg.type) {
        case 'audio': sendAudio(msg.index, msg.pcm, msg.speakerName, msg.captureMs, msg.startSample); break;
        case 'RECORDING_CHUNK': sendResponse({ ok: fromOffscreen && sendRecordingFrame(msg.frame) }); return;
        case 'recording-chunk': sendResponse({ ok: fromPage && sendRecordingChunk(msg.seq, msg.isFinal, msg.mimeType, msg.base64) }); return;
        case 'speakers':
          Object.assign(lastSpeakerMap, msg.speakers || {});
          if (ws?.readyState === WebSocket.OPEN) for (const [index, name] of Object.entries(msg.speakers || {})) if (name) ws.send(encodeEvent({ kind: 'speaker-joined', ts: Date.now(), speaker: String(name), detail: { index: Number(index) } }));
          break;
        case 'diag': if (msg.diag) pageDiags[`${sender.frameId ?? 'offscreen'}`] = msg.diag; break;
        case 'dom_probe': if (msg.probe && ws?.readyState === WebSocket.OPEN) ws.send(encodeEvent({ kind: 'dom-probe', ts: Date.now(), speaker: '', detail: { probe: msg.probe } } as any)); break;
        case 'speaker_activity': if (ws?.readyState === WebSocket.OPEN) ws.send(encodeEvent({ kind: 'active-speaker', ts: Date.now(), speaker: msg.name || '', detail: { hint: msg.kind || 'dom-active', isEnd: !!msg.isEnd } })); break;
        case 'chat-message': if (ws?.readyState === WebSocket.OPEN && (msg.text || msg.sender)) ws.send(encodeEvent({ kind: 'chat', ts: Date.now(), speaker: String(msg.sender || ''), text: String(msg.text || ''), detail: { source: 'meeting-chat' } })); break;
        case 'capture-started': state.streams = msg.streams || 0; broadcastStatus(); break;
      }
      sendResponse({ ok: true });
    } catch { sendResponse({ ok: false }); }
    return;
  }
  // Content pages may report their own meeting identity, never drive session controls.
  if (msg.type === 'MEETING_HINT' && sender.tab?.id != null) {
    const detected = sender.tab.url ? isMixedHost(sender.tab.url) : false;
    if (detected && ['teams', 'zoom'].includes(msg.meeting?.platform) && typeof msg.meeting?.nativeMeetingId === 'string') tabMeeting.set(sender.tab.id, msg.meeting);
    sendResponse({ ok: true }); return;
  }
  if (msg.type === 'AUTO_START' && sender.tab?.id != null) {
    void maybeAutoStart(sender.tab.id, sender.tab.url, tabMeeting.get(sender.tab.id)); sendResponse({ ok: true }); return;
  }
  if (sender.tab || fromOffscreen || sender.url !== chrome.runtime.getURL('sidepanel.html')) return;
  const respond = (operation: Promise<unknown>) => operation.then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  switch (msg.type) {
    case 'START': respond(startCaptureActiveTab()); return true;
    case 'RETRY_AUDIO': {
      if (isActive(state.status)) { sendResponse({ok:false,error:'Capture is still active'}); return; }
      terminalError = null; respond(stopCapture()); return true;
    }
    case 'STOP': respond(stopCapture()); return true;
    case 'PAUSE':
    case 'RESUME': {
      const token = state.sessionId;
      pauseControl = pauseControl.then(() => token === state.sessionId ? setPaused(msg.type === 'PAUSE') : undefined);
      respond(pauseControl); return true;
    }
    case 'RELOAD_NOW':
      if (msg.idleOnly && isActive(state.status)) { sendResponse({ok:false,error:'Capture is still active'}); return; }
      if (pcmReplay.size) { sendResponse({ok:false,error:'Deliver queued audio before reloading the extension.'}); return; }
      respond(stopCapture().then(() => { if (!pcmReplay.size) chrome.runtime.reload(); })); return true;
    case 'STATUS': state.pendingAudioFrames = pcmReplay.size; state.pendingAudioBytes = pcmReplay.bytes; sendResponse({ state }); return;
    case 'PREFLIGHT': chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => sendResponse({ mode: meetingForTab(tab?.id, tab?.url) ? 'meeting' : 'note' })); return true;
  }
});

// If the captured tab closes, tear down + forget its remembered meeting id.
chrome.tabs.onRemoved.addListener((tabId) => {
  tabMeeting.delete(tabId);
  if (tabId === state.tabId) stopCapture();
});

// Remember the meeting id from any JOIN URL a tab passes through (teams.microsoft.com
// /meet/<id>, zoom /j/<id>, …) BEFORE the SPA strips it: teams.cloud.microsoft and
// Zoom's web client only expose the id in the join link, not the in-meeting URL.
// Keyed by tab; reused by the toolbar mint + session bootstrap via meetingForTab.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  rememberMeeting(tabId, changeInfo.url || tab?.url || undefined);
});

// If the captured tab RELOADS mid-session (user refresh, SPA hard nav), the
// fresh page never saw BEGIN_CAPTURE — rewire it automatically so capture and
// attribution resume without manual Stop/Start.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== state.tabId || changeInfo.status !== 'complete') return;
  if (!isActive(state.status)) return;
  if (state.platform === 'note') return;
  // Same tab, DIFFERENT meeting (user joined a new call) → the session must
  // restart bound to the new native id, not keep writing into the old meeting.
  const detected = tab?.url ? detectMeeting(tab.url) : null;
  if (detected && state.nativeMeetingId && detected.nativeMeetingId !== state.nativeMeetingId) {
    shipTelemetry('meeting-changed-restart');
    stopCapture().then(() => maybeAutoStart(tabId, tab!.url!));
    return;
  }
  const token = state.sessionId;
  if (!token) return;
  setTimeout(() => {
    if (token === state.sessionId && !stopping) void pageControl('BEGIN_CAPTURE', token).catch(error => { if (token === state.sessionId) captureFailure(String(error)); });
  }, 1500);
  if (isMixed(state.platform)) {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, id => {
      if (token !== state.sessionId || stopping) return;
      if (chrome.runtime.lastError || !id) { state.error = 'Click the TINA toolbar icon on this tab to restore remote audio.'; state.status = 'no-signal'; broadcastStatus(); return; }
      tabStreamId = id; tabStreamTabId = tabId;
      void startTabAudio(token).catch(error => captureFailure(String(error)));
    });
  }
});

// On service-worker startup (extension load OR reload), re-inject the capture
// scripts into Meet AND Zoom tabs that are ALREADY open: an extension reload
// orphans every existing tab's content scripts (they can't reach the new SW),
// which repeatedly cost us live sessions silently running stale code. inpage.ts
// does a graceful takeover of any orphaned instance.
async function reinjectIntoOpenMeetingTabs(): Promise<void> {
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({
      url: [
        'https://meet.google.com/*',
        'https://*.zoom.us/*',
        'https://teams.microsoft.com/*',
        'https://teams.live.com/*',
        'https://teams.cloud.microsoft/*',
      ],
    });
  } catch { return; }
  for (const t of tabs) {
    if (t.id == null) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['content.js'] });
      await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['inpage.js'], world: 'MAIN' });
    } catch { /* chrome:// or unloadable frame — skip */ }
  }
}
const orphanCleanup = chrome.runtime.sendMessage({ type: 'CAPTURE_STATUS' })
  .then(status => status?.sessionId ? offscreenControl('CAPTURE_STOP', status.sessionId) : undefined).catch(() => {});
reinjectIntoOpenMeetingTabs();

// Toolbar click handling. We do NOT use openPanelOnActionClick, because the click
// on the toolbar icon is the ONLY event that grants activeTab on the current tab
// — and chrome.tabCapture.getMediaStreamId needs that activeTab. So on a MIXED-
// lane tab (YouTube, Zoom) we also mint the tab-capture stream id under this
// invocation and stash it for the next Start.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => { /* older Chrome */ });
// NOTE: listener is intentionally NOT async, and sidePanel.open() is the FIRST
// statement — it must run synchronously within the click gesture or Chrome
// rejects it ("must be called in response to a user gesture"). Minting the
// tab-capture stream id can happen after: it needs the activeTab grant (which the
// invocation gives and which persists), not the live gesture.
chrome.action.onClicked.addListener((tab) => {
  if (tab?.id == null) return;
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => { /* older Chrome / already open */ });

  // MIXED-lane tabs (YouTube, Zoom) capture the whole tab's audio via the
  // offscreen mixed captor — mint the stream id now while activeTab is granted.
  const needsTab = !!isMixed(meetingForTab(tab.id, tab.url)?.platform) || (!!tab.url && isMixedHost(tab.url));
  if (needsTab) {
    void chrome.storage.local.get('transcriptSource').then(cfg => {
      if (cfg.transcriptSource === 'bot') return;
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
        if (chrome.runtime.lastError || !id) {
          state.error = `tab audio: ${chrome.runtime.lastError?.message || 'no stream id'}`; broadcastStatus(); return;
        }
        tabStreamId = id; tabStreamTabId = tab.id!;
        if (state.tabId === tab.id && state.sessionId && sourcesStarted && isMixed(state.platform)) void startTabAudio().catch(error => captureFailure(String(error)));
      });
    });
  }
});

// Dev auto-reload: build.mjs rewrites build-stamp.txt on every build; when the
// on-disk stamp changes (e.g. dist/ is an SSHFS/rsync mirror of a remote build),
// reload the extension from disk. Cheap local-resource fetch; inert for any
// packaged build where the stamp never changes.
const stampUrl = chrome.runtime.getURL('build-stamp.txt');
let knownStamp: string | null = null;
fetch(stampUrl).then(r => r.text()).then(s => { knownStamp = s; state.swBuild = s; }).catch(() => { /* no stamp */ });
setInterval(async () => {
  // Keep pending delivery visible and issue an extension API call while RAM frames remain.
  if (pcmReplay.size) broadcastStatus();
  try {
    const cur = await fetch(stampUrl, { cache: 'no-store' }).then(r => r.text());
    if (knownStamp && cur && cur !== knownStamp) {
      // Never hot-reload mid-capture — reload() restarts capture, churns the
      // ingest session, and resets the transcription buffer. Defer until idle.
      // The panel surfaces a "background stale → Reload now" banner so the dev
      // isn't stuck on old code (esp. with auto-start keeping capture on).
      if (isActive(state.status) || pcmReplay.size) {
        state.diskBuild = cur; broadcastStatus(); return;
      }
      chrome.runtime.reload();
    }
  } catch { /* stamp unreadable; skip */ }
}, 2000);
