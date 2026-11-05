"use client";
// Failure-surfacing banner for the live meeting feed. The signals (connected / reconnects /
// lastTranscriptAt / issues[]) are already tracked per live meeting and exposed as
// `meeting.diagnostics`; this is the LOUD surface that makes a broken feed unmissable to an operator
// instead of silently showing stale lines.
import { useEffect, useState, type CSSProperties } from "react";
import styles from "./MeetingTranscript.module.css";
import { useMeeting } from "./useMeeting";
import { formatElapsed, meetingHealth, STALE_MS, type MeetingHealthKind } from "./meetingHealth";

// Live statuses (mirrors the meeting surface header) — a feed we should watch for staleness/drops.
const LIVE_STATUSES = new Set(["active", "live", "requested", "joining", "awaiting_admission", "needs_help", "stopping"]);

// Only a real error is LOUD (red). A reconnect or a quiet meeting (no new lines) is benign — often just
// silence, not a failure — so those get a muted, informational tone instead of the alarming red box.
const TONE: Record<Exclude<MeetingHealthKind, "ok">, { color: string; bg: string }> = {
  ended: { color: "var(--t2)", bg: "var(--panel2)" },
  disconnected: { color: "var(--t2)", bg: "var(--panel2)" },
  stalled: { color: "var(--t2)", bg: "var(--panel2)" },
  // A failed model/parse operation needs attention without implying capture has stopped.
  error: { color: "var(--warn)", bg: "var(--warnbg)" },
};

function issueLabel(kind: "stream" | "model" | "parse"): string {
  if (kind === "model") return "Model inference error";
  if (kind === "parse") return "Transcript parse error";
  return "Stream error";
}

export function MeetingHealthBanner({ hideEnded = false }: { hideEnded?: boolean }) {
  const meeting = useMeeting();
  const diagnostics = meeting.diagnostics;
  const status = String(meeting.meeting.status ?? "").toLowerCase();
  const live = LIVE_STATUSES.has(status);

  // A cheap 1s now-tick so the "no new lines for Ns" elapsed time keeps ticking while stale/disconnected.
  // Only runs while a live feed could go stale; cleaned up on unmount / when not live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);

  const [dismissedAt, setDismissedAt] = useState<number | undefined>(undefined);

  const health = meetingHealth(diagnostics, now, live, STALE_MS);
  if (health.kind === "ok" || (hideEnded && health.kind === "ended")) return null;

  // The error chip (model/parse/stream issue) is dismissible; the headline failure states are not.
  const issue = health.latestIssue;
  const issueDismissed = issue?.at != null && dismissedAt === issue.at;

  // Nothing to show: a fresh, connected, error-free live feed (or a dismissed lone error).
  if (health.kind === "error" && issueDismissed) return null;

  const tone = TONE[health.kind];
  const elapsed = health.staleForMs != null ? formatElapsed(health.staleForMs) : undefined;

  let headline: string;
  let dot = true;
  switch (health.kind) {
    case "ended":
      headline = "Meeting ended";
      dot = false;
      break;
    case "disconnected":
      headline = "Reconnecting to live stream…";
      break;
    case "stalled":
      headline = `Waiting for transcript${elapsed ? ` — no new lines for ${elapsed}` : ""}`;
      break;
    case "error":
    default:
      headline = issue ? `${issueLabel(issue.kind)}${issue.status ? ` (${issue.status})` : ""}` : "Meeting feed error";
      break;
  }

  const heading = <span className={styles.healthHeading}>
    {dot && <span className={styles.healthDot} aria-hidden="true" />}
    <span>{headline}</span>
  </span>;
  const showIssue = health.kind !== "ended" && issue && !issueDismissed;
  return (
    <div role="status" aria-live="polite" className={styles.health}
      style={{ "--health-color": tone.color, "--health-bg": tone.bg } as CSSProperties}>
      {showIssue ? <details className={styles.healthDetails} key={issue.at}>
        <summary>{heading}<span className={styles.detailHint}>Details</span></summary>
        <p className={styles.issueMessage}>{issueLabel(issue.kind)}{issue.status ? ` (${issue.status})` : ""}: {issue.message}</p>
      </details> : heading}
      {health.kind === "error" && issue && <button type="button" onClick={() => setDismissedAt(issue.at)} title="Dismiss">Dismiss</button>}
    </div>
  );
}
