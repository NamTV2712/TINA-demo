"use client";
/** surfaces/context — the RIGHT pane of the agent-first shell (direction A, law #3: the right column is
 *  CONTEXT, not a second navigation).
 *
 *  Three cards, in priority order, each backed by a source that already exists — nothing here invents
 *  data the backend doesn't have:
 *    1. Grounded on — the record the conversation is pinned to (`layout.lastRecord`; see workbench/layout.ts).
 *    2. Threads     — the other agent sessions (GET /api/sessions), switchable in place.
 *    3. Workspace   — the signed-in user + the active mounts (GET /api/active-set).
 *
 *  Deliberately NOT here: per-paragraph citations and next-run / task lineage. The session history
 *  shape only carries `ops[]` + `commit` (surfaces/sessionsApi.ts) and Routine has no last/next run
 *  (surfaces/routinesApi.ts) — those are backend work, tracked as P4 in the redesign proposal. */
import { useCallback, useEffect, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useService, useStore } from "../platform";
import { LayoutServiceId, type ActiveTab } from "../workbench/layout";
import { Icon } from "../ui-kit";
import { listSessions, type SessionSummary } from "./sessionsApi";
import { sessionTitle } from "./sessions";
import { readActiveSet, type ActiveMount } from "./workspaceApi";
import { useLiveMeetings } from "./liveMeetings";
import { THREAD_TAB_KIND } from "../workbench/shell";

const KIND_LABEL: Record<string, string> = {
  meeting: "Meeting", meetingPrep: "Meeting prep", doc: "Document", file: "Document",
  today: "Today", workspace: "Workspace",
};

/** reconstruct the dockview panel id for a record tab so `openTab` DE-DUPES with the tab the user
 *  already has open instead of spawning a second one. Mirrors the id shapes the surfaces own
 *  (`meetingTab` in surfaces/meeting.tsx, the doc-tab helper in surfaces/meetingPrep.tsx, and the
 *  first-view resolver in workbench/Workbench.tsx). Unknown kinds return null: rather than guess an
 *  id we simply don't offer the button. */
export function recordTabId(tab: ActiveTab): string | null {
  const meetingId = typeof tab.params.meetingId === "string" ? tab.params.meetingId : null;
  if ((tab.kind === "meeting" || tab.kind === "meetingPrep") && meetingId) return `meeting:${meetingId}`;
  const path = typeof tab.params.path === "string" ? tab.params.path : null;
  if ((tab.kind === "doc" || tab.kind === "file") && path) {
    const slug = typeof tab.params.slug === "string" ? tab.params.slug : null;
    return slug ? `doc:${slug}:${path}` : `doc:${path}`;
  }
  if (tab.kind === "today") return "today";
  return null;
}

