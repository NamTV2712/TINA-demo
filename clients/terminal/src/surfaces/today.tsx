"use client";
/** Today — the Meetings surface's CENTER tab, v5 AGENDA TIMELINE (design-spec
 *  today-v5-agenda-timeline, owner-approved mockup). ONE time axis:
 *
 *    "Coming up"  — a day-grouped agenda card for the visible week (‹ › pages weeks). A live
 *                   meeting shows IN PLACE on its day row (green bar) — no separate NOW zone.
 *    past feed    — reverse-chron day-grouped rows below: faces · title · one state phrase.
 *
 *  RENDERING LAW (binding): a meeting row is ONE line — title + time (+ faces on past rows).
 *  The ONLY extra ink is ONE inline deviation phrase (`in meeting →` · `couldn't import` ·
 *  `no brief yet` · `recap ready`), each deep-linking to the right page. A prepared meeting is
 *  the quiet default and carries NO phrase. Depth lives on the per-state pages, not here.
 *  Supersedes the v4 zones (NOW/NEXT/THIS WEEK/LATER/TO REVIEW) — same intent, less vocabulary. */
import { useEffect, useState, useSyncExternalStore } from "react";
import { registerTab } from "../contributions";
import { Icon } from "../ui-kit";
import { useService } from "../platform";
import { LayoutServiceId } from "../workbench/layout";
import { usePreviewPinTab } from "./previewPinTab";
import type { MeetingMock } from "./meetingModel";
import { useLiveMeetings, fetchDurableTranscript } from "./liveMeetings";
import { groupMeetings, type MeetingGroup } from "./meetingGroups";
import { meetingTab } from "./meeting";
import { MeetingsOnboarding } from "./meetingsOnboarding";
import { findBriefNote } from "./briefNote";
import { listWorkspaceTree } from "./workspaceApi";
import { meetingFocusFor } from "./chatContext";
import { ASK_CHAT_EVENT } from "../canvas/actions";

// ── reviewed-recaps store (localStorage) — opening a recap retires its phrase ──────────────────
const REVIEWED_KEY = "tina.reviewedMeetings";
let reviewed: Set<string> = new Set();
try { reviewed = new Set(JSON.parse(localStorage.getItem(REVIEWED_KEY) ?? "[]") as string[]); } catch { /* fresh */ }
const reviewedSubs = new Set<() => void>();
let reviewedSnapshot: string[] = [...reviewed];
export function markReviewed(runId: string): void {
  if (reviewed.has(runId)) return;
  reviewed.add(runId);
  reviewedSnapshot = [...reviewed];
  try { localStorage.setItem(REVIEWED_KEY, JSON.stringify(reviewedSnapshot.slice(-500))); } catch { /* quota */ }
  reviewedSubs.forEach((f) => f());
}
function useReviewed(): Set<string> {
  useSyncExternalStore(
    (cb) => { reviewedSubs.add(cb); return () => reviewedSubs.delete(cb); },
    () => reviewedSnapshot,
    () => reviewedSnapshot,
  );
  return reviewed;
}

// ── pure timeline splitters (unit-tested offline) ─────────────────────────────────────────────
export interface AgendaDay { key: string; date: Date; groups: MeetingGroup[] }

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

/** The agenda window: day-grouped upcoming (+live) meetings for the week starting at
 *  today + 7·weekOffset days. Unscheduled plans attach to TODAY (offset 0 only) — they need
 *  attention but have no place on a time axis. Days without events are omitted, except today. */
