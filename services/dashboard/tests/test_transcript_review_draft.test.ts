import { describe, expect, it } from "vitest";
import { reconcileReviewDraft } from "../src/components/transcript/transcript-review";

const segment = { segment_id: "first", text: "original", raw_text: "original", speaker: "Speaker", revision: 0, history: [] };
const draft = { segment_id: "first", text: "my correction", base_text: "original", revision: 0 };

describe("review draft revisions", () => {
  it("preserves a dirty draft's original revision after a remote correction", () => {
    const latest = { ...segment, text: "remote correction", revision: 1 };
    expect(reconcileReviewDraft(draft, [latest])).toEqual(draft);
  });
  it("refreshes a clean draft to the latest text and revision", () => {
    const latest = { ...segment, text: "remote correction", revision: 1 };
    expect(reconcileReviewDraft({ ...draft, text: "original" }, [latest])).toEqual({ segment_id: "first", text: "remote correction", base_text: "remote correction", revision: 1 });
  });
  it("preserves the latest selection and edits even if the reload began before the user selected them", () => {
    const second = { ...segment, segment_id: "second", text: "second" };
    const current = { ...draft, segment_id: "second", base_text: "second" };
    expect(reconcileReviewDraft(current, [segment, second])).toEqual(current);
  });
  it("only resets a dirty draft after an explicit reset", () => {
    const latest = { ...segment, text: "saved correction", revision: 1 };
    expect(reconcileReviewDraft(draft, [latest], true)).toEqual({ segment_id: "first", text: "saved correction", base_text: "saved correction", revision: 1 });
  });
});
