/**
 * Content script (isolated world) — session-scoped page capture bridge.
 *
 * Bridges the MAIN-world capture (inpage.ts) and the background service worker:
 *   - relays captured audio / control messages from inpage → background
 *   - forwards START/STOP commands from background → inpage
 *
 * No networking happens here; the background worker owns the WebSocket so it is
 * governed by the extension's host permissions, not Google Meet's page CSP.
 */

import { detectMeeting } from './meeting';

const TINA = '[tina-content]';

// The capture loop (inpage.ts) is registered as a MAIN-world content script in
// the manifest, so Chrome injects it directly (bypassing Google Meet's page CSP
// that would block a <script src> injection). No manual injection needed here.

(window as any).__tinaContentTeardown?.();
let disposed = false;
let captureSession: string | null = null;
const controls: Record<string, string> = { BEGIN_CAPTURE: 'tina-start', END_CAPTURE: 'tina-stop', CAPTURE_PAUSE: 'tina-pause', CAPTURE_RESUME: 'tina-resume' };

const forward = (event: MessageEvent) => {
  if (disposed || event.source !== window) return;
  const data = event.data;
  if (!data || data.__tina !== true || !captureSession || data.sessionId !== captureSession) return;
  if (!['audio', 'speakers', 'capture-started', 'capture-stopped', 'diag', 'dom_probe', 'speaker_activity', 'chat-message', 'recording-chunk', 'capture-control-result'].includes(data.type)) return;
  const { __tina, ...message } = data;
  chrome.runtime.sendMessage(message).then((result) => {
    if (data.type === 'recording-chunk') window.postMessage({ __tinaDelivery: true, sessionId: data.sessionId, requestId: data.requestId, ok: result?.ok === true }, '*');
  }).catch(() => {
    if (data.type === 'recording-chunk') window.postMessage({ __tinaDelivery: true, sessionId: data.sessionId, requestId: data.requestId, ok: false }, '*');
  });
  if (data.type === 'capture-control-result' && data.command === 'tina-stop' && data.ok) captureSession = null;
};
window.addEventListener('message', forward);

const control = (msg: any, _sender: chrome.runtime.MessageSender, sendResponse: (response: object) => void) => {
  if (disposed) return;
  const command = controls[msg.type];
  if (!command || typeof msg.sessionId !== 'string') return;
  if (msg.type === 'BEGIN_CAPTURE') captureSession = msg.sessionId;
  if (msg.sessionId !== captureSession) return;
  window.postMessage({ __tinaControl: true, command, sessionId: captureSession, requestId: msg.requestId, paused: !!msg.paused }, '*');
  sendResponse({ ok: true });
};
chrome.runtime.onMessage.addListener(control);

// --- Auto-start: when this tab is in an actual Google Meet, ask the background
// to start capturing. Meet is an SPA, so the URL can change from a landing page
// to a meeting without a reload — poll for that.
let lastSeenUrl = '';
function checkAutoStart(): void {
  if (location.href === lastSeenUrl) return;
  lastSeenUrl = location.href;
  if (detectMeeting(location.href)) {
    const detectedUrl = location.href;
    // Give the meeting UI / media a moment to come up before requesting auto-start.
    setTimeout(() => chrome.runtime.sendMessage({ type: 'AUTO_START', url: detectedUrl }).catch(() => { /* sw asleep */ }), 1500);
  }
}
checkAutoStart();
const autoTimer = setInterval(checkAutoStart, 2000);

// Teams' new web app (teams.cloud.microsoft) + meetings created in-tab NEVER expose
// the meeting id in the URL. Read the canonical thread id (19:meeting_…@thread.v2)
// from the page (DOM + same-origin storage) and report it so the background can key
// the session. Scan until found (stable per meeting), then stop.
function isTeamsHost(): boolean {
  return location.hostname.endsWith('teams.microsoft.com')
    || location.hostname.endsWith('teams.live.com')
    || location.hostname === 'teams.cloud.microsoft';
}
let teamsReported = false;
function checkTeamsMeeting(): void {
  if (teamsReported || !isTeamsHost()) return;
  let blob = '';
  try { blob = document.documentElement.outerHTML; } catch { /* */ }
  try { blob += ' ' + JSON.stringify({ ...sessionStorage, ...localStorage }); } catch { /* */ }
  const m = blob.match(/19:meeting_[A-Za-z0-9_\-]+@thread\.v2/);
  if (m) {
    teamsReported = true;
    chrome.runtime.sendMessage({ type: 'MEETING_HINT', meeting: { platform: 'teams', nativeMeetingId: m[0] } }).catch(() => { /* sw asleep */ });
    console.log(`${TINA} teams meeting id (from DOM): ${m[0]}`);
  }
}
checkTeamsMeeting();
const teamsTimer = setInterval(checkTeamsMeeting, 2000);

(window as any).__tinaContentTeardown = () => {
  disposed = true; captureSession = null; window.removeEventListener('message', forward);
  chrome.runtime.onMessage.removeListener(control); clearInterval(autoTimer); clearInterval(teamsTimer);
};

console.log(`${TINA} ready on ${location.href}`);