export function agendaWindow(groups: MeetingGroup[], now: Date = new Date(), weekOffset = 0): AgendaDay[] {
  const start = startOfDay(now);
  start.setDate(start.getDate() + weekOffset * 7);
  const end = new Date(start); end.setDate(end.getDate() + 7);
  const days = new Map<string, AgendaDay>();
  const put = (d: Date, g: MeetingGroup) => {
    const k = dayKey(d);
    let day = days.get(k);
    if (!day) { day = { key: k, date: startOfDay(d), groups: [] }; days.set(k, day); }
    day.groups.push(g);
  };
  for (const g of groups) {
    if (g.phase !== "prep" && g.phase !== "live") continue;
    const at = g.current.scheduled_at ? new Date(g.current.scheduled_at) : null;
    if (at && Number.isFinite(at.getTime())) {
      // a live meeting always shows — clamp a stale/past schedule onto today so it can't vanish
      const slot = g.phase === "live" && at < start ? new Date(now) : at;
      if (slot >= start && slot < end) put(slot, g);
    } else if (weekOffset === 0) {
      put(new Date(now), g);   // unscheduled (or undated live) → today's row, "no time set"
    }
  }
  // today's row always renders on the current week so "No events today" is stated honestly
  if (weekOffset === 0 && !days.has(dayKey(now))) days.set(dayKey(now), { key: dayKey(now), date: startOfDay(now), groups: [] });
  const out = [...days.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
  for (const day of out) {
    day.groups.sort((a, b) => (a.current.scheduled_at ?? "9999").localeCompare(b.current.scheduled_at ?? "9999"));
  }
  return out;
}

export interface PastEntry { run: MeetingMock; group: MeetingGroup }
export interface PastDay { key: string; date: Date; entries: PastEntry[] }

const PAST_CAP = 8;

/** The past feed: each meeting's newest finished run, newest first, day-grouped. */
export function pastFeed(groups: MeetingGroup[], cap: number = PAST_CAP): PastDay[] {
  const entries: PastEntry[] = groups
    .filter((g) => g.pastRuns[0] && (g.pastRuns[0].has_recording || g.pastRuns[0].start_time))
    .map((g) => ({ run: g.pastRuns[0], group: g }))
    .sort((a, b) => (b.run.start_time ?? "").localeCompare(a.run.start_time ?? ""))
    .slice(0, cap);
  const days = new Map<string, PastDay>();
  for (const e of entries) {
    const d = e.run.start_time ? new Date(e.run.start_time) : new Date();
    const k = dayKey(d);
    let day = days.get(k);
    if (!day) { day = { key: k, date: startOfDay(d), entries: [] }; days.set(k, day); }
    day.entries.push(e);
  }
  return [...days.values()].sort((a, b) => b.date.getTime() - a.date.getTime());
}

/** ONE deviation phrase per row (the rendering law) — or null for the quiet default.
 *  `hasOwnBrief`: an unbound meeting whose brief lives as this meeting's note in the user's OWN
 *  workspace (frame-6 flow) is PREPARED — quiet, same as a bound workspace. */
export function deviationPhrase(g: MeetingGroup, hasOwnBrief = false): { text: string; tone: "live" | "danger" | "accent" } | null {
  const m = g.current;
  if (g.phase === "live") return { text: "in meeting →", tone: "live" };
  if (m.auto_join_error) return { text: "couldn’t import — no meeting link", tone: "danger" };
  if (!m.native_id && !m.meeting_url) return { text: "no meeting link", tone: "danger" };
  if (!m.workspace_id && !hasOwnBrief) return { text: "no brief yet", tone: "accent" };
  return null;
}

// ── own-workspace brief notes (frame 6): ONE tree fetch feeds every row's phrase ───────────────
const OWN_TREE_POLL_MS = 60_000;
function useOwnWorkspaceTree(): string[] | null {
  const [files, setFiles] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    const look = () => void listWorkspaceTree()
      .then((f) => { if (alive) setFiles(f); })
      .catch(() => { /* keep last good — a blip must not flip rows back to "no brief yet" */ });
    look();
    const t = setInterval(() => { if (document.visibilityState === "visible") look(); }, OWN_TREE_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return files;
}

// ── rendering ─────────────────────────────────────────────────────────────────────────────────
const label = (m: MeetingMock) => m.title_custom ?? (m.native_id ?? m.title).replace(/^Google Meet · /, "");

const toneColor = { live: "var(--green)", danger: "var(--danger)", accent: "var(--accent)" } as const;

function timeShort(at?: string): string {
  if (!at) return "no time set";
  try { return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
  catch { return "scheduled"; }
}

function Faces({ m }: { m: MeetingMock }) {
  const att = (m.attendees ?? []).slice(0, 3);
  if (!att.length) return null;
  const extra = (m.attendees?.length ?? 0) - att.length;
  const initials = (a: { email: string; name?: string }) =>
    (a.name ? a.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("") : a.email.slice(0, 2)).toUpperCase();
  return (
    <span style={{ display: "inline-flex", flex: "none" }}>
      {att.map((a, i) => (
        <span key={a.email} title={a.name || a.email}
          style={{ width: 20, height: 20, borderRadius: "50%", background: "var(--panel2)", color: "var(--t2)",
            display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 700,
            border: "2px solid var(--bg)", marginLeft: i ? -6 : 0 }}>
          {initials(a)}
        </span>
      ))}
      {extra > 0 && (
        <span style={{ width: 20, height: 20, borderRadius: "50%", background: "var(--panel2)", color: "var(--t3)",
          display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 8, fontWeight: 700,
          border: "2px solid var(--bg)", marginLeft: -6 }}>+{extra}</span>
      )}
    </span>
  );
}

function EventRow({ g, ownTree }: { g: MeetingGroup; ownTree: string[] | null }) {
  const m = g.current;
  const nav = usePreviewPinTab<HTMLDivElement>(meetingTab(m));
  const hasOwnBrief = !m.workspace_id && !!ownTree
    && !!findBriefNote(ownTree, { title: label(m), nativeId: m.native_id });
  const dev = deviationPhrase(g, hasOwnBrief);
  return (
    <div onClick={nav.onClick} onDoubleClick={nav.onDoubleClick}
      style={{ display: "flex", alignItems: "baseline", gap: 9, padding: "3px 2px", cursor: "pointer", flexWrap: "wrap" }}>
      <span style={{ width: 3, height: 14, borderRadius: 2, alignSelf: "center", flex: "none",
        background: g.phase === "live" ? "var(--green)" : "var(--panel2)" }} />
      <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--t1)", minWidth: 0,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label(m)}</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--t3)", flex: "none" }}>{timeShort(m.scheduled_at)}</span>
      {dev && (
        <span style={{ fontSize: 12, color: toneColor[dev.tone], borderBottom: `1px dotted ${toneColor[dev.tone]}`, flex: "none" }}>
          {dev.text}
        </span>
      )}
    </div>
  );
}

