/**
 * L2 — the workload registry (the runtime.v1 semantics meeting-api relies on).
 *
 * The kernel contract is what matters here: create is idempotent, the concurrency cap is a hard
 * 429 signal, delete is CONFIRMED (it waits for the session), a stopped workload stays queryable
 * as a tombstone, and an unknown id is not silently "already gone".
 *
 * Run: npx tsx src/session-manager.test.ts
 */
import {
  CapacityExceededError,
  SessionManager,
  WorkloadUnknownError,
  stopReasonFor,
  type ManagedSession,
  type SessionFactory,
} from './session-manager.js';
import type { SessionOutcome, SessionSpec } from './session.js';
import type { Invocation } from './config.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise<void>((r) => setTimeout(r, 0));
};

function invocation(): Invocation {
  return {
    platform: 'discord',
    meetingUrl: 'https://discord.com/channels/111111111111111111/222222222222222222',
    nativeMeetingId: '111111111111111111:222222222222222222',
    botName: 'TINA',
    redisUrl: 'redis://localhost:6379/0',
    connectionId: 'conn-1',
    meeting_id: 42,
  };
}

function spec(workloadId: string): SessionSpec {
  return {
    workloadId,
    invocation: invocation(),
    guildId: '111111111111111111',
    channelId: '222222222222222222',
  };
}

interface FakeOpts {
  startThrows?: Error;
  autoTerminal?: SessionOutcome;
}

class FakeSession implements ManagedSession {
  startCalls = 0;
  stops: Array<unknown> = [];
  constructor(
    readonly workloadId: string,
    private readonly onTerminal: (outcome: SessionOutcome) => void,
    private readonly opts: FakeOpts = {},
  ) {}
  async start(): Promise<void> {
    this.startCalls++;
    if (this.opts.startThrows) throw this.opts.startThrows;
    if (this.opts.autoTerminal) this.onTerminal(this.opts.autoTerminal);
  }
  async stop(reason?: unknown): Promise<void> {
    this.stops.push(reason);
  }
}

interface Clock {
  now(): number;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  runAll(): void;
  pending(): number;
}

function clock(): Clock {
  let time = 1_700_000_000_000;
  let nextId = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  const fakeSetTimeout = ((fn: () => void, ms: number) => {
    const id = ++nextId;
    tasks.set(id, { at: time + ms, fn });
    return { id, unref() { /* fake */ } };
  }) as unknown as typeof setTimeout;
  const fakeClearTimeout = ((handle: { id?: number } | undefined) => {
    if (handle?.id !== undefined) tasks.delete(handle.id);
  }) as unknown as typeof clearTimeout;
  return {
    now: () => time,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    runAll() {
      for (const [id, task] of [...tasks].sort((a, b) => a[1].at - b[1].at)) {
        tasks.delete(id);
        time = task.at;
        task.fn();
      }
    },
    pending: () => tasks.size,
  };
}

interface Rig {
  manager: SessionManager;
  sessions: Map<string, FakeSession>;
  outcomes: Map<string, (outcome: SessionOutcome) => void>;
  timers: Clock;
  factoryCalls: string[];
}

function rig(opts: { maxSessions?: number; retentionMs?: number; meta?: Map<string, FakeOpts> } = {}): Rig {
  const sessions = new Map<string, FakeSession>();
  const outcomes = new Map<string, (outcome: SessionOutcome) => void>();
  const timers = clock();
  const factoryCalls: string[] = [];
  const createSession: SessionFactory = (s, onTerminal) => {
    factoryCalls.push(s.workloadId);
    outcomes.set(s.workloadId, onTerminal);
    const session = new FakeSession(s.workloadId, onTerminal, opts.meta?.get(s.workloadId));
    sessions.set(s.workloadId, session);
    return session;
  };
  const manager = new SessionManager({
    maxSessions: opts.maxSessions ?? 4,
    retentionMs: opts.retentionMs ?? 60_000,
    createSession,
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    log: () => { /* keep test output readable */ },
  });
  return { manager, sessions, outcomes, timers, factoryCalls };
}

// ── create ──────────────────────────────────────────────────────────────────────────
{
  const r = rig();
  const record = r.manager.create(spec('dc-1'));
  check('create returns a live runtime.v1 record',
    record.state === 'running' && record.backend === 'process' && record.profile === 'discord-bot');
  check('startedAt is an ISO timestamp', record.startedAt === new Date(1_700_000_000_000).toISOString());
  check('the session factory receives the spec and start() runs', r.factoryCalls[0] === 'dc-1');
  await flush();
  check('session.start() was called once', r.sessions.get('dc-1')?.startCalls === 1);
  check('activeCount reflects one live workload', r.manager.activeCount === 1 && r.manager.capacity === 4);

  const again = r.manager.create(spec('dc-1'));
  check('create is idempotent by workloadId', again.workloadId === 'dc-1' && r.factoryCalls.length === 1);
}

