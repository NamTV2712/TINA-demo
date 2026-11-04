/** speech.v1 tracked commands; legacy acts.v1 callers retain Speak/Stop behavior. */
import type { Invocation } from './config.js';
import type { Act } from './contracts.js';
import type { SpeakController } from './capture-bridge.js';

export type SpeechState = 'started' | 'completed' | 'failed' | 'stopped';
export type SpeechReporter = (commandId: string, state: SpeechState) => Promise<void>;

export function createSpeechReporter(inv: Invocation, fetchImpl = globalThis.fetch): SpeechReporter {
  let pending = Promise.resolve();
  return (commandId, state) => {
    pending = pending.catch(() => {}).then(async () => {
      if (!inv.meetingApiCallbackUrl || !inv.internalSecret || !inv.meeting_id || !inv.connectionId) {
        throw new Error('Speech callback configuration is missing');
      }
      const url = new URL(inv.meetingApiCallbackUrl);
      url.pathname = '/bots/internal/callback/speech'; url.search = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetchImpl(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-secret': inv.internalSecret },
            body: JSON.stringify({ command_id: commandId, meeting_id: inv.meeting_id,
              session_uid: inv.connectionId, state }), signal: AbortSignal.timeout(2000),
          });
          if (response.ok) return;
        } catch { /* receipt delivery only; never repeat synthesis/playback */ }
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      }
      throw new Error('Speech receipt could not be delivered');
    });
    return pending;
  };
}

export function createSpeechHandler(speak: SpeakController, report: SpeechReporter): (act: Act) => Promise<void> {
  let active: string | null = null;
  const cancelled = new Set<string>();
  const remember = (id: string) => {
    cancelled.add(id);
    if (cancelled.size > 128) cancelled.delete(cancelled.values().next().value!);
  };
  return async act => {
    if (act.action === 'speak') { await speak.speak(act.text, act.voice); return; }
    if (act.action === 'speak_stop') {
      const previous = active;
      if (previous) remember(previous);
      await speak.stop();
      if (previous) await report(previous, 'stopped');
      return;
    }
    if (act.action === 'speech_stop') {
      remember(act.command_id);
      if (active === act.command_id) await speak.stop();
      await report(act.command_id, 'stopped');
      return;
    }
    if (act.action !== 'speech_speak') return;
    const id = act.command_id;
    if (cancelled.has(id)) { await report(id, 'stopped'); return; }
    active = id;
    let started = Promise.resolve();
    let state: SpeechState = 'failed';
    try {
      state = await speak.speak(act.text, act.voice, () => {
        started = report(id, 'started');
        void started.catch(() => {});
      }) ?? 'failed';
      await started;
    } catch { state = 'failed'; }
    if (active === id) active = null;
    await report(id, cancelled.has(id) ? 'stopped' : state);
  };
}
