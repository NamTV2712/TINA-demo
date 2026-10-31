/** Admin-only, read-only ASR diagnostics. Endpoint credentials never leave this server. */
import { NextResponse } from "next/server";
import { requireAdmin } from "../gate";
import { AsrStatusSchema, asrStatusEndpoint, type AsrStatusResult } from "../../../../lib/asrStatus";

export const dynamic = "force-dynamic";
const cache = { "Cache-Control": "no-store", Vary: "Cookie" };

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return new NextResponse(null, { status: 404, headers: cache });
  const identity = (process.env.TINA_ADMIN_API_URL ?? "").replace(/\/+$/, "");
  const secret = process.env.TINA_INTERNAL_API_SECRET;
  if (!identity || !secret) return NextResponse.json({ error: "Identity configuration is unavailable" }, { status: 503, headers: cache });
  let config: { backend?: string; url?: string; token?: string };
  try {
    const response = await fetch(`${identity}/internal/users/${encodeURIComponent(admin.userId)}/transcription`, {
      headers: { "X-Internal-Secret": secret }, cache: "no-store", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Identity lookup failed");
    config = await response.json();
  } catch {
    return NextResponse.json({ error: "Could not resolve the selected ASR backend" }, { status: 503, headers: cache });
  }
  const backend = config.backend || "deployment";
  const url = config.url || (backend === "deployment" ? process.env.TRANSCRIPTION_SERVICE_URL : "");
  const result: AsrStatusResult = { backend, state: "unconfigured", checked_at_ms: Date.now(), service: null };
  if (!url) return NextResponse.json(result, { headers: cache });
  try {
    const token = config.url ? config.token : process.env.TRANSCRIPTION_SERVICE_TOKEN;
    const response = await fetch(asrStatusEndpoint(url), {
      headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store", signal: AbortSignal.timeout(3000),
    });
    result.state = response.status === 404 ? "unsupported" : "unreachable";
    if (response.ok) {
      const parsed = AsrStatusSchema.safeParse(await response.json());
      result.state = parsed.success ? "ready" : "unsupported";
      result.service = parsed.success ? parsed.data : null;
    }
  } catch { result.state = "unreachable"; }
  return NextResponse.json(result, { headers: cache });
}
