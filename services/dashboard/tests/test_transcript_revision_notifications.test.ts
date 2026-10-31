import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  snapshot: vi.fn(),
  bootstrap: vi.fn(),
  upsert: vi.fn(),
  currentMeetingId: "42",
  refs: [] as Array<{ current: unknown }>,
  refIndex: 0,
}));
// This hook only needs refs, effects and a WebSocket to exercise its revision delivery path.
vi.mock("react", () => ({
  useRef: (current: unknown) => seams.refs[seams.refIndex++] ??= { current },
  useState: (value: unknown) => [value, vi.fn()],
  useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => void | (() => void)) => { seams.effects.push(effect); },
}));
vi.mock("@/stores/auth-store", () => ({ useAuthStore: (select: (state: unknown) => unknown) => select({ token: "test" }) }));
vi.mock("@/stores/meetings-store", () => {
  const state = { bootstrapTranscripts: seams.bootstrap, upsertTranscriptSegments: seams.upsert, updateMeetingStatus: vi.fn(),
    addChatMessage: vi.fn(), currentMeeting: { id: "42" } };
  return { useMeetingsStore: Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => ({ ...state, currentMeeting: { id: seams.currentMeetingId } }) }) };
});
vi.mock("@/lib/api", () => ({ tinaAPI: { getMeetingWithTranscripts: seams.snapshot } }));

import { useLiveTranscripts } from "@/hooks/use-live-transcripts";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; wasClean: boolean; reason: string }) => void) | null = null;
  close = vi.fn();
  constructor() { Socket.instances.push(this); }
  receive(message: object) { this.onmessage?.({ data: JSON.stringify(message) }); }
}
let dispose: void | (() => void);
beforeEach(() => {
  seams.effects.length = 0;
  seams.snapshot.mockReset().mockResolvedValue({ segments: [] });
  seams.bootstrap.mockClear();
  seams.upsert.mockClear();
  seams.currentMeetingId = "42";
  seams.refs = []; seams.refIndex = 0;
  Socket.instances.length = 0;
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ wsUrl: "ws://test/ws" }) }));
});
afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

async function connect() {
  useLiveTranscripts({ platform: "google_meet", nativeId: "room", meetingId: "42", isActive: false });
  dispose = seams.effects[0]();
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  return Socket.instances[0];
}

