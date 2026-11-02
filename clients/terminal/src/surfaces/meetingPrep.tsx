"use client";
/** Meeting-prep tab (center) — a PLANNED meeting's home while it hasn't happened yet.
 *
 *  Opens when a row in an intent status (`idle`/`scheduled`) is clicked. Everything here edits the
 *  SAME meetings row the bot will later claim: title / time / link (PATCH by row id), the auto-join
 *  toggle, and the WORKSPACE BIND — the sharing mechanism (members of the bound workspace see this
 *  meeting, its live feed, and later its transcript). "Share" mints a workspace invite link; the
 *  prep JTBD is: bind (or create) a prep workspace → research into it with the agent → share it
 *  with the people you're meeting → the bot auto-joins at start → notes land on the same row.
 *  Once the row leaves the intent statuses the row click routes to the live meeting tab instead. */
import { useEffect, useMemo, useRef, useState } from "react";
import { registerTab, type TabProps } from "../contributions";
import { useService } from "../platform";
import { LayoutServiceId } from "../workbench/layout";
import { Icon } from "../ui-kit";
import { MdxDoc } from "../ui-kit/MdxDoc";
import { DateTimePicker } from "../ui-kit/DateTimePicker";
import { copyText } from "../ui-kit/ContextMenu";
import { useLiveMeetings, refreshMeetings } from "./liveMeetings";
import type { MeetingMock } from "./meetingModel";
import { presentError, readApiFailure } from "./apiClient";
import { resolveJoinError, type ServiceDenialPresentation } from "./serviceDenial";
import { ServiceDenialPanel } from "./ServiceDenialPanel";
import { createPlannedMeeting, updatePlannedMeeting, deletePlannedMeeting, type PlannedMeetingRow } from "./plannedApi";
import { createSharedWorkspace, listSharedMemberships, listWorkspaceTree, mintInvite, readWorkspaceFile, readActiveSet, type Membership } from "./workspaceApi";
import { briefNotePath, findBriefNote, isExampleNote } from "./briefNote";
import { meetingFocusFor } from './chatContext';
import { manageTabDescriptor } from "./workspaceManage";
import { defaultBotName } from "./defaultBotName";
import { meetingUrlFor } from "./meetingId";
import { requestChat } from "../canvas/actions";

const field = {
  fontSize: 12.5, padding: "6px 8px", background: "var(--panel)", border: "1px solid var(--line)",
  borderRadius: 7, color: "var(--t1)", outline: "none",
} as const;
const label = { fontSize: 10.5, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 600 } as const;

/** THE BRIEF (prep-v3, owner-locked): the workspace README rendered as the page's stage — ONE doc,
 *  team-facing, always the next occurrence's brief. A SEEDED stub never renders as content (bloat
 *  law 3); missing/seeded → honest empty state whose CTA names its output. The interview itself
 *  happens in the chat rail (no question UI here) — this block is the RESULT of that dialogue. */
// slug-aware doc tab (same shape as workspace.tsx docTab): opens a file from the BOUND workspace.
const wsDocTab = (slug: string, path: string, title?: string) =>
  ({ id: `doc:${slug}:${path}`, title: title ?? (path.split("/").pop() ?? path), kind: "doc", params: { path, slug } });

const SEED_README_MARK = "This is your **Personal workspace**";

