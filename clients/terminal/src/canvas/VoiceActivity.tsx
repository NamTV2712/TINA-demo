"use client";
import { useEffect, useState } from 'react';
import { voiceActivity, voiceActivities, VOICE_ACTIVITY_TTL } from '../lib/voiceActivity';
import styles from './VoiceActivity.module.css';

export function VoiceActivity({ meetingId, ended = false }: { meetingId: string; ended?: boolean }) {
  const [snapshot, setSnapshot] = useState<{ id: string; value: unknown }>({ id: '', value: undefined });
  useEffect(() => {
    if (ended || !/^\d+$/.test(meetingId)) return;
    const abort = new AbortController();
    let poll: ReturnType<typeof setTimeout>, expiry: ReturnType<typeof setTimeout>;
    setSnapshot({ id: meetingId, value: undefined });
    const stale = () => setSnapshot({ id: meetingId, value: null });
    async function refresh() {
      try {
        const response = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}/voice-assistant`, {
          cache: 'no-store', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
        });
        if (!response.ok) throw new Error('Voice status unavailable');
        const value = await response.json();
        if (abort.signal.aborted) return;
        setSnapshot({ id: meetingId, value });
        clearTimeout(expiry);
        const observed = value?.runtime?.kws?.observed_at_ms ?? Date.now();
        expiry = setTimeout(stale, Math.max(0, Math.min(VOICE_ACTIVITY_TTL, (typeof observed === 'number' ? observed : 0) + VOICE_ACTIVITY_TTL - Date.now())));
      } catch { if (!abort.signal.aborted) stale(); }
      if (!abort.signal.aborted) poll = setTimeout(refresh, 1500);
    }
    void refresh();
    return () => { abort.abort(); clearTimeout(poll); clearTimeout(expiry); };
  }, [meetingId, ended]);
  if (!/^\d+$/.test(meetingId)) return null;
  const phase = voiceActivity(snapshot.id === meetingId ? snapshot.value : undefined, Date.now(), ended);
  const status = voiceActivities[phase];
  return <span className={styles.indicator} data-phase={phase} data-meeting-id={meetingId}
    role="status" aria-live="polite" aria-atomic="true" aria-label={`TINA · ${status.label}`} title={status.title}>
    <svg className={styles.wave} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M3 6v4"/><path d="M8 3v10"/><path d="M13 5v6"/>
    </svg>
    <span className={styles.name}>TINA</span><span className={styles.label}>{status.label}</span>
  </span>;
}
