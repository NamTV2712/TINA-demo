/** Terminal adapter for meetings/contracts/asr-status.v1. Unknown fields are stripped at the boundary. */
import { z } from "zod";

const ms = z.number().finite().min(0).max(3_600_000).nullable();
const percentile = z.object({ count: z.number().int().nonnegative(), p50_ms: ms, p95_ms: ms });
export const AsrStatusSchema = z.object({
  version: z.literal("asr-status.v1"),
  started_at_ms: z.number().int().nonnegative(),
  model: z.object({ asr_model: z.string(), alias: z.string(), vad_model: z.string(), device: z.string(), requested_device: z.string() }),
  queue: z.object({ active: z.number().int().min(0).max(1), waiting: z.number().int().nonnegative(),
    capacity: z.number().int().positive(), wait_limit_ms: z.number().nonnegative() }),
  requests: z.object({ total: z.number().int().nonnegative(), errors: z.number().int().nonnegative() }),
  latency: z.object({ audio_ms: percentile, capture_ms: percentile, queue_ms: percentile, inference_ms: percentile, total_ms: percentile }),
  recent: z.array(z.object({ request_id: z.string().uuid(), at_ms: z.number().int().nonnegative(),
    source: z.enum(["meeting-bot", "extension", "dictation", "unknown"]), http_status: z.number().int().min(100).max(599),
    audio_ms: ms, capture_ms: ms, queue_ms: ms, inference_ms: ms, total_ms: ms })).max(100),
});

export type AsrServiceStatus = z.infer<typeof AsrStatusSchema>;
export interface AsrStatusResult {
  backend: string;
  state: "ready" | "unsupported" | "unreachable" | "unconfigured";
  checked_at_ms: number;
  service: AsrServiceStatus | null;
}

export function asrStatusEndpoint(url: string) {
  return url.trim().replace(/\/+$/, "").replace(/\/v1\/audio\/transcriptions$/, "") + "/status";
}
