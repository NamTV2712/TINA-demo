/** Production-only, single-account local password login for the self-hosted demo.
 * The credential hash is provisioned outside Git via AWS Secrets Manager -> core.env.
 * This intentionally does NOT enable the existing passwordless debug login.
 */
import { scrypt, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, USER_INFO_COOKIE, findOrCreateUserToken } from "../adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;
let failureCount = 0;
let windowExpires = 0;
let inFlight = 0;

// Fixed parameters are also checked before running scrypt: do not let untrusted
// environment input select arbitrary CPU/memory cost at login time.
const HASH_RE = /^scrypt:32768:8:1:([0-9a-f]{32}):([0-9a-f]{128})$/;

function configured(): { email: string; hash: string } | null {
  const email = (process.env.TINA_PASSWORD_LOGIN_EMAIL || "").trim().toLowerCase();
  const hash = process.env.TINA_PASSWORD_LOGIN_HASH || "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !HASH_RE.test(hash)) return null;
  // A local-only credential is not allowed on an unencrypted public origin.
  if (!(process.env.NEXTAUTH_URL || "").startsWith("https://")) return null;
  return { email, hash };
}

function failureLimited(): boolean {
  const now = Date.now();
  if (now >= windowExpires) {
    failureCount = 0;
    windowExpires = now + WINDOW_MS;
  }
  return failureCount >= MAX_FAILURES;
}

function recordFailure() {
  failureLimited();
  failureCount++;
}

function verifyPassword(password: string, hash: string): Promise<boolean> {
  const match = HASH_RE.exec(hash);
  if (!match) return Promise.resolve(false);
  const salt = Buffer.from(match[1], "hex");
  const expected = Buffer.from(match[2], "hex");
  return new Promise((resolve, reject) => {
    scrypt(password, salt, expected.length, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, derived) => {
      if (err) return reject(err);
      resolve(timingSafeEqual(expected, derived));
    });
  });
}

export async function GET() {
  return NextResponse.json({ enabled: Boolean(configured()) }, { headers: NO_STORE });
}

export async function POST(request: NextRequest) {
  const credential = configured();
  if (!credential) {
    return NextResponse.json({ error: "Local password login is not configured" }, { status: 503, headers: NO_STORE });
  }
  // Block cross-site form posts. Reverse proxy must forward the public Host.
  if (request.headers.get("origin") !== new URL(process.env.NEXTAUTH_URL!).origin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
  }
  if (failureLimited() || inFlight >= 2) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { ...NO_STORE, "Retry-After": "900" } });
  }
  if (Number(request.headers.get("content-length") || "0") > 4096) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401, headers: NO_STORE });
  }
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid credentials" }, { status: 401, headers: NO_STORE }); }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401, headers: NO_STORE });
  }
  const { email, password } = body as Record<string, unknown>;
  if (typeof email !== "string" || email.length > 254 || typeof password !== "string"
      || !password || Buffer.byteLength(password, "utf8") > 1024) {
    recordFailure();
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401, headers: NO_STORE });
  }

  // Always hash even when the email differs, avoiding an obvious email timing oracle.
  inFlight++;
  let valid = false;
  try { valid = await verifyPassword(password, credential.hash); }
  catch { return NextResponse.json({ error: "Authentication unavailable" }, { status: 503, headers: NO_STORE }); }
  finally { inFlight--; }
  if (!valid || email.trim().toLowerCase() !== credential.email) {
    recordFailure();
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401, headers: NO_STORE });
  }

  // Reuse the existing Admin API identity/session and bootstrap claim. No password
  // storage in its DB, no new admin endpoints, and no anonymous account creation.
  const result = await findOrCreateUserToken(credential.email);
  if (!result.ok) {
    return NextResponse.json({ error: "Login temporarily unavailable" }, { status: 503, headers: NO_STORE });
  }
  failureCount = 0;
  const secureCookie = true;
  const opts = { httpOnly: true, secure: secureCookie, sameSite: "lax" as const, path: "/", maxAge: 60 * 60 * 24 * 30 };
  const cookieStore = await cookies();
  cookieStore.set(AUTH_COOKIE, result.token, opts);
  cookieStore.set(USER_INFO_COOKIE, JSON.stringify({ email: result.user.email, name: result.user.name || result.user.email.split("@")[0] }), opts);
  return NextResponse.json({ success: true }, { headers: NO_STORE });
}
