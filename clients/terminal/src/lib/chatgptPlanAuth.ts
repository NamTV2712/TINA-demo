import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const CHATGPT_PENDING_COOKIE = "tina-openai-plan-pending";
export const CHATGPT_SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];
const AUTHORIZATION_ENDPOINT = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_ENDPOINT = "https://auth.openai.com/api/accounts/oauth/token";
const DISCOVERY_URL = "https://auth.openai.com/.well-known/openid-configuration";
const PENDING_TTL_MS = 10 * 60 * 1000;
type PendingEntry = { value: PendingChatGPTAuth; expiresAt: number };
type PendingGlobal = typeof globalThis & { __tinaOpenAIPending?: Map<string, PendingEntry> };
const pendingGlobal = globalThis as PendingGlobal;
const pending = pendingGlobal.__tinaOpenAIPending ??= new Map<string, PendingEntry>();

export type ChatGPTProfile = {
  subject: string;
  email: string;
  client_id: string;
  host_id: string;
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scopes: string[];
  saved_at: string;
};

export type PendingChatGPTAuth = {
  generation: string;
  state: string;
  nonce: string;
  verifier: string;
  redirect_uri: string;
  ui_origin: string;
  subject_id: string;
  host_id: string;
  client_id: string;
  agent_name_hint?: string;
  id_token_hint?: string;
  login_hint?: string;
};

export async function currentTinaSubject(): Promise<string | null> {
  const { cookies } = await import("next/headers");
  const { AUTH_COOKIE, validateAuthToken } = await import("../app/api/auth/adminApi");
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  if (!token) return null;
  const user = await validateAuthToken(token);
  return user.ok ? String(user.userId) : null;
}

function authDir(): string {
  return process.env.TINA_OPENAI_AUTH_DIR || "/var/lib/tina/openai-auth";
}

function profilePath(subjectId: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(subjectId) || subjectId === "." || subjectId === "..") {
    throw new Error("Invalid TINA subject for ChatGPT profile.");
  }
  return path.join(authDir(), `${subjectId}.json`);
}

export async function readChatGPTProfile(subjectId: string): Promise<Partial<ChatGPTProfile> | null> {
  try {
    const raw = await readFile(profilePath(subjectId), "utf8");
    const value = JSON.parse(raw) as ChatGPTProfile;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export async function chatGPTConnection(subjectId: string, method: "GET" | "PUT" | "DELETE", body?: { generation: string; profile: ChatGPTProfile }): Promise<{ generation?: string }> {
  profilePath(subjectId);
  const secret = process.env.TINA_INTERNAL_API_SECRET || "";
  if (!secret) throw new Error("ChatGPT connection management is not configured.");
  const base = (process.env.AGENT_API_URL || "http://agent-api:8100").replace(/\/+$/, "");
  const response = await fetch(`${base}/internal/openai-auth/${encodeURIComponent(subjectId)}`, {
    method, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20000),
    headers: { "X-Internal-Secret": secret, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(response.status === 409 ? "This sign-in was cancelled; start a new ChatGPT connection." : "Could not update the ChatGPT connection; retry shortly.");
  return response.json();
}

export async function writeChatGPTProfile(subjectId: string, profile: ChatGPTProfile, generation: string): Promise<void> {
  await chatGPTConnection(subjectId, "PUT", { generation, profile });
}

export async function writePendingRegistration(subjectId: string, clientId: string, hostId: string, generation: string): Promise<void> {
  await writeChatGPTProfile(subjectId, {
    subject: "", email: "", client_id: clientId, host_id: hostId,
    id_token: "", access_token: "", refresh_token: "", expires_at: 0,
    scopes: [], saved_at: new Date().toISOString(),
  }, generation);
}

export function cancelPendingChatGPTAuth(subjectId: string): void {
  for (const [state, entry] of pending) if (entry.value.subject_id === subjectId) pending.delete(state);
}

export function callbackUri(): string {
  const configured = (process.env.TINA_OPENAI_CALLBACK_URL || "").trim();
  if (configured) return configured;
  const port = (process.env.TINA_TERMINAL_PUBLIC_PORT || "23000").trim();
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("TINA_TERMINAL_PUBLIC_PORT is invalid.");
  }
  return `http://127.0.0.1:${port}/api/models/openai/callback`;
}

export function beginChatGPTAuth(input: Omit<PendingChatGPTAuth, "state" | "nonce" | "verifier">): {
  authorizationUrl: string;
  pending: PendingChatGPTAuth;
} {
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const pending: PendingChatGPTAuth = { ...input, state, nonce, verifier };
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: input.client_id,
    response_type: "code",
    redirect_uri: input.redirect_uri,
    scope: CHATGPT_SCOPES.join(" "),
    resource: "https://api.openai.com/v1",
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: challenge,
    ext_agent_host_id: input.host_id,
    ...(input.agent_name_hint ? { agent_name_hint: input.agent_name_hint } : {}),
    ...(input.id_token_hint ? { id_token_hint: input.id_token_hint } : {}),
    ...(input.login_hint ? { login_hint: input.login_hint } : {}),
  }).toString();
  return { authorizationUrl: url.toString(), pending };
}

export function storePending(value: PendingChatGPTAuth): void {
  const now = Date.now();
  for (const [state, entry] of pending) if (entry.expiresAt <= now) pending.delete(state);
  pending.set(value.state, { value, expiresAt: now + PENDING_TTL_MS });
}

export function takePending(state: string, subjectId: string): PendingChatGPTAuth | null {
  const entry = pending.get(state);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) { pending.delete(state); return null; }
  if (entry.value.subject_id !== subjectId) return null;
  pending.delete(state); // Only the authenticated initiating user can consume this state.
  return entry.value;
}