describe("post-meeting review revision notifications", () => {
  it("ignores an unmounted meeting bootstrap after the new meeting has loaded", async () => {
    let release!: (data: { segments: object[] }) => void;
    const pending = new Promise<{ segments: object[] }>(done => { release = done; });
    seams.snapshot.mockReturnValueOnce(pending).mockResolvedValue({ segments: [{ text: "meeting B" }] });
    useLiveTranscripts({ platform: "google_meet", nativeId: "room-A", meetingId: "42", isActive: false });
    const closeOld = seams.effects[0]();
    closeOld?.();
    seams.refs = []; seams.refIndex = 0; seams.currentMeetingId = "43";
    useLiveTranscripts({ platform: "google_meet", nativeId: "room-B", meetingId: "43", isActive: false });
    dispose = seams.effects[1]();
    await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
    release({ segments: [{ text: "late meeting A" }] });
    await pending; await Promise.resolve();
    expect(seams.bootstrap).toHaveBeenCalledTimes(1);
    expect(seams.bootstrap).toHaveBeenLastCalledWith([{ text: "meeting B" }]);
    expect(Socket.instances).toHaveLength(1);
  });

  it("resets bootstrap scope when reusing the hook and rejects an older A -> B -> A response", async () => {
    let release!: (data: { segments: object[] }) => void;
    const pending = new Promise<{ segments: object[] }>(done => { release = done; });
    seams.snapshot.mockReturnValueOnce(pending).mockResolvedValueOnce({ segments: [{ text: "meeting B" }] }).mockResolvedValueOnce({ segments: [{ text: "new meeting A" }] });
    useLiveTranscripts({ platform: "google_meet", nativeId: "room-A", meetingId: "42", isActive: false });
    seams.effects[0]()?.();
    seams.refIndex = 0; seams.currentMeetingId = "43";
    useLiveTranscripts({ platform: "google_meet", nativeId: "room-B", meetingId: "43", isActive: false });
    const closeB = seams.effects[1]();
    await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
    closeB?.();
    seams.refIndex = 0; seams.currentMeetingId = "42";
    useLiveTranscripts({ platform: "google_meet", nativeId: "room-A", meetingId: "42", isActive: false });
    dispose = seams.effects[2]();
    await vi.waitFor(() => expect(Socket.instances).toHaveLength(2));
    release({ segments: [{ text: "stale first A" }] });
    await pending; await Promise.resolve();
    Socket.instances[0].receive({ type: "transcript", speaker: "old B", confirmed: [{ segment_id: "stale", text: "wrong meeting" }], pending: [] });
    expect(seams.upsert).not.toHaveBeenCalled();
    expect(seams.bootstrap).toHaveBeenCalledTimes(2);
    expect(seams.bootstrap).toHaveBeenLastCalledWith([{ text: "new meeting A" }]);
  });

  it("does not create an old socket when configuration arrives after unmount", async () => {
    let release!: (data: { json: () => Promise<object> }) => void;
    const pending = new Promise<{ json: () => Promise<object> }>(done => { release = done; });
    vi.mocked(fetch).mockReturnValueOnce(pending as Promise<Response>);
    useLiveTranscripts({ platform: "google_meet", nativeId: "room", meetingId: "42", isActive: false });
    const close = seams.effects[0]();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    close?.();
    release({ json: async () => ({ wsUrl: "ws://test/ws" }) });
    await pending; await Promise.resolve(); await Promise.resolve();
    expect(Socket.instances).toHaveLength(0);
  });

  it("rejects late frames from a replaced socket during reconnect", async () => {
    const old = await connect();
    vi.useFakeTimers();
    old.readyState = 3;
    old.onclose?.({ code: 1006, wasClean: false, reason: "Retry probe" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(Socket.instances).toHaveLength(2);
    const message = { type: "transcript", speaker: "Speaker", confirmed: [{ segment_id: "s/1", text: "current speech" }], pending: [] };
    old.receive(message);
    expect(seams.upsert).not.toHaveBeenCalled();
    Socket.instances[1].receive(message);
    expect(seams.upsert).toHaveBeenCalledTimes(1);
  });

  it("notifies Review after speaker and alignment revisions, ignoring duplicate and foreign events", async () => {
    const socket = await connect();
    const notify = vi.fn();
    window.addEventListener("tina:transcript-corrected", notify);
    const speaker = { type: "speaker.revised", version: "speaker-revision.v1", meeting_id: 42, speaker_id: "voice-1", revision: 2 };
    socket.receive(speaker);
    socket.receive(speaker);
    socket.receive({ ...speaker, revision: 1 });
    socket.receive({ ...speaker, meeting_id: 99, revision: 3 });
    socket.receive({ ...speaker, version: "invalid", revision: 3 });
    socket.receive({ type: "transcript.revised", version: "transcript-revision.v1", meeting_id: 42, segment_id: "s/1", revision: 1, kind: "alignment" });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][0].detail).toEqual({ meetingId: "42" });
    expect(seams.snapshot).toHaveBeenCalledTimes(2);
    expect(seams.bootstrap).toHaveBeenCalledTimes(2);
  });

  it("waits for the refreshed snapshot before notifying open review dialogs", async () => {
    const socket = await connect();
    let resolve!: (value: { segments: object[] }) => void;
    seams.snapshot.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const notify = vi.fn();
    window.addEventListener("tina:transcript-corrected", notify);
    socket.receive({ type: "speaker.revised", version: "speaker-revision.v1", meeting_id: 42, speaker_id: "voice-1", revision: 1 });
    expect(notify).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(seams.snapshot).toHaveBeenCalledTimes(2));
    resolve({ segments: [{ speaker: "Alice" }] });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(seams.bootstrap).toHaveBeenLastCalledWith([{ speaker: "Alice" }]);
  });

  it("coalesces 100 segment revisions and one queued follow-up without overlapping requests", async () => {
    const socket = await connect();
    let resolve!: (value: { segments: object[] }) => void;
    seams.snapshot.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const notify = vi.fn();
    window.addEventListener("tina:transcript-corrected", notify);
    const revision = (index: number) => ({ type: "transcript.revised", version: "transcript-revision.v1", meeting_id: 42, segment_id: `s/${index}`, revision: 1, kind: "alignment" });
    socket.receive(revision(0));
    await vi.waitFor(() => expect(seams.snapshot).toHaveBeenCalledTimes(2));
    for (let i = 1; i <= 100; i++) socket.receive(revision(i));
    expect(seams.snapshot).toHaveBeenCalledTimes(2);
    resolve({ segments: [{ text: "superseded snapshot" }] });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(seams.snapshot).toHaveBeenCalledTimes(3);
    expect(seams.bootstrap).not.toHaveBeenCalledWith([{ text: "superseded snapshot" }]);
  });

  it("retries a failed canonical refresh before notifying Review", async () => {
    const socket = await connect();
    seams.snapshot.mockRejectedValueOnce(new Error("Temporary failure"));
    const notify = vi.fn();
    window.addEventListener("tina:transcript-corrected", notify);
    socket.receive({ type: "speaker.revised", version: "speaker-revision.v1", meeting_id: 42, speaker_id: "voice-1", revision: 1 });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(seams.snapshot).toHaveBeenCalledTimes(3);
  });
});