function Brief({ slug, title, meeting }: { slug: string; title: string; meeting: MeetingMock }) {
  const layout = useService(LayoutServiceId);
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<"readme" | "none" | "loading">("loading");
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    let serial = 0;
    setState("loading"); setText(null); setError('');
    const load = () => {
      const ticket = ++serial;
      return readWorkspaceFile("README.md", { slug })
      .then((t) => {
        if (!alive || ticket !== serial) return;
        setError('');
        // a fresh workspace's seeded README is system exhaust, not a brief
        if (!t || !t.trim() || t.slice(0, 400).includes(SEED_README_MARK)) setState("none");
        else { setText(t); setState("readme"); }
      })
      .catch(() => { if (alive && ticket === serial) setError('Could not read the shared brief. Retry by returning to this window.'); });
    };
    void load();
    const refresh = () => { if (document.visibilityState === 'visible') void load(); };
    const interval = window.setInterval(refresh, OWN_BRIEF_POLL_MS);
    window.addEventListener('focus', refresh);
    return () => { alive = false; window.clearInterval(interval); window.removeEventListener('focus', refresh); };
  }, [slug]);
  const askForBrief = () => {
    try {
      requestChat({ focus: { ...meetingFocusFor(meeting), workspace_id: slug }, prompt: `Prepare the brief for "${title}" in the ${slug} workspace README — who's attending (research them in our records), what happened last time, open follow-ups, and a suggested agenda. Read and update the existing README, preserving user edits. Ask me what you can't know from records.` });
      setError('');
    } catch (e) { setError((e as Error).message); }
  };
  if (state === "loading") return error ? <p role="alert">{error}</p> : null;
  if (state === "none" || !text) {
    return (
      <div style={{ margin: "18px 0 0", padding: "16px 18px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--subtle)", fontSize: 12.5, color: "var(--t3)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        {error && <p role="alert">{error}</p>}
        <span style={{ flex: 1, minWidth: 200, color: "var(--t2)" }}>No brief yet.</span>
        <button onClick={askForBrief} style={{ background: "var(--accent)", color: "var(--on-accent)", border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", flex: "none", boxShadow: "0 2px 8px rgba(67, 210, 121, 0.25)" }}>
          Draft the brief — attendees, last time, open items, agenda
        </button>
      </div>
    );
  }
  return (
    <div style={{ margin: "18px 0 0", border: "1px solid var(--line)", borderRadius: 6, background: "var(--panel)" }}>
      {error && <p role="alert">{error}</p>}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px 0" }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--green)", flex: "none" }} />
        <span style={{ fontSize: 10, color: "var(--t3)", letterSpacing: ".08em", fontFamily: "var(--mono)" }}>
          team brief · workspace README
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={() => layout.openTab(wsDocTab(slug, "README.md"))}
          title="Open as a document" style={{ background: "none", border: "none", color: "var(--t3)", fontSize: 11, cursor: "pointer", padding: 0 }}>
          open
        </button>
        <button onClick={askForBrief} title="Steer the brief in chat"
          style={{ background: "none", border: "none", color: "var(--t3)", fontSize: 11, cursor: "pointer", padding: 0 }}>
          update via chat
        </button>
      </div>
      <div style={{ padding: "4px 16px 12px", maxHeight: 460, overflow: "auto" }}>
        <MdxDoc style={{ fontSize: 13, lineHeight: 1.55 }}>{text}</MdxDoc>
      </div>
    </div>
  );
}

/** Own-workspace brief (frame 6, owner-ruled 2026-07-09): with NO shared workspace bound, the brief
 *  is this meeting's note in the user's OWN workspace — and the prep page renders it LIVE while the
 *  brief chat writes it, instead of sitting on the "No brief yet" state. Polls the own-workspace
 *  tree (short interval while the tab is up — agents write mid-chat) and re-reads the note. */
const OWN_BRIEF_POLL_MS = 12_000;
interface OwnBriefNote { path: string; text: string; slug: string; workspacePath: string }

function useOwnBriefNote(enabled: boolean, title: string, nativeId?: string | null, meetingId?: string) {
  const [note, setNote] = useState<OwnBriefNote | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setNote(null); setError('');
    if (!enabled) return;
    let alive = true;
    let serial = 0;
    const look = async () => {
      const ticket = ++serial;
      try {
        const mounts = (await readActiveSet()).active.filter(mount => mount.role === 'private' && mount.write);
        const trees = await Promise.all(mounts.map(async mount => ({ mount, files: await listWorkspaceTree({ slug: mount.slug }) })));
        const canonical = [briefNotePath({ meetingId }), briefNotePath({ meetingId, nativeId })];
        const rank = (files: string[]) => { const position = canonical.findIndex(path => files.includes(path)); return position < 0 ? 2 : position; };
        const ordered = trees.sort((a, b) => rank(a.files) - rank(b.files));
        for (const { mount, files } of ordered) {
          const path = findBriefNote(files, { title, nativeId, meetingId });
          if (!path) continue;
          const text = await readWorkspaceFile(path, { slug: mount.slug });
          if (!text?.trim() || isExampleNote(text)) continue;
          if (alive && ticket === serial) { setNote({ path, text, slug: mount.slug, workspacePath: mount.path }); setError(''); }
          return;
        }
        if (alive && ticket === serial) { setNote(null); setError(''); }
      } catch { if (alive && ticket === serial) setError('Could not check your brief. Retry by returning to this window.'); }
    };
    void look();
    const refresh = () => { if (document.visibilityState === 'visible') void look(); };
    const t = setInterval(refresh, OWN_BRIEF_POLL_MS);
    window.addEventListener('focus', refresh);
    return () => { alive = false; clearInterval(t); window.removeEventListener('focus', refresh); };
  }, [enabled, title, nativeId, meetingId]);
  return { note, error };
}

