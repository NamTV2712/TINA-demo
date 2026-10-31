"use client";
/** Routines — a center Operations Register table (created in Chat via /routine). The left "Routines" item
 *  opens the table and shows a compact list. Mutations use the existing routines API and source preconditions. */
import { Fragment, useEffect, useState } from "react";
import { useService } from "../platform";
import { LayoutServiceId, type TabDescriptor } from "../workbench/layout";
import { registerList, registerTab } from "../contributions";
import { meetingsOnly } from "../app/mode";
import { Icon } from "../ui-kit";
import { usePreviewPinTab } from "./previewPinTab";
import styles from "./routines.module.css";
// Data-access lives in its own SoC module (scoped to the authed user — no client subject, P20),
// proven in isolation by routinesApi.test.ts.
import { listRoutines, deleteRoutine, setRoutineEnabled, saveRoutine, type Routine } from "./routinesApi";
import { presentError } from "./apiClient";

const BOARD: TabDescriptor = { id: "board:routines", title: "Routines", kind: "routines", params: {}, context: null };

function RoutinesBoardNav() {
  const nav = usePreviewPinTab<HTMLButtonElement>(BOARD);
  return (
    <button onClick={nav.onClick} onDoubleClick={nav.onDoubleClick} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 9px", borderRadius: 7, border: "1px solid var(--line2)", background: "var(--panel)", color: "var(--t1)", fontSize: 13, cursor: "pointer", marginBottom: 8 }}>
      <Icon name="zap" size={14} />Routines board
    </button>
  );
}

function RoutineNavRow({ routine }: { routine: Routine }) {
  const nav = usePreviewPinTab<HTMLDivElement>(BOARD);
  return (
    <div onClick={nav.onClick} onDoubleClick={nav.onDoubleClick} style={{ padding: "6px 9px", borderRadius: 6, cursor: "pointer", fontSize: 12.5, color: "var(--t2)" }}>{routine.name}</div>
  );
}