function DayRow({ day, isToday, ownTree }: { day: AgendaDay; isToday: boolean; ownTree: string[] | null }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "clamp(52px, 15vw, 64px) 1fr", gap: "0 clamp(8px, 2vw, 14px)", padding: "11px clamp(10px, 2.5vw, 14px)",
      borderTop: "1px solid var(--line)" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
        <span style={{ fontSize: 19, fontWeight: 600, color: "var(--t1)", fontVariantNumeric: "tabular-nums" }}>
          {day.date.getDate()}
        </span>
        <span style={{ fontSize: 10, color: "var(--t3)", lineHeight: 1.3 }}>
          {day.date.toLocaleString(undefined, { month: "long" })}
          {isToday && <span style={{ display: "inline-block", width: 4, height: 4, borderRadius: "50%", background: "var(--accent)", marginLeft: 3, verticalAlign: 4 }} />}
          <br />{day.date.toLocaleString(undefined, { weekday: "short" })}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        {day.groups.length === 0
          ? <span style={{ fontSize: 12.5, color: "var(--t3)", padding: "2px 0" }}>No events today</span>
          : day.groups.map((g) => <EventRow key={g.key} g={g} ownTree={ownTree} />)}
      </div>
    </div>
  );
}

function PastLine({ m }: { m: MeetingMock }) {
  const [line, setLine] = useState<string>("");
  useEffect(() => {
    let on = true;
    if (!m.has_recording) { setLine(""); return; }
    fetchDurableTranscript(m.id)
      .then((t) => {
        if (!on) return;
        if (t.notes.length) setLine(`${t.notes.length} notes`);
        else if (t.lines?.length) setLine(`${t.lines.length} lines`);
      })
      .catch(() => {});
    return () => { on = false; };
  }, [m.id, m.has_recording]);
  const dur = (() => {
    if (!m.start_time || !m.end_time) return "";
    const min = Math.round((new Date(m.end_time).getTime() - new Date(m.start_time).getTime()) / 60000);
    return min > 0 ? `${min}m` : "";
  })();
  const when = m.start_time
    ? new Date(m.start_time).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
  return <>{[when, dur, line].filter(Boolean).join(" · ")}</>;
}

