import { describe, expect, it } from "vitest";
import { browserAsrTimings, recordAsrTiming, timingPercentiles } from "../../lib/asrTelemetry";

describe("content-free browser ASR timings", () => {
  it("bounds history and strips fields outside the timing allowlist", () => {
    for (let i = 0; i < 110; i++) recordAsrTiming({ source: "dictation", at_ms: i, frame_ms: i,
      ...{ transcript: "PRIVATE-TEXT" } });
    expect(browserAsrTimings()).toHaveLength(100);
    expect(JSON.stringify(browserAsrTimings())).not.toContain("PRIVATE-TEXT");
    recordAsrTiming({ source: "dictation", at_ms: 0, frame_ms: NaN });
    expect(browserAsrTimings()[0].frame_ms).toBe(109);
  });

  it("returns no percentile for missing samples and nearest-rank for present samples", () => {
    expect(timingPercentiles([])).toEqual({ count: 0, p50_ms: null, p95_ms: null });
    expect(timingPercentiles([1, 2, 3, 4, 5])).toEqual({ count: 5, p50_ms: 3, p95_ms: 5 });
  });

  it("keeps HTTP without a frame and updates the same request when a foreground frame arrives", () => {
    const request_id = "11111111-1111-4111-8111-111111111111";
    recordAsrTiming({ source: "dictation", at_ms: 1, request_id, http_ms: 50, frame_ms: null });
    expect(browserAsrTimings()[0].frame_ms).toBeNull();
    recordAsrTiming({ source: "dictation", at_ms: 1, request_id, http_ms: 50, frame_ms: 10 });
    expect(browserAsrTimings().filter((sample) => sample.request_id === request_id)).toHaveLength(1);
    expect(browserAsrTimings()[0].frame_ms).toBe(10);
  });
});