function Card({ title, children, error }: { title: string; children: ReactNode; error?: string | null }) {
  return (
    <section style={{ borderTop: "1px solid var(--line)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8, flex: "none" }}>
      <h3 style={{ margin: 0, fontSize: 10.5, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--t3)" }}>{title}</h3>
      {error
        ? <div role="alert" style={{ fontSize: 11.5, color: "var(--danger)" }}>⚠ {error}</div>
        : children}
    </section>
  );
}

const rowStyle: CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
  padding: "6px 8px", borderRadius: 7, border: "1px solid transparent", background: "transparent",
  color: "var(--t2)", fontSize: 12, cursor: "pointer", minWidth: 0,
};
const rowHover = (e: ReactMouseEvent<HTMLButtonElement>, on: boolean) => {
  e.currentTarget.style.background = on ? "var(--panel2)" : "transparent";
  e.currentTarget.style.color = on ? "var(--t1)" : "var(--t2)";
};

export function ContextRail() {
  const layout = useService(LayoutServiceId);
  const { activeSession, activeTab, lastRecord } = useStore(layout.store);
  const meetings = useLiveMeetings();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [sessionsErr, setSessionsErr] = useState<string | null>(null);
  const [mounts, setMounts] = useState<ActiveMount[] | null>(null);
  const [mountsErr, setMountsErr] = useState<string | null>(null);
  const [email, setEmail] = useState<string>("");

  // The thread grounds on the last NON-thread record while the thread itself is focused (see layout.ts);
  // in v1 there is no thread tab, so `activeTab` is already the record.
  const ground: ActiveTab | null = activeTab?.kind === THREAD_TAB_KIND ? lastRecord : activeTab;

  const load = useCallback(async () => {
    try { setSessions(await listSessions()); setSessionsErr(null); }
    catch (e) { setSessionsErr(e instanceof Error ? e.message : "Couldn't load threads"); }
    try { setMounts((await readActiveSet()).active); setMountsErr(null); }
    catch (e) { setMountsErr(e instanceof Error ? e.message : "Couldn't load workspace"); }
  }, []);

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setEmail(String(d?.user?.email ?? "")); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const groundId = ground ? recordTabId(ground) : null;
  const groundLabel = ground
    ? (ground.kind === "meeting" || ground.kind === "meetingPrep"
      ? (meetings.find((m) => m.id === ground.params.meetingId || m.native_id === ground.params.meetingId)?.title
        ?? ground.params.meetingId)
      : typeof ground.params.path === "string" ? ground.params.path
        : KIND_LABEL[ground.kind] ?? ground.kind)
    : null;
  const others = (sessions ?? []).filter((s) => s.session !== activeSession).slice(0, 6);
  const mountRows: ActiveMount[] = mounts ?? [];

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--rail)", borderLeft: "1px solid var(--line)", minHeight: 0, overflowY: "auto" }}>
      <div style={{ height: 32, flex: "none", display: "flex", alignItems: "center", gap: 7, padding: "0 14px", borderBottom: "1px solid var(--line)", fontSize: 10.5, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--t3)" }}>
        <Icon name="eye" size={12} />Context
      </div>

      <Card title="Grounded on">
        {ground && groundLabel ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <Icon name="pin" size={13} style={{ color: "var(--accent)" }} />
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, color: "var(--t1)" }}>{String(groundLabel)}</span>
            </div>
            <div style={{ fontSize: 11, color: "var(--t3)" }}>{KIND_LABEL[ground.kind] ?? ground.kind}</div>
            {groundId && (
              <button type="button" style={rowStyle} onMouseEnter={(e) => rowHover(e, true)} onMouseLeave={(e) => rowHover(e, false)}
                onClick={() => layout.openTab({ id: groundId, title: String(groundLabel), kind: ground.kind, params: ground.params })}>
                <Icon name="openIn" size={13} />Open record
              </button>
            )}
          </>
        ) : (
          <div style={{ fontSize: 12, color: "var(--t3)", lineHeight: 1.5 }}>
            Nothing pinned. Open a meeting or a document and it stays attached to this conversation.
          </div>
        )}
      </Card>

      <Card title="Threads" error={sessionsErr}>
        {sessions === null && !sessionsErr ? (
          <div style={{ fontSize: 12, color: "var(--t3)" }}>Loading…</div>
        ) : others.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--t3)" }}>This is the only thread right now.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {others.map((s) => (
              <button key={s.session} type="button" style={rowStyle} title={sessionTitle(s)}
                onMouseEnter={(e) => rowHover(e, true)} onMouseLeave={(e) => rowHover(e, false)}
                onClick={() => layout.setActiveSession(s.session)}>
                <Icon name="msg" size={13} style={{ color: "var(--t3)" }} />
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sessionTitle(s)}</span>
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card title="Workspace" error={mountsErr}>
        {mounts === null && !mountsErr ? (
          <div style={{ fontSize: 12, color: "var(--t3)" }}>Loading…</div>
        ) : mountRows.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--t3)" }}>No workspace connected.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {mountRows.map((m) => (
              <div key={m.slug} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", fontSize: 12, color: "var(--t2)", minWidth: 0 }}>
                <Icon name={m.primary ? "folder" : "link"} size={13} style={{ color: "var(--t3)" }} />
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name ?? m.slug}</span>
                <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--t3)", flex: "none" }}>{m.role}{m.write ? "" : " · read-only"}</span>
              </div>
            ))}
          </div>
        )}
        {email && <div style={{ fontSize: 11, color: "var(--t3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{email}</div>}
      </Card>

      <div style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}
