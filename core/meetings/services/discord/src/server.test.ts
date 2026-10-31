/**
 * L2 — the runtime.v1 HTTP surface meeting-api calls.
 *
 * This is a wire contract, so the checks go through a real socket: status codes, the create
 * response shape, idempotency, the quota signal (429), sealed-schema rejection (400), and a
 * confirmed delete. No Gateway, no voice: the session factory is a fake.
 *
 * Run: npx tsx src/server.test.ts
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createWorkloadServer, DISCORD_PROFILE } from './server.js';
import { SessionManager, type SessionFactory } from './session-manager.js';
import type { SessionSpec } from './session.js';
import type { Invocation } from './config.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';

function invocation(over: Partial<Invocation> = {}): Invocation {
  return {
    platform: 'discord',
    meetingUrl: `https://discord.com/channels/${GUILD}/${CHANNEL}`,
    nativeMeetingId: `${GUILD}:${CHANNEL}`,
    botName: 'TINA',
    redisUrl: 'redis://localhost:6379/0',
    connectionId: 'conn-1',
    meeting_id: 42,
    meetingApiCallbackUrl: 'http://meeting-api:8080/internal/bot/lifecycle',
    ...over,
  };
}

function workload(workloadId = 'dc-1', over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workloadId,
    profile: DISCORD_PROFILE,
    env: { TINA_BOT_CONFIG: JSON.stringify(invocation()) },
    maxLifetimeSec: 3600,
    ...over,
  };
}

interface Harness {
  server: Server;
  base: string;
  manager: SessionManager;
  specs: SessionSpec[];
  stops: Array<{ id: string; reason?: unknown }>;
  close(): Promise<void>;
}

async function harness(opts: { maxSessions?: number; guildAllowlist?: Set<string>; retentionMs?: number } = {}): Promise<Harness> {
  const specs: SessionSpec[] = [];
  const stops: Array<{ id: string; reason?: unknown }> = [];
  const createSession: SessionFactory = (spec) => {
    specs.push(spec);
    return {
      async start() { /* the fake is immediately "active" */ },
      async stop(reason) { stops.push({ id: spec.workloadId, reason }); },
    };
  };
  const manager = new SessionManager({
    maxSessions: opts.maxSessions ?? 4,
    retentionMs: opts.retentionMs ?? 60_000,
    createSession,
    log: () => { /* silent */ },
  });
  const server = createWorkloadServer({ manager, guildAllowlist: opts.guildAllowlist, log: () => { /* silent */ } });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    manager,
    specs,
    stops,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await manager.shutdown();
    },
  };
}

interface Reply { status: number; body: any }

async function call(base: string, method: string, path: string, body?: unknown): Promise<Reply> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(base + path, init);
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep the raw text */ }
  return { status: res.status, body: parsed };
}

// ── create / read / delete ──────────────────────────────────────────────────────────
{
  const h = await harness();
  try {
    const health = await call(h.base, 'GET', '/healthz');
    check('GET /healthz is 200 with capacity', health.status === 200 && health.body.ok === true && health.body.capacity === 4);

    const created = await call(h.base, 'POST', '/workloads', workload());
    check('POST /workloads returns 201', created.status === 201, JSON.stringify(created.body));
    check('create response is a live WorkloadStatus',
      created.body.state === 'running' && created.body.profile === DISCORD_PROFILE && created.body.backend === 'process');
    check('the invocation target reached the session spec',
      h.specs[0]?.guildId === GUILD && h.specs[0]?.channelId === CHANNEL);
    check('maxLifetimeSec became the hard active cap', h.specs[0]?.maxActiveMs === 3_600_000);

    const again = await call(h.base, 'POST', '/workloads', workload());
    check('POST is idempotent by workloadId', again.status === 201 && h.specs.length === 1);

    const one = await call(h.base, 'GET', '/workloads/dc-1');
    check('GET /workloads/{id} is 200 + running', one.status === 200 && one.body.state === 'running');

    const list = await call(h.base, 'GET', '/workloads?profile=discord-bot');
    check('GET /workloads lists the workload', list.status === 200 && list.body.length === 1 && list.body[0].workloadId === 'dc-1');

    const deleted = await call(h.base, 'DELETE', '/workloads/dc-1');
    check('DELETE is confirmed: 200 + state stopped', deleted.status === 200 && deleted.body.state === 'stopped');
    check('DELETE asked the session to stop', h.stops[0]?.reason === 'stopped');

    const afterDelete = await call(h.base, 'GET', '/workloads/dc-1');
    check('a stopped workload stays queryable as a tombstone', afterDelete.status === 200 && afterDelete.body.state === 'stopped');

    const unknown = await call(h.base, 'GET', '/workloads/dc-nope');
    check('GET of an unknown workload is 404', unknown.status === 404);
    const unknownDelete = await call(h.base, 'DELETE', '/workloads/dc-nope');
    check('DELETE of an unknown workload is 404 (not a silent success)', unknownDelete.status === 404);

    const notFound = await call(h.base, 'GET', '/not-a-route');
    check('an unknown route is 404', notFound.status === 404);
    const wrongMethod = await call(h.base, 'PUT', '/workloads', workload('dc-2'));
    check('an unsupported method is 405', wrongMethod.status === 405);
  } finally {
    await h.close();
  }
}

