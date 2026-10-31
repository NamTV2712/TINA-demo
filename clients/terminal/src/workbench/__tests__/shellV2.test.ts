/** Agent-first shell (direction A) — the runtime v1/v2 flag and the `lastRecord` grounding rule.
 *
 *  `lastRecord` is what keeps the conversation attached to the meeting/doc it is about once the thread
 *  itself becomes a CENTER tab (so `activeTab` is usually the thread, not a record). These tests pin the
 *  rule down so a later refactor of layout.ts can't silently drop the context.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createLayoutService, type LayoutService } from "../layout";
import { shellStore, setShellVersion, isShellV2, SHELL_LS_KEY, THREAD_TAB_KIND } from "../shell";

describe("layout.lastRecord — what the conversation stays grounded on", () => {
  let svc: LayoutService;
  beforeEach(() => { svc = createLayoutService("files"); });

  it("records the last NON-thread tab", () => {
    svc.setActiveTab({ kind: "meeting", params: { meetingId: "37" } });
    expect(svc.store.getState().lastRecord).toEqual({ kind: "meeting", params: { meetingId: "37" } });
  });

  it("focusing the THREAD does not erase the record the conversation is about", () => {
    svc.setActiveTab({ kind: "meeting", params: { meetingId: "37" } });
    svc.setActiveTab({ kind: THREAD_TAB_KIND, params: {} });
    const st = svc.store.getState();
    expect(st.activeTab?.kind).toBe(THREAD_TAB_KIND);
    expect(st.lastRecord?.kind).toBe("meeting");
  });

  it("a newer record replaces the previous one", () => {
    svc.setActiveTab({ kind: "meeting", params: { meetingId: "37" } });
    svc.setActiveTab({ kind: "doc", params: { path: "README.md" } });
    expect(svc.store.getState().lastRecord?.kind).toBe("doc");
  });

  it("starts empty and is cleared by resetLayout", () => {
    expect(svc.store.getState().lastRecord).toBeNull();
    svc.setActiveTab({ kind: "meeting", params: { meetingId: "37" } });
    svc.resetLayout();
    expect(svc.store.getState().lastRecord).toBeNull();
  });
});

describe("shell flag — the v1/v2 flip is a runtime localStorage switch", () => {
  beforeEach(() => {
    try { localStorage.removeItem(SHELL_LS_KEY); } catch { /* storage unavailable */ }
    shellStore.set("v1");
  });

  it("defaults to v1, so shipping the flag alone changes nothing", () => {
    expect(isShellV2()).toBe(false);
  });

  it("flips at runtime and persists the choice", () => {
    setShellVersion("v2");
    expect(isShellV2()).toBe(true);
    expect(localStorage.getItem(SHELL_LS_KEY)).toBe("v2");
    setShellVersion("v1");
    expect(isShellV2()).toBe(false);
    expect(localStorage.getItem(SHELL_LS_KEY)).toBe("v1");
  });

  it("notifies subscribers so open shells re-render on a flip", () => {
    let seen = 0;
    const off = shellStore.subscribe(() => { seen++; });
    setShellVersion("v2");
    off();
    expect(seen).toBeGreaterThan(0);
  });

  it("names the thread as the agent-first primary plane", () => {
    expect(THREAD_TAB_KIND).toBe("thread");
  });
});
