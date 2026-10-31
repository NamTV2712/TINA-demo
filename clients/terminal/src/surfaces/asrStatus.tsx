"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "../ui-kit";
import { presentError } from "./apiClient";
import type { AsrStatusResult } from "../lib/asrStatus";
import { browserAsrTimings, serverAsrTimings, subscribeAsrTimings, timingPercentiles } from "../lib/asrTelemetry";
import styles from "./asrStatus.module.css";

const ms = (value: number | null | undefined) => value == null ? "—" : value < 1000 ? `${value.toFixed(1)} ms` : `${(value / 1000).toFixed(2)} s`;
const stages = [
  ["capture_ms", "Capture / buffer", "Last submitted audio sample → ASR submission. Sample-clock estimate."],
  ["queue_ms", "Queue wait", "Admission → model lock acquired."],
  ["inference_ms", "Model pipeline", "Selected VAD + ASR inference and segment assembly."],
  ["total_ms", "ASR service total", "HTTP receipt → ASR response. Includes queue and model time."],
  ["audio_ms", "Audio window", "Audio duration per request; this is window size, not processing latency."],
] as const;
const stateLabel = { ready: "Ready", unsupported: "Diagnostics unavailable", unreachable: "Service unreachable", unconfigured: "Not configured" };

export function AsrStatusPanel() {
  const [data, setData] = useState<AsrStatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  const local = useSyncExternalStore(subscribeAsrTimings, browserAsrTimings, serverAsrTimings);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    pending.current = true;
    setBusy(true);
    void (async () => {
      try {
        const response = await fetch("/api/admin/asr-status", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 404 ? "Administrator access is required to view ASR diagnostics." : "Could not load ASR status. Try refreshing.");
        const body = await response.json() as AsrStatusResult;
        if (alive) { setData(body); setError(null); }
      } catch (failure) {
        if (alive) setError(presentError(failure).headline);
      } finally {
        if (alive) { setBusy(false); pending.current = false; }
      }
    })();
    return () => { alive = false; pending.current = false; controller.abort(); };
  }, [revision]);

  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden && !pending.current) setRevision((value) => value + 1); }, 5000);
    return () => clearInterval(timer);
  }, []);

  const service = error ? null : data?.service;
  return (
    <section className={styles.page} aria-label="ASR status">
      <header className={styles.header}>
        <div>
          <h2>Speech recognition</h2>
          <p>Measured stages from captured audio to the Terminal. Refreshes every 5 seconds while visible.</p>
        </div>
        <button type="button" onClick={() => setRevision((value) => value + 1)} disabled={busy} className={styles.button}>
          <Icon name="refresh" size={13} />{busy ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      {error && <div className={styles.error} role="alert">{error}</div>}
      {!data && busy && <p role="status" aria-busy="true">Loading ASR diagnostics…</p>}
      {data && !error && <>
        <div className={styles.summary} role="status">
          <strong className={data.state === "ready" ? styles.ready : styles.warning}>{stateLabel[data.state]}</strong>
          <span>{data.backend} · checked {new Date(data.checked_at_ms).toLocaleTimeString()}</span>
        </div>
        {!service && <p className={styles.empty}>
          {data.state === "unsupported" ? "The selected backend does not expose compatible diagnostics. No measurements have been inferred."
            : data.state === "unconfigured" ? "Choose a transcription backend in Settings → Models → Transcription."
              : "The selected ASR service could not be reached. Check that its local process is running."}
        </p>}
      </>}
      {service && <>
        <dl className={styles.config}>
          <div><dt>ASR model</dt><dd>{service.model.asr_model}</dd></div>
          <div><dt>Voice activity</dt><dd>{service.model.vad_model}</dd></div>
          <div><dt>Actual device</dt><dd>{service.model.device.toUpperCase()}
            {service.model.device !== service.model.requested_device && <span className={styles.warning}> · requested {service.model.requested_device.toUpperCase()}</span>}
          </dd></div>
          <div><dt>Requests since start</dt><dd>{service.requests.total} · {service.requests.errors} errors</dd></div>
        </dl>
        <div className={styles.summary}>
          <span><strong>{service.queue.active}</strong> running · <strong>{service.queue.waiting}</strong> waiting / {service.queue.capacity} admitted</span>
          <span>Queue deadline {ms(service.queue.wait_limit_ms)}</span>
        </div>
        <h3>ASR timings</h3>
        <p>p50 / p95 over the latest {service.recent.length} requests across clients. Empty cells mean no measured samples.</p>
        <div className={styles.scroll}>
          <table><thead><tr><th>Stage</th><th>p50</th><th>p95</th><th>Samples</th></tr></thead><tbody>
            {stages.map(([key, label, description]) => <tr key={key}>
              <th scope="row">{label}<small>{description}</small></th>
              <td>{ms(service.latency[key].p50_ms)}</td><td>{ms(service.latency[key].p95_ms)}</td><td>{service.latency[key].count}</td>
            </tr>)}
          </tbody></table>
        </div>
        {!service.recent.length && <p className={styles.empty}>No ASR requests yet. Dictate a message or start a meeting to collect samples.</p>}
        {service.recent.length > 0 && <>
          <h3>Recent requests</h3>
          <div className={styles.scroll}><table><thead><tr><th>Request</th><th>Client</th><th>HTTP</th><th>Queue</th><th>Model</th><th>Total</th></tr></thead>
            <tbody>{service.recent.slice(0, 15).map((sample) => <tr key={sample.request_id}>
              <td><code title={sample.request_id}>{sample.request_id.slice(0, 8)}</code><small>{new Date(sample.at_ms).toLocaleTimeString()}</small></td>
              <td>{sample.source}</td><td className={sample.http_status >= 400 ? styles.error : undefined}>{sample.http_status}</td>
              <td>{ms(sample.queue_ms)}</td><td>{ms(sample.inference_ms)}</td><td>{ms(sample.total_ms)}</td>
            </tr>)}</tbody></table></div>
        </>}
      </>}
      <h3>This browser</h3>
      <p>Local samples only. Meeting view measures render → next animation frame; dictation measures response → next frame. Frame samples require a focused, visible page. HTTP is recorded even without a frame; percentiles are not added.</p>
      <div className={styles.scroll}><table><thead><tr><th>Surface</th><th>Frame p50</th><th>Frame p95</th><th>HTTP p95</th><th>Samples: frame / HTTP</th></tr></thead>
        <tbody>{(["dictation", "meeting-view"] as const).map((source) => {
          const samples = local.filter((sample) => sample.source === source);
          const frames = timingPercentiles(samples.flatMap((sample) => sample.frame_ms == null ? [] : [sample.frame_ms]));
          const http = timingPercentiles(samples.flatMap((sample) => sample.http_ms == null ? [] : [sample.http_ms]));
          return <tr key={source}><th scope="row">{source === "dictation" ? "Composer dictation" : "Meeting transcript"}</th>
            <td>{ms(frames.p50_ms)}</td><td>{ms(frames.p95_ms)}</td><td>{ms(http.p95_ms)}</td><td>{frames.count} / {http.count}</td></tr>;
        })}</tbody></table></div>
      {local.find((sample) => sample.request_id) && <p>
        Latest dictation request: <code>{local.find((sample) => sample.request_id)!.request_id!.slice(0, 8)}</code> · match this ID in Recent requests.
      </p>}
      <p className={styles.footnote}>Service samples reset on restart; browser samples reset on page reload. Frame delay includes browser/compositor scheduling, not only React work. Timings contain no transcript text or audio. Hardware capture latency and relay/network latency are not measured separately.</p>
    </section>
  );
}
