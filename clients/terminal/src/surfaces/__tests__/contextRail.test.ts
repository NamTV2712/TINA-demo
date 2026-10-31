/** ContextRail — `recordTabId` reconstructs the dockview panel id of a record so the rail's "Open
 *  record" button FOCUSES the tab the user already has instead of spawning a duplicate. Unknown kinds
 *  must return null (no guessed ids → no phantom tabs). */
import { describe, it, expect } from "vitest";
import { recordTabId } from "../context";

describe("recordTabId", () => {
  it("rebuilds a meeting tab id", () => {
    expect(recordTabId({ kind: "meeting", params: { meetingId: "37" } })).toBe("meeting:37");
  });

  it("a prep tab points at its meeting", () => {
    expect(recordTabId({ kind: "meetingPrep", params: { meetingId: "37" } })).toBe("meeting:37");
  });

  it("rebuilds a workspace-scoped doc id", () => {
    expect(recordTabId({ kind: "doc", params: { path: "README.md", slug: "acme" } })).toBe("doc:acme:README.md");
  });

  it("rebuilds a personal doc id", () => {
    expect(recordTabId({ kind: "doc", params: { path: "notes/standup.md" } })).toBe("doc:notes/standup.md");
  });

  it("rebuilds the Today tab id", () => {
    expect(recordTabId({ kind: "today", params: {} })).toBe("today");
  });

  it("declines kinds whose id it cannot know", () => {
    expect(recordTabId({ kind: "canvas", params: { meetingId: "37" } })).toBeNull();
    expect(recordTabId({ kind: "meeting", params: {} })).toBeNull();
    expect(recordTabId({ kind: "doc", params: {} })).toBeNull();
  });
});
