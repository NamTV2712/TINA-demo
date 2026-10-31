import { describe, it, expect } from "vitest";
import { transcriptDiff } from "../transcript-diff";
describe("transcript token diff", () => {
  it("preserves Vietnamese accents, English terms, insertions and deletions", () => {
    const diff = transcriptDiff("team TINA dùng api sai", "team TINA dùng API");
    expect(diff.filter(p => p.kind !== "add").map(p => p.text).join(" ")).toBe("team TINA dùng api sai");
    expect(diff.filter(p => p.kind !== "remove").map(p => p.text).join(" ")).toBe("team TINA dùng API");
    expect(transcriptDiff("", "TINA")).toEqual([{ kind: "add", text: "TINA" }]);
    expect(transcriptDiff("TINA", "")).toEqual([{ kind: "remove", text: "TINA" }]);
    expect(transcriptDiff("chào", "chào").every(p => p.kind === "keep")).toBe(true);
  });
});
