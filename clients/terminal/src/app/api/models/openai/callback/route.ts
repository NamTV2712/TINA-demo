import { NextRequest, NextResponse } from "next/server";
import {
  currentTinaSubject, completeChatGPTSignIn, callbackUri,
} from "../../../../../lib/chatgptPlanAuth";

export const dynamic = "force-dynamic";

function htmlEscape(value: string): string {
  const replacements: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return value.replace(/[&<>"']/g, (c) => replacements[c] || c);
}

function callbackPage(ok: boolean, uiOrigin: string, message: string, handoffUrl?: string): NextResponse {
  const safeOrigin = JSON.stringify(uiOrigin).replace(/</g, "\\u003c");
  const body = ok
    ? `<!doctype html><meta charset="utf-8"><title>TINA — ChatGPT connected</title><p>ChatGPT is connected to TINA. You can close this window.</p><p><a href="${htmlEscape(uiOrigin)}">Return to TINA</a></p><script>if(window.opener){window.opener.postMessage({type:"tina-chatgpt-connected"},${safeOrigin});window.close()}</script>`
    : `<!doctype html><meta charset="utf-8"><title>TINA — ChatGPT sign-in</title><p>${htmlEscape(message)}</p>${handoffUrl
      ? `<p>Copy this callback URL and paste it into “Callback URL from the other browser” in the original TINA Settings tab, then click “Finish connection”.</p><input id="callback" aria-label="ChatGPT callback URL" readonly style="width:95%" value="${htmlEscape(handoffUrl)}"><button id="copy">Copy callback URL</button><p id="result">Use it only in your original TINA tab. This link completes your account connection.</p><script>document.getElementById('copy').onclick=async()=>{const input=document.getElementById('callback');try{await navigator.clipboard.writeText(input.value);document.getElementById('result').textContent='Copied. Return to the original TINA tab.'}catch{input.select();document.getElementById('result').textContent='Select and copy the URL manually.'}}</script>`
      : '<p>Return to TINA and create a new sign-in link.</p>'}`;
  return new NextResponse(body, {
    status: ok || handoffUrl ? 200 : 400,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function GET(req: NextRequest) {
  const subject = await currentTinaSubject();
  const callback = new URL(callbackUri());
  for (const key of ["state", "code", "client_id", "error"]) {
    const value = req.nextUrl.searchParams.get(key);
    if (value) callback.searchParams.set(key, value);
  }
  if (!subject) return callbackPage(false, callback.origin,
    "This browser is not signed in to TINA. Your sign-in request has not been consumed.",
    callback.searchParams.get('state') && callback.searchParams.get('code') ? callback.toString() : undefined);

  try {
    await completeChatGPTSignIn(subject, callback);
    return callbackPage(true, callback.origin, "ChatGPT connected.");
  } catch (error) {
    // Keep token endpoint bodies and credentials out of the browser response.
    const message = error instanceof Error ? error.message : "ChatGPT sign-in failed.";
    return callbackPage(false, callback.origin, message.slice(0, 200));
  }
}
