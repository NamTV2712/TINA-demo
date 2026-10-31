import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startStreamingDictation, type StreamingDictation } from "../micDictation";
import { browserAsrTimings } from "../../lib/asrTelemetry";

const response = (text: string, words: { word: string; start: number; end: number }[] = []) =>
  new Response(JSON.stringify({ text, words }), { headers: { "Content-Type": "application/json" } });

describe("streaming dictation audio ownership", () => {
  let processor: { onaudioprocess: ((event: { inputBuffer: { getChannelData(): Float32Array } }) => void) | null };
  let windows: number[];
  let dictation: StreamingDictation | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    windows = [];
    dictation = undefined;
    processor = { onaudioprocess: null };
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: vi.fn() }],
    }) } });
    vi.stubGlobal("AudioContext", class {
      destination = {};
      createMediaStreamSource() { return { connect() {} }; }
      createScriptProcessor() { return Object.assign(processor, { connect() {}, disconnect() {} }); }
      async resume() {}
      async close() {}
    });
    fetchMock = vi.fn(async (_url: string, init: { body: ArrayBuffer }) => {
      windows.push((init.body.byteLength - 44) / 32000);
      return response(`window ${windows.length}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    dictation?.cancel();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const feed = (seconds: number) => processor.onaudioprocess!({
    inputBuffer: { getChannelData: () => new Float32Array(seconds * 16000) },
  });

  it("caps text-only requests at 25 seconds and retains the tail", async () => {
    const onUpdate = vi.fn();
    dictation = await startStreamingDictation({ onUpdate });
    feed(2);
    await vi.advanceTimersByTimeAsync(2500);
    feed(30);
    await vi.advanceTimersByTimeAsync(2500);
    expect(onUpdate).toHaveBeenLastCalledWith("window 2", "");
    expect(await dictation.stop()).toBe("window 2 window 3");
    expect(windows).toEqual([2, 25, 7]);
    expect(fetchMock.mock.calls[2][0]).toContain("prompt=window%202");
  });

  it("preserves audio captured while a text-only window is in flight", async () => {
    let finish!: (value: Response) => void;
    fetchMock.mockImplementationOnce((_url: string, init: { body: ArrayBuffer }) => {
      windows.push((init.body.byteLength - 44) / 32000);
      return new Promise<Response>((resolve) => { finish = resolve; });
    });
    dictation = await startStreamingDictation();
    feed(25);
    await vi.advanceTimersByTimeAsync(2500);
    feed(3);
    finish(response("first window"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await dictation.stop()).toBe("first window window 2");
    expect(windows).toEqual([25, 3]);
  });

  it("flushes a long backlog in bounded windows on stop", async () => {
    dictation = await startStreamingDictation();
    feed(60);
    expect(await dictation.stop()).toBe("window 1 window 2 window 3");
    expect(windows).toEqual([25, 25, 10]);
  });

  it("consumes a silent capped window without stranding following speech", async () => {
    fetchMock.mockImplementationOnce(async (_url: string, init: { body: ArrayBuffer }) => {
      windows.push((init.body.byteLength - 44) / 32000);
      return response("");
    });
    dictation = await startStreamingDictation();
    feed(25);
    await vi.advanceTimersByTimeAsync(2500);
    feed(1);
    expect(await dictation.stop()).toBe("window 2");
    expect(windows).toEqual([25, 1]);
  });

  it("continues confirming timestamped words and retains unconfirmed audio", async () => {
    const results = [
      response("hello", [{ word: "hello", start: 0, end: 1 }]),
      response("hello world", [{ word: "hello", start: 0, end: 1 }, { word: " world", start: 1, end: 2 }]),
      response("world"),
    ];
    fetchMock.mockImplementation(async (_url: string, init: { body: ArrayBuffer }) => {
      windows.push((init.body.byteLength - 44) / 32000);
      return results.shift()!;
    });
    const onUpdate = vi.fn();
    dictation = await startStreamingDictation({ onUpdate });
    feed(2);
    await vi.advanceTimersByTimeAsync(2500);
    feed(1);
    await vi.advanceTimersByTimeAsync(2500);
    expect(onUpdate).toHaveBeenLastCalledWith("hello", "world");
    expect(await dictation.stop()).toBe("hello world");
    expect(windows).toEqual([2, 3, 2]);
  });

  it("retains HTTP timing without reporting a background frame as UI latency", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const requestId = "22222222-2222-4222-8222-222222222222";
    fetchMock.mockImplementationOnce(async () => {
      const result = response("speech"); result.headers.set("X-ASR-Request-ID", requestId); return result;
    });
    dictation = await startStreamingDictation(); feed(2);
    await vi.advanceTimersByTimeAsync(2500);
    const sample = browserAsrTimings().find((row) => row.request_id === requestId)!;
    expect(sample.http_ms).toBeGreaterThanOrEqual(0);
    expect(sample.frame_ms).toBeNull();
  });

  it("updates the same HTTP request with its foreground frame measurement", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const requestId = "33333333-3333-4333-8333-333333333333";
    fetchMock.mockImplementationOnce(async () => {
      const result = response("speech"); result.headers.set("X-ASR-Request-ID", requestId); return result;
    });
    dictation = await startStreamingDictation(); feed(2);
    await vi.advanceTimersByTimeAsync(2532);
    const samples = browserAsrTimings().filter((row) => row.request_id === requestId);
    expect(samples).toHaveLength(1);
    expect(samples[0].frame_ms).not.toBeNull();
  });
});