export async function completeChatGPTSignIn(subjectId: string, callback: URL): Promise<void> {
  const code = callback.searchParams.get("code") || "";
  const oauthError = callback.searchParams.get("error");
  if (!code && !oauthError) throw new Error("OpenAI did not return an authorization code.");
  const state = callback.searchParams.get("state") || "";
  const auth = takePending(state, subjectId);
  if (!auth) throw new Error("This sign-in expired, was already used, or belongs to another TINA user. Create a new link from the original TINA tab.");
  if (oauthError) throw new Error(oauthError === "access_denied" ? "ChatGPT plan access was not approved." : "ChatGPT sign-in was cancelled.");
  const callbackClientId = callback.searchParams.get("client_id") || undefined;
  if (auth.client_id === "dynamic_agent_client") {
    if (!callbackClientId) throw new Error("OpenAI did not return the registered client ID; retry sign-in.");
    await writePendingRegistration(subjectId, callbackClientId, auth.host_id, auth.generation);
  }
  const existing = await readChatGPTProfile(subjectId);
  const profile = await exchangeChatGPTCode({ code, callbackClientId, pending: auth, existing });
  await writeChatGPTProfile(subjectId, profile, auth.generation);
}

async function verifiedIdentity(idToken: string, clientId: string, nonce: string): Promise<{ subject: string; email: string }> {
  const [encodedHeader, encodedPayload, encodedSignature] = idToken.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw new Error("OpenAI returned an invalid ID token.");
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as { kid?: string; alg?: string };
  const claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
  const discoveryResponse = await fetch(DISCOVERY_URL, { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!discoveryResponse.ok) throw new Error("Could not verify OpenAI sign-in metadata.");
  const discovery = await discoveryResponse.json() as { issuer?: string; jwks_uri?: string };
  if (discovery.issuer !== "https://auth.openai.com" || !discovery.jwks_uri
      || new URL(discovery.jwks_uri).hostname !== "auth.openai.com") {
    throw new Error("OpenAI sign-in metadata is invalid.");
  }
  const jwksResponse = await fetch(discovery.jwks_uri, { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!jwksResponse.ok) throw new Error("Could not load OpenAI signing keys.");
  const jwks = await jwksResponse.json() as { keys?: Array<Record<string, unknown>> };
  const jwk = (jwks.keys || []).find((key) => key.kid === header.kid);
  if (!jwk || !header.alg || !["RS256", "ES256"].includes(header.alg)) throw new Error("OpenAI ID token uses an unsupported signing key.");
  const publicKey = createPublicKey({
    key: jwk as unknown as import("node:crypto").JsonWebKey,
    format: "jwk",
  });
  const signed = Buffer.from(`${encodedHeader}.${encodedPayload}`);
  const signature = Buffer.from(encodedSignature, "base64url");
  const valid = header.alg === "RS256"
    ? verify("RSA-SHA256", signed, publicKey, signature)
    : verify("sha256", signed, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
  const audience = claims.aud;
  const audienceOk = audience === clientId || (Array.isArray(audience) && audience.includes(clientId));
  const authorizedPartyOk = !Array.isArray(audience) || audience.length <= 1 || claims.azp === clientId;
  if (!valid || claims.iss !== discovery.issuer || !audienceOk || claims.nonce !== nonce
      || !authorizedPartyOk
      || typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1000)
      || typeof claims.sub !== "string" || !claims.sub) {
    throw new Error("OpenAI ID token validation failed; retry the sign-in.");
  }
  return { subject: claims.sub, email: typeof claims.email === "string" ? claims.email : "" };
}

export async function exchangeChatGPTCode(input: {
  code: string; callbackClientId?: string; pending: PendingChatGPTAuth;
  existing?: Partial<ChatGPTProfile> | null;
}): Promise<ChatGPTProfile> {
  const pending = input.pending;
  const issuedClientId = input.callbackClientId || pending.client_id;
  if (!issuedClientId || issuedClientId === "dynamic_agent_client") {
    throw new Error("OpenAI did not return the registered client ID; retry sign-in.");
  }
  if (pending.client_id !== "dynamic_agent_client" && issuedClientId !== pending.client_id) {
    throw new Error("OpenAI returned a different client registration; reconnect the selected account.");
  }
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST", cache: "no-store", signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id: issuedClientId, code: input.code,
      code_verifier: pending.verifier, redirect_uri: pending.redirect_uri,
      resource: "https://api.openai.com/v1",
    }),
  });
  if (!response.ok) throw new Error(`OpenAI token exchange failed (HTTP ${response.status}); restart sign-in.`);
  const body = await response.json() as Record<string, unknown>;
  const access = typeof body.access_token === "string" ? body.access_token : "";
  const refresh = typeof body.refresh_token === "string" ? body.refresh_token : "";
  const idToken = typeof body.id_token === "string" ? body.id_token : "";
  const scopes = typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : [];
  if (!access || !refresh || !idToken || !scopes.includes("chatgpt.tokens.use.direct") || !scopes.includes("resource.invoke")) {
    throw new Error("ChatGPT plan usage was not granted. Reconnect and allow plan usage.");
  }
  const identity = await verifiedIdentity(idToken, issuedClientId, pending.nonce);
  if (input.existing?.subject && input.existing.subject !== identity.subject) {
    throw new Error("The signed-in ChatGPT account differs from the saved connection.");
  }
  return {
    subject: identity.subject,
    email: identity.email,
    client_id: issuedClientId,
    host_id: pending.host_id,
    id_token: idToken,
    access_token: access,
    refresh_token: refresh,
    expires_at: Math.floor(Date.now() / 1000) + Number(body.expires_in || 3600),
    scopes,
    saved_at: new Date().toISOString(),
  };
}
