/** AWS-only ASR controller: read/choose models on the separate Speech EC2.
 * This deliberately NEVER starts/stops Docker containers across hosts.
 * The Speech EC2 owns the two always-on workers; only per-account preference is updated.
 */
import { NextRequest, NextResponse } from "next/server";

const noStore = { "Cache-Control": "no-store" } as const;
type Backend = "gipformer" | "viegem";
type Selection = { backend: Backend; enabled: boolean; revision: number };
type Account = { backend: Backend | null; enabled: boolean; revision: number };
type Worker = { running: boolean; ready: boolean; device: string; draining?: boolean };
const specs: Record<Backend, { url: string; model: string }> = {
  gipformer: {
    url: process.env.TINA_AWS_ASR_GIPFORMER_URL || "",
    model: "g-group-ai-lab/gipformer1.5-68M-rnnt",
  },
  viegem: {
    url: process.env.TINA_AWS_ASR_VIEGEM_URL || "",
    model: "5CD-AI/VieGem-ASR",
  },
};
const names: Backend[] = ["gipformer", "viegem"];

function err(detail: string, status = 503) {
  return NextResponse.json({ detail }, { status, headers: noStore });
}
function adminConfig(): { url: string; secret: string } | null {
  const url = (process.env.TINA_ADMIN_API_URL || "").replace(/\/+$/, "");
  const secret = process.env.TINA_INTERNAL_API_SECRET || "";
  return url && secret ? { url, secret } : null;
}
async function internal(path: string, init: RequestInit = {}): Promise<Response> {
  const config = adminConfig();
  if (!config) throw new Error("internal service not configured");
  return fetch(`${config.url}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "X-Internal-Secret": config.secret, ...init.headers },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
}
async function accountFor(userId: string | number): Promise<{
  account: Account; counts: Record<Backend, number>;
}> {
  const res = await internal(`/internal/transcription/runtime?user_id=${encodeURIComponent(String(userId))}`);
  if (!res.ok) throw new Error(`admin runtime HTTP ${res.status}`);
  const body = await res.json() as { account?: Account; counts?: Record<Backend, number> };
  const account = body.account;
  if (!account || !Number.isSafeInteger(account.revision) || typeof account.enabled !== "boolean" ||
      !body.counts || names.some(name => !Number.isSafeInteger(body.counts?.[name]))) {
    throw new Error("invalid runtime reply");
  }
  return { account, counts: body.counts };
}
async function workerFor(name: Backend): Promise<Worker> {
  const { url, model } = specs[name];
  const down: Worker = { running: false, ready: false, device: "cpu" };
  if (!url) return down;
  try {
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") return down;
    if (target.username || target.password || target.search || target.hash || target.pathname !== "/") return down;
    const res = await fetch(target.origin + "/status", {
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(3500),
    });
    if (!res.ok) return down;
    const body = await res.json() as {
      model?: { asr_model?: string; device?: string }; draining?: boolean;
    };
    if (body.model?.asr_model !== model) return down;
    return { running: true, ready: body.draining !== true, draining: body.draining === true,
      device: body.model.device || "cpu" };
  } catch { return down; }
}
async function snapshot(userId: string | number) {
  const [data, gipformer, viegem] = await Promise.all([
    accountFor(userId), workerFor("gipformer"), workerFor("viegem"),
  ]);
  return { instance: "aws-two-ec2", account: data.account, counts: data.counts,
    workers: { gipformer, viegem }, operation: null, last_error: null };
}
function parseSelection(raw: unknown): Selection | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "backend,enabled,revision" ||
      (value.backend !== "gipformer" && value.backend !== "viegem") ||
      typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.revision) ||
      (value.revision as number) < 0) return null;
  return value as Selection;
}

export async function awsRemoteRuntime(req: NextRequest, write: boolean, userId: string | number) {
  if (!adminConfig()) return err("AWS remote ASR controller is not configured");
  if (names.some(name => !specs[name].url)) return err("Speech endpoints are not configured");
  try {
    if (!write) return NextResponse.json(await snapshot(userId), { headers: noStore });
    const length = Number(req.headers.get("content-length") || "0");
    if (!Number.isFinite(length) || length > 1024) return err("Request too large", 413);
    if (!req.body) return err("Invalid request", 422);
    const reader = req.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1024) { await reader.cancel(); return err("Request too large", 413); }
      parts.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let pos = 0;
    for (const part of parts) { bytes.set(part, pos); pos += part.byteLength; }
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return err("Invalid request", 422); }
    const next = parseSelection(raw);
    if (!next) return err("Invalid ASR selection", 422);
    const before = await accountFor(userId);
    if (before.account.revision !== next.revision) return err("Transcription settings changed; refresh", 409);
    if (!next.enabled && before.account.backend !== next.backend) {
      return err("Only the selected model can be disabled", 409);
    }
    if (next.enabled && !(await workerFor(next.backend)).ready) {
      return err(`${next.backend} is not ready on the Speech EC2`, 503);
    }
    const result = await internal(`/internal/users/${encodeURIComponent(String(userId))}/transcription-runtime`, {
      method: "PUT",
      body: JSON.stringify({ backend: next.backend,
        enabled: next.enabled ? "true" : "false", expected_revision: next.revision }),
    });
    if (!result.ok) return err(result.status === 409 ? "Transcription settings changed; refresh" :
      "Could not update account transcription selection", result.status >= 400 && result.status < 500 ? result.status : 503);
    return NextResponse.json(await snapshot(userId), { headers: noStore });
  } catch {
    return err("AWS Speech or Admin API unavailable; retry shortly");
  }
}