// ── center BOARD (kind "routines") ────────────────────────────────────────────────
export function RoutinesBoard() {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [draft, setDraft] = useState<Routine | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function load() { setRoutines(await listRoutines()); }
  useEffect(() => {
    if (draft || busy) return;
    let alive = true;
    const refresh = () => { void listRoutines().then(rows => { if (alive) setRoutines(rows); }).catch(e => { if (alive) setError(presentError(e).headline); }); };
    refresh();
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener('focus', refresh);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [draft, busy]);
  async function mutate(action: () => Promise<void>, closeDraft = false) {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); await load(); if (closeDraft) setDraft(null); }
    catch (e) { setError(presentError(e).headline); }
    finally { setBusy(false); }
  }
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "enabled" | "disabled">("all");
  const nextRun = (r: Routine) => {
    if (!r.enabled) return "Paused";
    if (!r.next_run) return "Not scheduled";
    try { return new Date(r.next_run * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: r.timezone || "UTC", timeZoneName: "short" }); }
    catch { return "Invalid time zone"; }
  };
  const visibleRoutines = routines.filter((r) => {
    const matchesStatus = statusFilter === "all" || (statusFilter === "enabled" ? r.enabled : !r.enabled);
    const haystack = [r.name, r.plan_summary, r.prompt, r.cron, r.timezone, r.workspace_label].filter(Boolean).join(" ").toLowerCase();
    return (matchesStatus && haystack.includes(query.trim().toLowerCase())) || draft?.id === r.id;
  });
  const draftForm = (r: Routine) => <form className={styles.editForm} onSubmit={e => { e.preventDefault(); void mutate(() => saveRoutine(r), true); }}>
    <label className={styles.field}>Display name<input aria-label="Display name" disabled={busy} maxLength={120} value={r.name} onChange={e => setDraft({ ...r, name: e.target.value })} /></label>
    <label className={styles.field}>Cron schedule<input aria-label="Cron schedule" disabled={busy} value={r.cron} onChange={e => setDraft({ ...r, cron: e.target.value })} /></label>
    <label className={styles.field}>IANA time zone<input aria-label="IANA time zone" disabled={busy} value={r.timezone || "UTC"} placeholder="Asia/Ho_Chi_Minh" onChange={e => setDraft({ ...r, timezone: e.target.value })} /></label>
    <label className={`${styles.field} ${styles.fullField}`}>Task instructions<textarea aria-label="Task instructions" rows={4} disabled={busy} maxLength={50000} value={r.prompt || ""} onChange={e => setDraft({ ...r, prompt: e.target.value })} /></label>
    <p className={styles.formNote}>The display name can change; the routine ID and source file stay the same.</p>
    <div className={styles.formActions}><button className={styles.primaryButton} disabled={busy || !r.name.trim() || !r.prompt?.trim()}>{busy ? "Saving…" : "Save"}</button><button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => { setDraft(null); setError(null); }}>Cancel</button></div>
  </form>;

  return <main className={styles.page}>
    <div className={styles.content}>
      <div className={styles.eyebrow}>AUTOMATIONS / ROUTINES</div>
      <header className={styles.heading}><div><h1>Routines</h1><p>Create scheduled agents in Chat with <code>/routine</code>. Times follow each routine’s listed time zone.</p></div><span className={styles.total}>{routines.length} {routines.length === 1 ? "routine" : "routines"}</span></header>
      {error && <p className={styles.error} role="alert">{error} Your draft is preserved. Cancel and reopen to load the latest version.</p>}
      <div className={styles.toolbar}>
        <label className={styles.search}><span aria-hidden="true">⌕</span><input aria-label="Search routines" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search routines…" /></label>
        <div className={styles.filters} aria-label="Filter routines">
          {(["all", "enabled", "disabled"] as const).map((filter) => <button key={filter} type="button" aria-pressed={statusFilter === filter} className={statusFilter === filter ? styles.selectedFilter : ""} onClick={() => setStatusFilter(filter)}>{filter === "all" ? "All" : filter === "enabled" ? "Enabled" : "Disabled"}</button>)}
        </div>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead><tr><th>Routine</th><th>Schedule</th><th>Time zone</th><th>Workspace</th><th>Next run</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {!visibleRoutines.length && <tr><td colSpan={7}><div className={styles.empty}><strong>{routines.length ? "No routines match your filters" : "No routines yet"}</strong><span>{routines.length ? "Try another search or status filter." : <>Open Chat and send <code>/routine</code> to create your first routine.</>}</span></div></td></tr>}
            {visibleRoutines.map((r) => <Fragment key={r.id}>
              <tr className={styles.dataRow}>
                <td><div className={styles.routineName}><span className={styles.routineMark}><Icon name="zap" size={13} /></span><span className={styles.routineCopy}><strong>{r.name}</strong><small title={r.plan_summary || r.prompt || ""}>{r.plan_summary || r.prompt || "No task summary available"}</small></span></div></td>
                <td><code className={styles.cron}>{r.cron}</code></td>
                <td><span className={styles.timezone}>{r.timezone || "UTC"}</span><small className={styles.cellHint}>Local time</small></td>
                <td><span className={styles.workspace}>{r.workspace_label || "Legacy API"}</span></td>
                <td><span className={styles.nextRun}>{nextRun(r)}</span>{r.enabled && r.next_run && <small className={styles.cellHint}>{r.timezone || "UTC"}</small>}</td>
                <td><button type="button" role="switch" aria-label={`${r.enabled ? "Disable" : "Enable"} ${r.name}`} aria-checked={r.enabled} className={`${styles.statusSwitch} ${r.enabled ? styles.isEnabled : ""}`} disabled={busy || !!draft || !r.editable} onClick={() => void mutate(() => setRoutineEnabled(r.id, !r.enabled, r.expected_sha256))}><span className={styles.statusDot} />{r.enabled ? "Enabled" : "Disabled"}</button></td>
                <td><div className={styles.actions}><button type="button" aria-label={`Edit ${r.name}`} disabled={busy || !!draft || !r.editable} onClick={() => setDraft({ ...r, timezone: r.timezone || "UTC", prompt: r.prompt || "" })}>Edit</button><button type="button" aria-label={`Delete ${r.name}`} disabled={busy || !!draft} onClick={() => void mutate(() => deleteRoutine(r.id, r.expected_sha256))}>Delete</button></div></td>
              </tr>
              {!r.editable && <tr className={styles.legacyRow}><td colSpan={7}>Legacy routine: it can be deleted here, but editing and persistent enable/disable require a routine created with <code>/routine</code>.</td></tr>}
              {draft?.id === r.id && <tr className={styles.draftRow}><td colSpan={7}>{draftForm(draft)}</td></tr>}
            </Fragment>)}
          </tbody>
        </table>
      </div>
      <p className={styles.footerNote}>Disabling or deleting prevents future runs. A task already accepted by an agent may still finish.</p>
    </div>
  </main>;
}

// ── left launcher (opens the board, shows a compact list) ─────────────────────────
function RoutinesLeft() {
  const layout = useService(LayoutServiceId);
  const [routines, setRoutines] = useState<Routine[]>([]);
  useEffect(() => { layout.openTab(BOARD); void listRoutines().then(setRoutines).catch(() => {/* the board view surfaces the error loudly */}); }, [layout]);
  return (
    <div style={{ padding: "8px" }}>
      <RoutinesBoardNav />
      <div style={{ fontSize: 11, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".04em", padding: "6px 4px 4px" }}>Scheduled agents</div>
      {routines.map((r) => <RoutineNavRow key={r.id} routine={r} />)}
      {routines.length === 0 && <div style={{ padding: "8px 4px", color: "var(--t3)", fontSize: 12 }}>No routines yet — create one with <code style={{ fontFamily: "var(--mono)", color: "var(--accent)" }}>/routine</code> in Chat.</div>}
    </div>
  );
}

// Agent surface — absent in meetings-only mode (NEXT_PUBLIC_TERMINAL_MODE=meetings).
if (!meetingsOnly()) {
  registerTab("routines", RoutinesBoard);
  registerList({ id: "routines", label: "Routines", icon: "zap", order: 40, component: RoutinesLeft });
}
