/** Browser-local, bounded timings. Never stores transcript text, audio, names, URLs, or tokens. */
export interface BrowserAsrTiming {
  source: "dictation" | "meeting-view";
  at_ms: number;
  request_id?: string;
  http_ms?: number;
  frame_ms: number | null;
}

let recent: BrowserAsrTiming[] = [];
const empty: BrowserAsrTiming[] = [];
const listeners = new Set<() => void>();
export const browserAsrTimings = () => recent;
export const serverAsrTimings = () => empty;
export const subscribeAsrTimings = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function recordAsrTiming(sample: BrowserAsrTiming) {
  if (![sample.frame_ms ?? 0, sample.http_ms ?? 0].every((n) => Number.isFinite(n) && n >= 0 && n <= 3_600_000)) return;
  const requestId = sample.request_id && /^[0-9a-f-]{36}$/i.test(sample.request_id) ? sample.request_id : undefined;
  recent = [{ source: sample.source, at_ms: sample.at_ms, frame_ms: sample.frame_ms,
    ...(sample.http_ms != null ? { http_ms: sample.http_ms } : {}),
    ...(requestId ? { request_id: requestId } : {}),
  }, ...recent.filter((row) => !requestId || row.request_id !== requestId)].slice(0, 100);
  listeners.forEach((listener) => listener());
}

export function timingPercentiles(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return { count: sorted.length,
    p50_ms: sorted.length ? sorted[Math.ceil(sorted.length * .5) - 1] : null,
    p95_ms: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : null };
}