function OwnBrief({ note, onSteer }: { note: OwnBriefNote; onSteer: () => void }) {
  const layout = useService(LayoutServiceId);
  return (
    <div style={{ margin: "18px 0 0", border: "1px solid var(--line)", borderRadius: 6, background: "var(--panel)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px 0" }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--green)", flex: "none" }} />
        <span style={{ fontSize: 10, color: "var(--t3)", letterSpacing: ".08em", fontFamily: "var(--mono)" }}>
          your brief · this meeting&rsquo;s note
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={() => layout.openTab(wsDocTab(note.slug, note.path))}
          title="Open as a document" style={{ background: "none", border: "none", color: "var(--t3)", fontSize: 11, cursor: "pointer", padding: 0 }}>
          open
        </button>
        <button onClick={onSteer} title="Steer the brief in chat"
          style={{ background: "none", border: "none", color: "var(--t3)", fontSize: 11, cursor: "pointer", padding: 0 }}>
          update via chat
        </button>
      </div>
      <div style={{ padding: "4px 16px 12px", maxHeight: 460, overflow: "auto" }}>
        <MdxDoc style={{ fontSize: 13, lineHeight: 1.55 }}>{note.text}</MdxDoc>
      </div>
    </div>
  );
}

// A synthetic empty PLANNED meeting for a DRAFT tab — no backend row yet. Idle intent so the prep
// form renders; every field empty. Replaced by the real row the moment lazy-create fires.
const DRAFT_M: MeetingMock = {
  id: "", title: "", when: "", status: "past", live_status: "idle", platform: "Google Meet",
  participants: [], mentioned: [], actions: [], transcript: [], insights: [],
};