// ── validation maps to 400 ──────────────────────────────────────────────────────────
{
  const h = await harness();
  try {
    const wrongProfile = await call(h.base, 'POST', '/workloads', workload('dc-1', { profile: 'meeting-bot' }));
    check('a foreign profile is 400', wrongProfile.status === 400);

    const missingEnv = await call(h.base, 'POST', '/workloads', { workloadId: 'dc-1', profile: DISCORD_PROFILE });
    check('a spec without env violates runtime.v1 → 400', missingEnv.status === 400);

    const unknownPlatform = await call(h.base, 'POST', '/workloads', workload('dc-1', {
      env: { TINA_BOT_CONFIG: JSON.stringify(invocation({ platform: 'google_meet' })) },
    }));
    check('a non-Discord invocation is 400', unknownPlatform.status === 400);

    const mismatch = await call(h.base, 'POST', '/workloads', workload('dc-1', {
      env: { TINA_BOT_CONFIG: JSON.stringify(invocation({ nativeMeetingId: `${GUILD}:333333333333333333` })) },
    }));
    check('a native/URL mismatch is 400', mismatch.status === 400);

    const noInvocation = await call(h.base, 'POST', '/workloads', workload('dc-1', { env: {} }));
    check('a missing TINA_BOT_CONFIG is 400', noInvocation.status === 400);

    const badJson = await call(h.base, 'POST', '/workloads', '{not json');
    check('malformed JSON is 400', badJson.status === 400);

    const empty = await call(h.base, 'POST', '/workloads');
    check('an empty body is 400', empty.status === 400);

    const badInvocation = await call(h.base, 'POST', '/workloads', workload('dc-1', {
      env: { TINA_BOT_CONFIG: JSON.stringify({ platform: 'discord', botName: 'TINA', redisUrl: 'redis://x' }) },
    }));
    check('an invocation missing meetingUrl is 400', badInvocation.status === 400);
    check('no invalid create reached the registry', h.manager.size === 0);
  } finally {
    await h.close();
  }
}

// ── guild allowlist ─────────────────────────────────────────────────────────────────
{
  const h = await harness({ guildAllowlist: new Set(['999999999999999999']) });
  try {
    const denied = await call(h.base, 'POST', '/workloads', workload());
    check('a guild outside DISCORD_GUILD_ALLOWLIST is 400', denied.status === 400 && /allowlist/i.test(denied.body.detail));
    check('the denied workload never started', h.manager.size === 0 && h.specs.length === 0);
  } finally {
    await h.close();
  }
}

// ── capacity is 429 (the kernel's quota signal) ─────────────────────────────────────
{
  const h = await harness({ maxSessions: 1 });
  try {
    const first = await call(h.base, 'POST', '/workloads', workload('dc-1'));
    const second = await call(h.base, 'POST', '/workloads', workload('dc-2'));
    check('the first workload is accepted', first.status === 201);
    check('a second workload at capacity is 429', second.status === 429, JSON.stringify(second.body));
    check('the rejected workload is not registered', h.manager.get('dc-2') === undefined);
  } finally {
    await h.close();
  }
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall server checks passed');
process.exit(failed ? 1 : 0);
