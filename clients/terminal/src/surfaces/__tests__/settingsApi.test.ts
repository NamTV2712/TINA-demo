import { describe, expect, it } from "vitest";

import { canSaveModelPrefs } from "../settingsApi";

describe("canSaveModelPrefs", () => {
  it("requires the Antigravity Terms acknowledgment only for Antigravity", () => {
    expect(canSaveModelPrefs({ mode: "subscription" })).toBe(true);
    expect(canSaveModelPrefs({ mode: "antigravity" })).toBe(false);
    expect(canSaveModelPrefs({
      mode: "antigravity",
      antigravity_terms_acknowledged: "true",
    })).toBe(true);
  });
});