function PlatformBadge({ platform }: { platform?: string }) {
  const p = (platform || "").toLowerCase();
  let label = "M";
  let bg = "var(--panel2)";
  let color = "var(--t2)";
  let title = "Meeting";
  let logoSrc = "";
  let logoBackground: string | undefined;

  if (p.includes("google") || p.includes("meet")) {
    logoSrc = "/platform-logos/google-meet.svg";
    title = "Google Meet";
  } else if (p.includes("zoom")) {
    logoSrc = "/platform-logos/zoom.png";
    title = "Zoom";
  } else if (p.includes("team")) {
    logoSrc = "/platform-logos/microsoft-teams.png";
    title = "Microsoft Teams";
  } else if (p.includes("discord")) {
    logoSrc = "/platform-logos/discord.svg";
    logoBackground = "#5865f2";
    color = "#ffffff";
    title = "Discord";
  }

  return (
    <span
      title={title}
      role="img"
      aria-label={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 18,
        height: 18,
        borderRadius: 4,
        background: logoBackground ?? (logoSrc ? "transparent" : bg),
        color,
        fontSize: 10,
        fontWeight: 700,
        fontFamily: "var(--mono)",
        flex: "none",
        lineHeight: 1,
      }}
    >
      {logoSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoSrc} alt="" aria-hidden="true" width={18} height={18} style={{ display: "block", width: "100%", height: "100%", objectFit: "contain" }} />
      ) : label}
    </span>
  );
}

function PastRow({ e, reviewedIds }: { e: PastEntry; reviewedIds: Set<string> }) {
  const run = e.run;
  const layout = useService(LayoutServiceId);
  const [hovered, setHovered] = useState(false);
  const open = () => { markReviewed(run.id); layout.openTab(meetingTab(run)); };
  const unreviewed = !reviewedIds.has(run.id);
  const meetingTitle = label(run);

  const askAgent = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    markReviewed(run.id);
    window.dispatchEvent(
      new CustomEvent(ASK_CHAT_EVENT, {
        detail: {
          prompt: `What were the key takeaways, decisions, and action items from "${meetingTitle}"?`,
          focus: meetingFocusFor(run),
        },
      })
    );
  };

  return (
    <div
      onClick={open}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        alignItems: "center",
        gap: 10,
        padding: "6px 8px",
        borderRadius: 7,
        cursor: "pointer",
        background: hovered ? "var(--panel)" : "transparent",
        transition: "background .12s ease",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, flex: "none" }}>
        <PlatformBadge platform={run.platform} />
        <Faces m={run.attendees?.length ? run : e.group.current} />
      </div>
      <span style={{ display: "flex", gap: 9, alignItems: "center", minWidth: 0, overflow: "hidden" }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {meetingTitle}
        </span>
        {run.has_recording ? (
          <span
            style={{
              fontSize: 11,
              fontWeight: 500,
              padding: "1px 6px",
              borderRadius: 4,
              background: unreviewed ? "var(--accentbg)" : "var(--panel2)",
              color: unreviewed ? "var(--accent)" : "var(--t3)",
              border: `1px solid ${unreviewed ? "var(--accent)" : "var(--line)"}`,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              flex: "none",
            }}
          >
            {unreviewed && <span style={{ width: 4, height: 4, borderRadius: "50%", background: "currentColor" }} />}
            {unreviewed ? "recap ready" : "recap"}
          </span>
        ) : (
          <span style={{ fontSize: 11, color: "var(--t3)", flex: "none" }}>
            nothing captured
          </span>
        )}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
        {hovered && run.has_recording && (
          <button
            type="button"
            title="Ask agent about this meeting"
            onClick={askAgent}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11,
              fontWeight: 500,
              color: "var(--t1)",
              background: "var(--panel2)",
              border: "1px solid var(--line2)",
              borderRadius: 5,
              padding: "2px 7px",
              cursor: "pointer",
              transition: "all .12s ease",
            }}
            onMouseEnter={(ev) => {
              ev.currentTarget.style.borderColor = "var(--accent)";
              ev.currentTarget.style.color = "var(--accent)";
            }}
            onMouseLeave={(ev) => {
              ev.currentTarget.style.borderColor = "var(--line2)";
              ev.currentTarget.style.color = "var(--t1)";
            }}
          >
            <Icon name="spark" size={11} />
            <span>Ask agent</span>
          </button>
        )}
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--t3)" }}>
          <PastLine m={run} />
        </span>
      </div>
    </div>
  );
}

