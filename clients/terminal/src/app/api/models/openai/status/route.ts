import { NextResponse } from "next/server";
import { currentTinaSubject, readChatGPTProfile } from "../../../../../lib/chatgptPlanAuth";

export const dynamic = "force-dynamic";

export async function GET() {
  const subject = await currentTinaSubject();
  if (!subject) return NextResponse.json({ connected: false }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const profile = await readChatGPTProfile(subject);
  const scopes = new Set(profile?.scopes || []);
  const connected = Boolean(profile?.access_token && profile?.refresh_token
    && scopes.has("chatgpt.tokens.use.direct") && scopes.has("resource.invoke"));
  return NextResponse.json({
    connected,
    email: connected ? profile?.email || "" : "",
    expires_at: connected ? profile?.expires_at || 0 : 0,
  }, { headers: { "Cache-Control": "no-store" } });
}