function MeetingPrepTab({ params }: TabProps) {
  const layout = useService(LayoutServiceId);
  const all = useLiveMeetings();
  const meetingId = String(params.meetingId ?? "");
  const isDraft = !meetingId && !!params.draft;   // "+ Plan a meeting" tab, no row created yet
  const found: MeetingMock | undefined = meetingId ? all.find((x) => x.id === meetingId) : undefined;
  // In a draft tab, render against the empty placeholder until the row is created (then we hand off
  // to the canonical prep:<id> tab). A real tab whose row hasn't loaded yet shows "Loading…" below.
  const m: MeetingMock | undefined = found ?? (isDraft ? DRAFT_M : undefined);
  const readOnly = !!m?.shared;
  const isIntent = m?.live_status === "idle" || m?.live_status === "scheduled";

  const [title, setTitle] = useState("");
  const [link, setLink] = useState("");
  // lazy row creation: a draft creates its backend row on the FIRST real input, passing whatever the
  // user has typed, then hands the tab off to prep:<id>. `creating` guards against a double-create
  // from two near-simultaneous inputs; `mounted` guards setState after the handoff unmounts us.
  const creating = useRef(false);
  const createdRow = useRef<PlannedMeetingRow | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const ensureRow = async (): Promise<string | null> => {
    if (meetingId) return meetingId;               // already a real row
    if (creating.current) return null;             // a create is already in flight
    creating.current = true;
    try {
      const row = await createPlannedMeeting({
        title: title.trim() || undefined,
        meeting_url: link.trim() || undefined,
      });
      createdRow.current = row;
      const id = String(row.id);
      refreshMeetings();
      // hand off: the canonical prep tab owns the created meeting; the draft tab closes.
      layout.openTab(prepTabDescriptor({ id, title: title.trim() || "New meeting" }));
      layout.closeTab(PREP_DRAFT_TAB_ID);
      return id;
    } finally { creating.current = false; }
  };
  // seed marker is the MEETING ID, not a boolean: the shared preview panel swaps params to a
  // DIFFERENT meeting without remounting — a boolean kept the previous meeting's title/link on
  // screen, and a blur would PATCH them onto the wrong row (observed live 2026-07-08).
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A refused Join renders as its own in-flow panel, not as the generic one-line error.
  const [denial, setDenial] = useState<ServiceDenialPresentation | null>(null);
  const [shares, setShares] = useState<Membership[]>([]);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);       // ⋯ row: link edit / unbind / delete
  const [rebindOpen, setRebindOpen] = useState(false);   // "change" → the bind select
  const [briefChatStarted, setBriefChatStarted] = useState(false); // own-brief interview dispatched
  useEffect(() => { setBriefChatStarted(false); }, [meetingId]);

  // seed the form once PER MEETING (live refreshes must not clobber in-progress edits; a
  // preview swap to another meeting must re-seed)
  useEffect(() => {
    if (!m || seededFor === m.id) return;
    setTitle(m.title_custom ?? "");
    setLink(m.meeting_url ?? "");
    setSeededFor(m.id);
  }, [m, seededFor]);

  useEffect(() => {
    void listSharedMemberships()
      .then((ms) => setShares(ms.filter((s) => s.role === "owner" || s.role === "contributor")))
      .catch(() => {});
  }, []);

  const patch = async (body: Parameters<typeof updatePlannedMeeting>[1]) => {
    if (!m || readOnly) return;
    setBusy(true); setErr(null);
    try {
      const id = await ensureRow();               // draft → create the row first (with title/link)
      if (!id) return;
      await updatePlannedMeeting(id, body); refreshMeetings();
    }
    catch (e) { if (mounted.current) setErr(presentError(e).headline); }
    finally { if (mounted.current) setBusy(false); }
  };

  const sendNow = async () => {
    if (!m?.native_id) return;
    setBusy(true); setErr(null); setDenial(null);
    try {
      const platformSlug = m.platform === "Google Meet" ? "google_meet" : m.platform.toLowerCase().replace(/\s+/g, "_");
      const r = await fetch("/api/bots", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: platformSlug, native_meeting_id: m.native_id, ...(m.meeting_url ? { meeting_url: meetingUrlFor({ platform: platformSlug, native_meeting_id: m.native_id }, m.meeting_url) } : {}), bot_name: defaultBotName() }),
      });
      // The body used to be read as raw TEXT and rethrown as a bare Error, so a denial payload
      // reached the presenter JSON-shaped and came out as "Something went wrong". Read it as the
      // typed ApiError instead, so 403 service_not_allowed can be told from a permissions fault.
      if (!r.ok) throw await readApiFailure(r, "/api/bots");
      refreshMeetings();
    } catch (e) {
      const state = resolveJoinError(e);
      if (state.kind === "denial") setDenial(state.presentation);
      else setErr(state.headline);
    }
    finally { setBusy(false); }
  };

  const share = async () => {
    if (!m?.workspace_id) return;
    setBusy(true); setErr(null);
    try {
      const inv = await mintInvite({ workspace_id: m.workspace_id, role: "contributor", mode: "open", expires_in_sec: 7 * 86400, max_uses: 50 });
      setInviteLink(`${window.location.origin}/?invite=${inv.token}`);
    } catch (e) { setErr(presentError(e).headline); }
    finally { setBusy(false); }
  };

  const createAndBind = async () => {
    if (!m) return;
    setBusy(true); setErr(null);
    try {
      const id = await ensureRow();               // draft → create the row first
      if (!id) return;
      const name = (m.title_custom || title || "meeting-prep").slice(0, 60);
      const ws = await createSharedWorkspace(name);
      await updatePlannedMeeting(id, { workspace_id: ws.workspace_id });
      refreshMeetings();
      // Creating the shared workspace IS a scaffolding run (prep-v3 ruling, owner 2026-07-09):
      // the agent must know the workspace is brand-new and exists to collaborate with the other
      // participants around this meeting — its README is the team brief. Any brief already built
      // in the user's own workspace is the starting point, not discarded.
      const carry = ownBrief
        ? ` I already have a brief for this meeting in my own workspace at ${ownBrief.workspacePath}/${ownBrief.path} — carry its content over as the starting brief, then keep improving it.`
        : "";
      requestChat({ focus: { ...meetingFocusFor({ ...m, id, live_status: 'idle' }), workspace_id: ws.workspace_id },
        prompt: `I just created the shared workspace "${ws.workspace_id}" for the meeting "${m.title_custom || title || headline}" — it is brand-new (empty) and exists so the other participants and I can collaborate on this meeting and its series. Scaffold it now: write its README as the team brief (audience = everyone in the room, so keep my private context out unless I confirm it), set up whatever structure the series needs, and interview me for what you can't know from my records.${carry} Write early and keep updating as we talk — the README renders live on the meeting page.` });
    } catch (e) { if (mounted.current) setErr(presentError(e).headline); }
    finally { if (mounted.current) setBusy(false); }
  };

  // Frame 6 (first-run-onboarding): brief WITHOUT sharing — the agent interviews the user in
  // chat (the prep tab's meeting grounding rides the turn) and writes the brief into their OWN
  // workspace, so it follows the series without creating a shared space. Starting the brief is a real
  // commitment → create the draft's row first (so the note keys to a real meeting and reuses across it).
  const startBriefChat = async () => {
    setBusy(true); setErr(null);
    try {
      const id = await ensureRow();
      if (!id) return;
      // re-read the row so the note filename can key to its native id if a link was set
      const row = all.find((x) => x.id === id);
      const name = row?.title_custom || title || row?.title || 'this meeting';
      const created = createdRow.current?.id === Number(id) ? createdRow.current : null;
      const nid = row?.native_id || created?.native_meeting_id;
      const mounts = (await readActiveSet()).active.filter(mount => mount.role === 'private' && mount.write);
      const mount = ownBrief ? mounts.find(mount => mount.slug === ownBrief.slug) : mounts.find(mount => mount.primary) || mounts[0];
      if (!mount) throw new Error('Enable a private writable workspace before starting a private brief.');
      const path = ownBrief?.path || briefNotePath({ meetingId: id, nativeId: nid });
      requestChat({ focus: { ...meetingFocusFor({ ...(row || m!), id, native_id: nid || undefined, live_status: 'idle' }), scheduled_at: row?.scheduled_at },
        prompt: `Interview me to build the brief for ${JSON.stringify(name)} — ask what you can't know from my records (who's in the room, what I want out of it, what the notetaker should listen for), research attendees in my knowledge and public sources. Write the brief at EXACTLY ${JSON.stringify(`${mount.path}/${path}`)} in my PRIVATE workspace ${JSON.stringify(mount.slug)}. Do not write this private brief into any shared workspace. For a NEW file use frontmatter type: meeting, id: ${JSON.stringify(path.split('/').pop()!.replace(/\.md$/, ''))}, title: ${JSON.stringify(name)}, and meeting_id: ${id}. Read the existing file first and preserve user edits and frontmatter; continue it rather than replacing it. Write the note EARLY and keep updating it as we talk — this exact file renders live on the meeting page.` });
      if (mounted.current) setBriefChatStarted(true);
    } catch (e) { if (mounted.current) setErr(presentError(e).headline); }
    finally { if (mounted.current) setBusy(false); }
  };

  const remove = async () => {
    if (!m) return;
    if (isDraft) { layout.closeTab(PREP_DRAFT_TAB_ID); return; }   // nothing persisted — just discard the draft
    if (typeof window !== "undefined" && !window.confirm("Delete this planned meeting?")) return;
    setBusy(true);
    try { await deletePlannedMeeting(m.id); refreshMeetings(); layout.closeTab(`prep:${m.id}`); }
    catch (e) { setErr(presentError(e).headline); }
    finally { setBusy(false); }
  };

  const autoJoin = m?.auto_join !== false;   // absent = ON
  const headline = useMemo(() => m?.title_custom || m?.title || "Planned meeting", [m]);
  // own-workspace brief (frame 6): only hunted while the meeting is unbound — a bound workspace's
  // README is the brief and wins.
  // No brief hunt on a draft (no row/title yet) — it would match nothing or the wrong note.
  const { note: ownBrief, error: briefError } = useOwnBriefNote(!isDraft && !!m && !m.workspace_id && !readOnly && isIntent, headline, m?.native_id, meetingId);

  // B2 tab hygiene: a calendar sweep DELETES + recreates rows (new ids) — a tab keyed to the old
  // row would dangle on "Loading meeting…" forever. Once the store has data and the row is gone,
  // the tab closes itself (the meeting lives on under its new row, reachable from Today).
  // Grace: only self-close a row we have ACTUALLY SEEN (then lost). A just-created tab whose row
  // hasn't loaded into the store yet (the draft → prep:<id> hand-off) must NOT close — it loads in.
  const everSeen = useRef(false);
  useEffect(() => { if (found) everSeen.current = true; }, [found]);
  const rowGone = !isDraft && !!meetingId && everSeen.current && all.length > 0 && !found;
  useEffect(() => {
    if (rowGone) layout.closeTab(`prep:${meetingId}`);
  }, [rowGone, layout, meetingId]);

  if (!m) {
    return <div style={{ padding: 32, fontSize: 13, color: "var(--t3)" }}>Loading meeting…</div>;
  }
  if (!isIntent) {
    return (
      <div style={{ padding: 32, fontSize: 13, color: "var(--t2)", lineHeight: 1.6 }}>
        This meeting has started — open it from the Meetings list to see the live view.
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: "100%", overflow: "auto", boxSizing: "border-box", padding: "28px 32px" }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        {/* TITLE SECTION */}
        <div style={{ marginBottom: 24 }}>
          <span style={{ display: "block", fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--t3)", marginBottom: 8, fontWeight: 600 }}>
            Meeting Subject & Objective
          </span>
          {readOnly ? (
            <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: "var(--t1)" }}>{headline}</h2>
          ) : (
            <input value={title} disabled={busy} placeholder="What's this meeting about?"
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => { if ((m.title_custom ?? "") !== title.trim()) void patch({ title: title.trim() || null }); }}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
              style={{ display: "block", width: "100%", boxSizing: "border-box", margin: 0, padding: "4px 0 10px",
                fontSize: 22, fontWeight: 600, color: "var(--t1)", background: "transparent", border: "none",
                borderBottom: "1px solid var(--line)", outline: "none" }} />
          )}
        </div>

        {m.auto_join_error && (
          <div role="alert" style={{ margin: "0 0 14px", padding: "8px 12px", borderRadius: 8, background: "var(--dangerbg)", color: "var(--danger)", fontSize: 12.5, lineHeight: 1.5 }}>
            ⚠ Auto-join failed: {m.auto_join_error}
          </div>
        )}

        {/* ── 2-Column Instrument Cards: Meeting Link & Scheduled Time ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 18 }}>
          {/* Card 1: Meeting Link */}
          <div style={{ background: "var(--subtle)", border: "1px solid var(--line)", borderRadius: 6, padding: "16px 18px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, paddingBottom: 8, borderBottom: "1px solid var(--line)" }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: ".06em", color: "var(--t2)", fontWeight: 600, textTransform: "uppercase" }}>Meeting Link</span>
              {m.native_id && (
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent)", display: "flex", alignItems: "center", gap: 5 }}>
                  <Icon name="check" size={12} style={{ color: "var(--accent)" }} />
                  DETECTED
                </span>
              )}
            </div>

            <div style={{ marginBottom: 12 }}>
              <input value={link} disabled={busy || readOnly} placeholder="https://meet.google.com/…"
                onChange={(e) => setLink(e.target.value)}
                onBlur={() => { if ((m.meeting_url ?? "") !== link.trim()) void patch({ meeting_url: link.trim() || null }); }}
                style={{ width: "100%", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 6, color: "var(--t1)", fontFamily: "var(--sans)", fontSize: 12.5, padding: "7px 10px", outline: "none", boxSizing: "border-box" }}
              />
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 4 }}>
              {!readOnly && (
                <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--t2)", cursor: "pointer", userSelect: "none" }}>
                  <input type="checkbox" checked={autoJoin} disabled={busy}
                    onChange={(e) => void patch({ auto_join: e.target.checked })} />
                  Auto-join{!m.native_id && <span style={{ color: "var(--t3)", fontSize: 11 }}>(needs a link)</span>}
                </label>
              )}
              {m.meeting_url && (
                <a href={m.meeting_url} target="_blank" rel="noreferrer"
                  style={{ background: "var(--accent)", color: "var(--on-accent)", borderRadius: 6, padding: "5px 12px", fontSize: 12, fontWeight: 600, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}>
                  Open meeting
                </a>
              )}
            </div>
          </div>

          {/* Card 2: Scheduled Time */}
          <div style={{ background: "var(--subtle)", border: "1px solid var(--line)", borderRadius: 6, padding: "16px 18px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, paddingBottom: 8, borderBottom: "1px solid var(--line)" }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: ".06em", color: "var(--t2)", fontWeight: 600, textTransform: "uppercase" }}>Scheduled Time</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: m.scheduled_at ? "var(--accent)" : "var(--t3)" }}>
                {m.scheduled_at ? "SCHEDULED" : "IMMEDIATE JOIN"}
              </span>
            </div>

            <div style={{ marginBottom: 12 }}>
              <DateTimePicker
                value={m.scheduled_at}
                disabled={readOnly || busy}
                placeholder="Pick a date & time"
                onChange={(iso) => void patch({ scheduled_at: iso })}
                onClear={() => void patch({ scheduled_at: null })}
              />
            </div>

            <div style={{ fontSize: 11, color: "var(--t3)", fontFamily: "var(--mono)", display: "flex", alignItems: "center", gap: 6, paddingTop: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: m.scheduled_at ? "var(--accent)" : "var(--t3)", flexShrink: 0 }} />
              <span>{m.scheduled_at ? "Auto-joins when meeting starts" : "No schedule set — joins immediately when ready"}</span>
            </div>
          </div>
        </div>

        {/* ── attendees (calendar ATTENDEE lines → data.attendees, prep-v3 slice b) ── */}
        {(m.attendees?.length ?? 0) > 0 && (
          <div style={{ margin: "0 0 22px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 8px" }}>
              <span style={label}>Attendees</span>
              <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
            </div>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
              {m.attendees!.map((a) => {
                const display = a.name || a.email;
                const initials = (a.name
                  ? a.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("")
                  : a.email.slice(0, 2)).toUpperCase();
                const declined = a.partstat === "declined";
                return (
                  <span key={a.email} title={a.email + (a.partstat ? ` · ${a.partstat}` : "")}
                    style={{ display: "inline-flex", alignItems: "center", gap: 7,
                      border: "1px solid var(--line)", borderRadius: 14, padding: "2px 11px 2px 3px",
                      fontSize: 12.5, color: declined ? "var(--t3)" : "var(--t1)",
                      textDecoration: declined ? "line-through" : undefined }}>
                    <span style={{ width: 19, height: 19, borderRadius: "50%", background: "var(--panel2)",
                      color: "var(--t2)", display: "inline-flex", alignItems: "center", justifyContent: "center",
                      fontSize: 8.5, fontWeight: 700 }}>{initials}</span>
                    {display}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* ── ONE quiet utility row: workspace · share · send notetaker · ⋯ ── */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0 14px", marginBottom: 14, borderBottom: "1px solid var(--line)", fontSize: 12, color: "var(--t3)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {m.workspace_id ? (
              <span style={{ display: "inline-flex", gap: 6, alignItems: "baseline" }}>
                workspace{" "}
                <button onClick={() => layout.openTab(manageTabDescriptor(m.workspace_id!, { shared: true }))}
                  title={m.workspace_id}
                  style={{ background: "none", border: "none", color: "var(--t1)", fontWeight: 600, fontSize: 12, cursor: "pointer", padding: 0 }}>
                  {m.workspace_id.replace(/-[0-9a-f]{4,}$/i, "")}
                </button>
                {!readOnly && (
                  <button onClick={() => setRebindOpen((v) => !v)}
                    style={{ background: "none", border: "none", color: "var(--t3)", fontSize: 11.5, cursor: "pointer", padding: 0, textDecoration: "underline" }}>
                    change
                  </button>
                )}
              </span>
            ) : (
              <span style={{ fontSize: 11.5, color: "var(--t3)" }}>No shared workspace bound</span>
            )}
            {readOnly && <span style={{ fontSize: 11.5 }}>· shared with you</span>}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {!readOnly && m.workspace_id && (
              <button disabled={busy} onClick={() => void share()}
                style={{ background: "none", border: "none", color: "var(--t2)", fontSize: 12, cursor: "pointer", padding: 0, textDecoration: "underline" }}>
                Share with attendees{(m.attendees?.length ?? 0) > 0 ? ` (${m.attendees!.length})` : ""}
              </button>
            )}
            {!readOnly && (
              <button disabled={busy || !m.native_id} onClick={() => void sendNow()}
                title={m.native_id ? "Send the bot now instead of waiting" : "Attach a meeting link first"}
                style={{
                  background: m.native_id ? "var(--accentbg)" : "var(--panel)",
                  border: `1px solid ${m.native_id ? "var(--accent)" : "var(--line)"}`,
                  color: m.native_id ? "var(--accent)" : "var(--t3)",
                  borderRadius: 6, padding: "6px 14px", fontSize: 12, fontWeight: 600,
                  cursor: m.native_id ? "pointer" : "default",
                  display: "inline-flex", alignItems: "center", gap: 6,
                  transition: "all .15s",
                }}>
                <Icon name="send" size={12} style={{ color: m.native_id ? "var(--accent)" : "var(--t3)" }} />
                Send notetaker now
              </button>
            )}
            {!readOnly && (
              <button onClick={() => setMoreOpen((v) => !v)} title="More — edit link, unbind, delete"
                style={{ background: "transparent", border: "1px solid var(--line)", color: "var(--t3)", borderRadius: 6, width: 28, height: 28, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 14, cursor: "pointer", padding: 0 }}>
                ⋯
              </button>
            )}
          </div>
        </div>

        {rebindOpen && !readOnly && shares.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <select defaultValue="" disabled={busy}
              onChange={(e) => { if (e.target.value) { void patch({ workspace_id: e.target.value }); setRebindOpen(false); } }}
              style={{ ...field, minWidth: 200 }}>
              <option value="" disabled>Bind a different workspace…</option>
              {shares.map((s) => <option key={s.workspace_id} value={s.workspace_id}>{s.workspace_id}</option>)}
            </select>
          </div>
        )}

        {moreOpen && !readOnly && (
          <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 6, padding: "8px 12px" }}>
            {m.workspace_id && (
              <button disabled={busy} onClick={() => { void patch({ workspace_id: null }); setMoreOpen(false); }}
                style={{ background: "transparent", border: "1px solid var(--line)", color: "var(--t3)", borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>
                Unbind workspace
              </button>
            )}
            <button disabled={busy} onClick={() => void remove()}
              style={{ background: "transparent", border: "1px solid var(--danger)", color: "var(--danger)", borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>
              Delete meeting
            </button>
          </div>
        )}

        {inviteLink && (
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <input readOnly value={inviteLink} onFocus={(e) => e.currentTarget.select()} style={{ ...field, flex: 1, fontSize: 11.5 }} />
            <button onClick={() => void copyText(inviteLink)} style={{ fontSize: 12, padding: "4px 12px", background: "var(--accent)", color: "var(--on-accent)", border: "none", borderRadius: 6, cursor: "pointer" }}>Copy</button>
          </div>
        )}

        {/* ── the brief = the stage (prep-v3 carve) ───────────────── */}
        {m.workspace_id ? (
          <Brief key={m.workspace_id} slug={m.workspace_id} title={headline} meeting={m} />
        ) : readOnly ? (
          <div style={{ margin: "18px 0 0", fontSize: 12.5, color: "var(--t3)" }}>No workspace bound.</div>
        ) : ownBrief ? (
          /* the own-workspace note IS the brief — rendered live while the chat writes it */
          <OwnBrief note={ownBrief} onSteer={() => startBriefChat()} />
        ) : briefChatStarted ? (
          <div style={{ margin: "18px 0 0", padding: "14px 18px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--subtle)", display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, color: "var(--t2)" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", flex: "none" }} />
            Brief chat started — the brief renders here once the agent writes it. Follow progress in chat.
          </div>
        ) : (
          /* No-brief state (first-run-onboarding frame 6, owner-ruled): two REAL actions. Brief chat
             = the agent interviews you here (the prep tab's meeting grounding rides the turn) and the
             brief lands in YOUR default workspace, reused across the series. Shared workspace = the
             existing collaborative flow, repositioned as the explicit sharing choice. */
          <div style={{ margin: "18px 0 0", padding: "18px 20px", background: "var(--subtle)", border: "1px solid var(--line)", borderRadius: 6, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--t3)", flex: "none" }} />
              <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--t1)" }}>No brief yet</span>
            </div>
            <div style={{ fontSize: 12.5, color: "var(--t2)", lineHeight: 1.55 }}>
              A brief makes the notetaker useful — who&rsquo;s in the room, what you want out of it, what
              to listen for.
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 4 }}>
              <button disabled={busy} onClick={() => startBriefChat()}
                style={{
                  background: "var(--accent)", color: "var(--on-accent)", border: "none", borderRadius: 6,
                  padding: "8px 18px", fontSize: 12, fontWeight: 700, cursor: "pointer",
                  display: "inline-flex", alignItems: "center", gap: 7,
                  boxShadow: "0 2px 10px rgba(67, 210, 121, 0.25)",
                }}>
                <Icon name="msg" size={13} style={{ color: "var(--on-accent)" }} />
                Start brief chat
              </button>
              <button disabled={busy} onClick={() => void createAndBind()}
                style={{
                  background: "transparent", color: "var(--accent)", border: "1px solid var(--accent)",
                  borderRadius: 6, padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer",
                }}>
                + Create a workspace to share
              </button>
              {shares.length > 0 && (
                <select defaultValue="" disabled={busy} onChange={(e) => { if (e.target.value) void patch({ workspace_id: e.target.value }); }}
                  style={{ ...field, minWidth: 190, color: "var(--t3)", padding: "7px 10px", borderRadius: 6 }}>
                  <option value="" disabled>or bind an existing one…</option>
                  {shares.map((s) => <option key={s.workspace_id} value={s.workspace_id}>{s.workspace_id}</option>)}
                </select>
              )}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--t3)", lineHeight: 1.55, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
              <b style={{ color: "var(--t2)", fontWeight: 600 }}>Brief chat</b> — the agent interviews you and
              writes the brief into your own workspace, reused across this series.{" "}
              <b style={{ color: "var(--t2)", fontWeight: 600 }}>Shared workspace</b> — everyone you invite sees
              the brief and the live transcript the moment they join.
            </div>
          </div>
        )}

        {denial && <ServiceDenialPanel presentation={denial} onRetry={() => void sendNow()} />}
        {err && <div role="alert" style={{ marginTop: 12, fontSize: 12, color: "var(--danger)" }}>⚠ {err}</div>}
        {briefError && <div role="alert" style={{ marginTop: 12, fontSize: 12, color: "var(--danger)" }}>{briefError}</div>}
      </div>
    </div>
  );
}

export const prepTabDescriptor = (m: { id: string; title: string }) =>
  ({ id: `prep:${m.id}`, title: m.title, kind: "meetingPrep", params: { meetingId: m.id } });

// A DRAFT "+ Plan a meeting" tab — no backend row yet. The row is created lazily on the first real
// input (title/link/date, or Start brief chat / Create workspace / bind), then the tab hands off to
// the canonical prep:<id> tab. Abandoning a draft leaves NO empty meeting behind. Stable id so
// repeated "+ Plan a meeting" clicks reuse the one open draft rather than stacking blank tabs.
export const PREP_DRAFT_TAB_ID = "prep:draft";
export const prepDraftTabDescriptor = () =>
  ({ id: PREP_DRAFT_TAB_ID, title: "New meeting", kind: "meetingPrep", params: { meetingId: "", draft: true } });

registerTab("meetingPrep", MeetingPrepTab);