// ── the tab ───────────────────────────────────────────────────────────────────────────────────
function TodayView() {
  const meetings = useLiveMeetings();
  const reviewedIds = useReviewed();
  const ownTree = useOwnWorkspaceTree();
  const [weekOffset, setWeekOffset] = useState(0);
  const now = new Date();
  const groups = groupMeetings(meetings);
  const days = agendaWindow(groups, now, weekOffset);
  const past = pastFeed(groups);
  const todayKey = dayKey(now);
  const empty = meetings.length === 0;
  const pager = {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    color: "var(--t2)",
    borderRadius: 6,
    width: 26,
    height: 26,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "background .12s, border-color .12s, color .12s",
  } as const;
  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "20px clamp(16px, 3vw, 32px)" }}>
      <div style={{ maxWidth: 800, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--display, var(--font-display, Georgia, serif))", fontSize: 18, fontWeight: 600, letterSpacing: "-0.015em", color: "var(--t1)", flex: 1, minWidth: 120 }}>
            Coming up
          </span>
          {weekOffset > 0 && (
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--t3)" }}>
              {days[0]?.date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) ?? ""} →
            </span>
          )}
          <button
            aria-label="previous week"
            style={{ ...pager, opacity: weekOffset === 0 ? 0.35 : 1 }}
            disabled={weekOffset === 0}
            onClick={() => setWeekOffset((v) => Math.max(0, v - 1))}
            onMouseEnter={(e) => { if (weekOffset > 0) { e.currentTarget.style.background = "var(--panel2)"; e.currentTarget.style.color = "var(--t1)"; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--panel)"; e.currentTarget.style.color = "var(--t2)"; }}
          >
            <Icon name="chevL" size={13} />
          </button>
          <button
            aria-label="next week"
            style={pager}
            onClick={() => setWeekOffset((v) => Math.min(8, v + 1))}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--panel2)"; e.currentTarget.style.color = "var(--t1)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--panel)"; e.currentTarget.style.color = "var(--t2)"; }}
          >
            <Icon name="chevR" size={13} />
          </button>
        </div>

        {empty ? (
          /* user onboarding, frame 4: three paths (calendar primary / plan / drop bot) */
          <MeetingsOnboarding variant="full" />
        ) : (
          <>
            {/* the STANDING calendar affordance — stays while this user has no calendar connected */}
            <MeetingsOnboarding variant="slim" />
            <div style={{ marginTop: 14, border: "1px solid var(--line)", borderRadius: 12, background: "var(--panel)" }}>
              {days.length === 0
                ? <div style={{ padding: "14px 16px", fontSize: 12.5, color: "var(--t3)" }}>Nothing this week.</div>
                : days.map((d) => <DayRow key={d.key} day={d} isToday={d.key === todayKey} ownTree={ownTree} />)}
            </div>
          </>
        )}

        {past.map((day) => (
          <div key={day.key}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase",
              color: "var(--t3)", margin: "18px 0 4px" }}>
              {day.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
            </div>
            {day.entries.map((e) => <PastRow key={e.run.id} e={e} reviewedIds={reviewedIds} />)}
          </div>
        ))}

        {!empty && (
          <div style={{ fontSize: 11.5, color: "var(--t3)", margin: "24px 2px 10px", lineHeight: 1.5 }}>
            Older meetings live in Knowledge — ask the agent about anything that was said or decided.
          </div>
        )}
      </div>
    </div>
  );
}

registerTab("today", TodayView);