// ── capacity ────────────────────────────────────────────────────────────────────────
{
  const r = rig({ maxSessions: 1 });
  r.manager.create(spec('dc-1'));
  let error: unknown;
  try {
    r.manager.create(spec('dc-2'));
  } catch (e) {
    error = e;
  }
  check('a second workload at capacity is refused with CapacityExceededError',
    error instanceof CapacityExceededError && error.max === 1);
  check('the refused workload was never created', !r.manager.get('dc-2') && r.factoryCalls.length === 1);
}

// ── terminal outcomes map to runtime.v1 stop reasons ───────────────────────────────
{
  const r = rig();
  r.manager.create(spec('dc-ok'));
  await flush();
  r.outcomes.get('dc-ok')!({ status: 'completed', completionReason: 'stopped' });
  const record = r.manager.get('dc-ok')!;
  check('completed(stopped) → state stopped, exit 0, stopReason stopped',
    record.state === 'stopped' && record.exitCode === 0 && record.stopReason === 'stopped');
  check('stoppedAt is stamped', typeof record.stoppedAt === 'string');

  const r2 = rig();
  r2.manager.create(spec('dc-fail'));
  await flush();
  r2.outcomes.get('dc-fail')!({
    status: 'failed', completionReason: 'join_failure', failureStage: 'joining', reason: 'no such channel',
  });
  const failed = r2.manager.get('dc-fail')!;
  check('failed(joining) → exit 1, start_failed',
    failed.exitCode === 1 && failed.stopReason === 'start_failed');

  check('max_bot_time_exceeded maps to max_lifetime',
    stopReasonFor({ status: 'completed', completionReason: 'max_bot_time_exceeded' }) === 'max_lifetime');
  check('an active failure maps to failed',
    stopReasonFor({ status: 'failed', completionReason: 'join_failure', failureStage: 'active' }) === 'failed');
  check('a normal completion maps to completed',
    stopReasonFor({ status: 'completed', completionReason: 'left_alone' }) === 'completed');
}

// ── a start() that throws is a terminal join failure, not a stuck workload ─────────
{
  const r = rig({ meta: new Map([['dc-throw', { startThrows: new Error('gateway down') }]]) });
  r.manager.create(spec('dc-throw'));
  await flush();
  const record = r.manager.get('dc-throw')!;
  check('a thrown start is recorded as start_failed', record.state === 'stopped' && record.stopReason === 'start_failed',
    JSON.stringify(record));
}

// ── delete is confirmed ─────────────────────────────────────────────────────────────
{
  const r = rig();
  r.manager.create(spec('dc-del'));
  await flush();
  const record = await r.manager.delete('dc-del');
  check('delete asks the session to stop with reason=stopped',
    r.sessions.get('dc-del')?.stops.length === 1 && r.sessions.get('dc-del')?.stops[0] === 'stopped');
  check('delete returns a stopped record', record.state === 'stopped' && record.stopReason === 'stopped');
  check('a session that never called back is still tombstoned (no stuck "running")',
    r.manager.get('dc-del')?.state === 'stopped');

  let error: unknown;
  try {
    await r.manager.delete('dc-missing');
  } catch (e) {
    error = e;
  }
  check('deleting an unknown workload throws WorkloadUnknownError', error instanceof WorkloadUnknownError);
}

// ── retention tombstone ─────────────────────────────────────────────────────────────
{
  const r = rig({ retentionMs: 5_000 });
  r.manager.create(spec('dc-tomb'));
  await flush();
  r.outcomes.get('dc-tomb')!({ status: 'completed', completionReason: 'stopped' });
  check('a stopped workload remains queryable before retention', r.manager.get('dc-tomb')?.state === 'stopped');
  check('a retention timer is armed', r.timers.pending() === 1);
  r.timers.runAll();
  check('retention evicts the tombstone', r.manager.get('dc-tomb') === undefined);

  // A retained tombstone can be recreated immediately: the new session replaces it.
  const r2 = rig({ retentionMs: 60_000 });
  r2.manager.create(spec('dc-re'));
  await flush();
  r2.outcomes.get('dc-re')!({ status: 'completed', completionReason: 'stopped' });
  const recreated = r2.manager.create(spec('dc-re'));
  await flush();
  check('recreating a tombstoned id starts a fresh session',
    recreated.state === 'running' && r2.factoryCalls.length === 2 && r2.sessions.get('dc-re')?.startCalls === 1);
}

// ── shutdown ────────────────────────────────────────────────────────────────────────
{
  const r = rig();
  r.manager.create(spec('dc-a'));
  r.manager.create(spec('dc-b'));
  await flush();
  r.outcomes.get('dc-b')!({ status: 'completed', completionReason: 'stopped' });
  await r.manager.shutdown();
  check('shutdown stops every live session', r.sessions.get('dc-a')?.stops.length === 1);
  check('shutdown does not re-stop an already-stopped session', r.sessions.get('dc-b')?.stops.length === 0);
  check('shutdown clears the registry and retention timers',
    r.manager.size === 0 && r.timers.pending() === 0);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall session-manager checks passed');
process.exit(failed ? 1 : 0);
