import { cookies } from 'next/headers';
import { NextRequest } from 'next/server';
import { getAuthCookieName } from './auth-cookies';

/** The Gateway alone resolves the cookie key to an owner; never forward service credentials. */
export async function forwardAgent(request: NextRequest, path: string[]): Promise<Response> {
  const token = (await cookies()).get(getAuthCookieName())?.value;
  if (!token) return Response.json({ detail: 'Sign in to use the agent.' }, { status: 401 });
  const gateway = process.env.TINA_API_URL?.replace(/\/+$/, '');
  if (!gateway) return Response.json({ detail: 'TINA_API_URL is required.' }, { status: 503 });
  if (!path.length || path.some(p => !/^[\w.:-]+$/.test(p) || p === '.' || p === '..')) {
    return Response.json({ detail: 'Invalid agent path.' }, { status: 400 });
  }
  const origin = request.headers.get('origin');
  const allowedOrigins = new Set([request.nextUrl.origin]);
  const host = request.headers.get('host');
  if (host) {
    try { allowedOrigins.add(new URL(`${request.nextUrl.protocol}//${host}`).origin); } catch { /* Invalid Host grants no origin. */ }
  }
  for (const configured of [process.env.NEXTAUTH_URL, process.env.NEXT_PUBLIC_APP_URL]) {
    try { if (configured) allowedOrigins.add(new URL(configured).origin); } catch { /* Invalid deployment URL grants no origin. */ }
  }
  const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
  for (const allowed of [...allowedOrigins]) {
    const url = new URL(allowed);
    if (loopback.has(url.hostname)) for (const hostname of loopback) {
      url.hostname = hostname; allowedOrigins.add(url.origin);
    }
  }
  if (!['GET', 'HEAD'].includes(request.method) && origin && !allowedOrigins.has(origin)) {
    return Response.json({ detail: 'Cross-origin writes are refused.' }, { status: 403 });
  }
  const headers: Record<string, string> = { 'X-API-Key': token };
  if (request.headers.has('content-type')) headers['Content-Type'] = request.headers.get('content-type')!;
  if (request.headers.has('last-event-id')) headers['Last-Event-ID'] = request.headers.get('last-event-id')!;
  try {
    const response = await fetch(`${gateway}/agent/${path.map(encodeURIComponent).join('/')}${request.nextUrl.search}`, {
      method: request.method, headers, cache: 'no-store', signal: AbortSignal.timeout(120000),
      ...(!['GET', 'HEAD'].includes(request.method) ? { body: await request.text() } : {}),
    });
    return new Response(response.body, {
      status: response.status,
      headers: { 'Content-Type': response.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' },
    });
  } catch {
    return Response.json({ detail: 'Could not reach the agent. Please retry.' }, { status: 502 });
  }
}
