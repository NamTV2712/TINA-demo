/**
 * L2 — the Discord voice-session state machine.
 *
 * These checks prove the lifecycle contract, not the Gateway: join → active is reported in
 * order, every terminal is emitted exactly once with the right reason, alone timers honour the
 * invocation's automaticLeave windows, a stop during the join never becomes an active meeting,
 * and a channel slot is safe to reuse.
 *
 * Run: npx tsx src/session.test.ts
 */
import { DiscordVoiceSession, type SessionOutcome, type SessionSpec } from './session.js';
import type {
  LanePort,
  LifecycleEvent,
  LifecyclePort,
  Scheduler,
  VoicePort,
  VoiceSessionHandle,
  VoiceState,
  VoiceTarget,
  VoiceUser,
} from './ports.js';
import type { Invocation } from './config.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise<void>((r) => setTimeout(r, 0));
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

// ── fakes ────────────────────────────────────────────────────────────────────────────

class FakeScheduler implements Scheduler {
  time = 1_700_000_000_000;
  private seq = 0;
  private tasks: Array<{ id: number; at: number; fn: () => void }> = [];
  now(): number { return this.time; }
  after(ms: number, fn: () => void): () => void {
    const task = { id: ++this.seq, at: this.time + ms, fn };
    this.tasks.push(task);
    return () => { this.tasks = this.tasks.filter((t) => t !== task); };
  }
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      this.tasks.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.tasks[0];
      if (!next || next.at > target) break;
      this.tasks.shift();
      this.time = next.at;
      next.fn();
      await flush();
    }
    this.time = target;
    await flush();
  }
}

class FakeHandle implements VoiceSessionHandle {
  leaves = 0;
  private audio?: (userId: string, pcm: Int16Array, tsMs: number) => void;
  private joinCb?: (userId: string, displayName?: string) => void;
  private leaveCb?: (userId: string) => void;
  private stateCb?: (state: VoiceState, reason?: string) => void;
  constructor(readonly guildId: string, readonly channelId: string, public users: VoiceUser[] = []) {}
  onUserAudio(h: (userId: string, pcm: Int16Array, tsMs: number) => void): void { this.audio = h; }
  onUserJoin(h: (userId: string, displayName?: string) => void): void { this.joinCb = h; }
  onUserLeave(h: (userId: string) => void): void { this.leaveCb = h; }
  onStateChange(h: (state: VoiceState, reason?: string) => void): void { this.stateCb = h; }
  presentUsers(): VoiceUser[] { return [...this.users]; }
  async leave(): Promise<void> { this.leaves++; }
  join(userId: string, displayName: string): void {
    this.users.push({ userId, displayName });
    this.joinCb?.(userId, displayName);
  }
  leaveChannel(userId: string): void {
    this.users = this.users.filter((u) => u.userId !== userId);
    this.leaveCb?.(userId);
  }
  audioPacket(userId: string, pcm: Int16Array, tsMs: number): void { this.audio?.(userId, pcm, tsMs); }
  state(state: VoiceState, reason?: string): void { this.stateCb?.(state, reason); }
}

class FakeVoice implements VoicePort {
  target?: VoiceTarget;
  handle?: FakeHandle;
  joinImpl: (target: VoiceTarget) => Promise<VoiceSessionHandle> = async (target) => {
    this.handle = new FakeHandle(target.guildId, target.channelId);
    return this.handle;
  };
  async join(target: VoiceTarget): Promise<VoiceSessionHandle> {
    this.target = target;
    return this.joinImpl(target);
  }
}

interface Frame { channel: number; name?: string; pcm: Float32Array; tsMs: number; participantId?: string | null }

class FakeLane implements LanePort {
  frames: Frame[] = [];
  stops = 0;
  feedAudio(channel: number, name: string | undefined, pcm: Float32Array, tsMs: number, participantId?: string | null): void {
    this.frames.push({ channel, name, pcm, tsMs, participantId });
  }
  async stop(): Promise<void> { this.stops++; }
}

class FakeLifecycle implements LifecyclePort {
  events: LifecycleEvent[] = [];
  async emit(event: LifecycleEvent): Promise<void> { this.events.push(event); }
}

function invocation(over: Partial<Invocation> = {}): Invocation {
  return {
    platform: 'discord',
    meetingUrl: 'https://discord.com/channels/111111111111111111/222222222222222222',
    nativeMeetingId: '111111111111111111:222222222222222222',
    botName: 'TINA',
    redisUrl: 'redis://localhost:6379/0',
    connectionId: 'conn-1',
    meeting_id: 42,
    ...over,
  };
}

interface Harness {
  session: DiscordVoiceSession;
  voice: FakeVoice;
  lane: FakeLane;
  lifecycle: FakeLifecycle;
  scheduler: FakeScheduler;
  handle?: FakeHandle;
  closed(): number;
  terminal(): SessionOutcome | undefined;
}

function harness(spec: Partial<SessionSpec> = {}, opts: { maxChannels?: number } = {}): Harness {
  const scheduler = new FakeScheduler();
  const voice = new FakeVoice();
  const lane = new FakeLane();
  const lifecycle = new FakeLifecycle();
  let closes = 0;
  let outcome: SessionOutcome | undefined;
  const session = new DiscordVoiceSession(
    {
      voice,
      lane,
      lifecycle,
      scheduler,
      maxChannels: opts.maxChannels,
      close: async () => { closes++; },
      onTerminal: (o) => { outcome = o; },
    },
    {
      workloadId: 'dc-1-test',
      invocation: invocation(),
      guildId: '111111111111111111',
      channelId: '222222222222222222',
      ...spec,
    },
  );
  const h: Harness = {
    session,
    voice,
    lane,
    lifecycle,
    scheduler,
    get handle() { return voice.handle; },
    closed: () => closes,
    terminal: () => outcome,
  };
  return h;
}

/** One 20 ms stereo packet of a 440 Hz tone (RMS well above the lane's gate). */
function packet(frames = 960): Int16Array {
  const out = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 440 * i) / 48_000));
    out[2 * i] = v;
    out[2 * i + 1] = v;
  }
  return out;
}

// ── happy path: joining → active → completed(stopped) ────────────────────────────────
{
  const h = harness();
  h.voice.handle = undefined;
  h.voice.joinImpl = async (target) => {
    const handle = new FakeHandle(target.guildId, target.channelId, [{ userId: 'u1', displayName: 'Alice' }]);
    h.voice.handle = handle;
    return handle;
  };
  await h.session.start();
  check('lifecycle is joining then active', h.lifecycle.events.map((e) => e.status).join(',') === 'joining,active',
    h.lifecycle.events.map((e) => e.status).join(','));
  check('joining carries connection + container ids',
    h.lifecycle.events[0]?.connection_id === 'conn-1' && h.lifecycle.events[0]?.container_id === 'dc-1-test');

  const handle = h.handle!;
  handle.audioPacket('u1', packet(), 1_700_000_001_000);
  handle.audioPacket('u1', packet(), 1_700_000_001_020);
  check('audio becomes 16 kHz frames on channel 0', h.lane.frames.length >= 2 && h.lane.frames.every((f) => f.channel === 0));
  check('speaker name + participant id ride the lane', h.lane.frames[0]?.name === 'Alice' && h.lane.frames[0]?.participantId === 'u1');
  check('resampled frame is 320 samples at steady state', h.lane.frames[1]?.pcm.length === 320, String(h.lane.frames[1]?.pcm.length));

  await h.session.stop('stopped');
  const terminal = h.lifecycle.events.at(-1)!;
  check('terminal is completed(stopped)', terminal.status === 'completed' && terminal.completion_reason === 'stopped');
  check('voice handle left exactly once', handle.leaves === 1, String(handle.leaves));
  check('lane stopped and egress closed', h.lane.stops === 1 && h.closed() === 1);

  await h.session.stop('left_alone');
  check('a second stop emits no second terminal', h.lifecycle.events.filter((e) => e.status === 'completed' || e.status === 'failed').length === 1);
  check('a second stop does not re-leave', handle.leaves === 1);
}

// ── startup_alone: nobody ever joins ─────────────────────────────────────────────────
{
  const h = harness();
  await h.session.start();
  await h.scheduler.advance(599_999);
  check('no terminal before noOneJoinedTimeout', h.session.phase === 'active');
  await h.scheduler.advance(1);
  check('empty channel → completed(startup_alone)', h.lifecycle.events.at(-1)?.completion_reason === 'startup_alone',
    JSON.stringify(h.lifecycle.events.at(-1)));
  check('startup_alone leaves the channel', h.handle?.leaves === 1);
}

// ── startup timer cancels when the first human joins ────────────────────────────────
{
  const h = harness();
  await h.session.start();
  h.handle!.join('u1', 'Alice');
  await h.scheduler.advance(900_000);
  check('a participant cancels startup_alone', h.lifecycle.events.length === 2, String(h.lifecycle.events.length));
}

// ── everyone left → left_alone, and a rejoin cancels it ─────────────────────────────
{
  const h = harness();
  h.voice.joinImpl = async (target) => {
    const handle = new FakeHandle(target.guildId, target.channelId, [{ userId: 'u1', displayName: 'Alice' }]);
    h.voice.handle = handle;
    return handle;
  };
  await h.session.start();
  h.handle!.leaveChannel('u1');
  await h.scheduler.advance(120_000);
  check('empty channel after humans → completed(left_alone)', h.lifecycle.events.at(-1)?.completion_reason === 'left_alone');

  const r = harness();
  r.voice.joinImpl = async (target) => {
    const handle = new FakeHandle(target.guildId, target.channelId, [{ userId: 'u1', displayName: 'Alice' }]);
    r.voice.handle = handle;
    return handle;
  };
  await r.session.start();
  r.handle!.leaveChannel('u1');
  await r.scheduler.advance(60_000);
  r.handle!.join('u1', 'Alice');
  await r.scheduler.advance(180_000);
  check('a rejoin cancels left_alone', r.lifecycle.events.length === 2, String(r.lifecycle.events.length));
}

// ── stop while joining: never active, failed(stopped, joining) ──────────────────────
{
  const h = harness();
  let resolveJoin!: (handle: VoiceSessionHandle) => void;
  h.voice.joinImpl = () => new Promise((resolve) => { resolveJoin = resolve; });
  const started = h.session.start();
  await flush();
  check('joining is reported before the join settles', h.lifecycle.events.map((e) => e.status).join(',') === 'joining');

  const stopper = h.session.stop('stopped', 'user pressed stop');
  await flush();
  const handle = new FakeHandle(h.voice.target!.guildId, h.voice.target!.channelId);
  resolveJoin(handle);
  await Promise.all([started, stopper]);

  const terminal = h.lifecycle.events.at(-1)!;
  check('stopped while joining is failed(stopped, joining)',
    terminal.status === 'failed' && terminal.completion_reason === 'stopped' && terminal.failure_stage === 'joining',
    JSON.stringify(terminal));
  check('no active event after a pre-active stop', !h.lifecycle.events.some((e) => e.status === 'active'));
  check('the late join is still left', handle.leaves === 1);
}

// ── join failure ────────────────────────────────────────────────────────────────────
{
  const h = harness();
  h.voice.joinImpl = async () => { throw new Error('unknown channel'); };
  await h.session.start();
  const terminal = h.lifecycle.events.at(-1)!;
  check('join failure is failed(join_failure, joining)',
    terminal.status === 'failed' && terminal.completion_reason === 'join_failure' && terminal.failure_stage === 'joining');
  check('join failure names the reason', terminal.reason === 'unknown channel');
  check('join failure still flushes + closes', h.lane.stops === 1 && h.closed() === 1);
}

// ── voice socket destroyed → failed(active) ─────────────────────────────────────────
{
  const h = harness();
  await h.session.start();
  h.handle!.state('destroyed');
  await flush();
  const terminal = h.lifecycle.events.at(-1)!;
  check('destroyed socket → failed(join_failure, active)',
    terminal.status === 'failed' && terminal.completion_reason === 'join_failure' && terminal.failure_stage === 'active',
    JSON.stringify(terminal));
}

// ── disconnected gets a grace window, ready cancels it ──────────────────────────────
{
  const h = harness({}, {});
  await h.session.start();
  h.handle!.state('disconnected', 'websocket close 1006');
  await h.scheduler.advance(29_999);
  check('disconnected within grace does not terminate', h.session.phase === 'active');
  h.handle!.state('ready');
  await h.scheduler.advance(120_000);
  check('ready cancels the disconnect failure', h.session.phase === 'active' && h.lifecycle.events.length === 2);

  const lost = harness();
  await lost.session.start();
  lost.handle!.state('disconnected');
  await lost.scheduler.advance(30_000);
  check('disconnected past grace → failed', lost.lifecycle.events.at(-1)?.status === 'failed');
}

// ── max active time ────────────────────────────────────────────────────────────────
{
  const h = harness({ maxActiveMs: 1_000 });
  await h.session.start();
  await h.scheduler.advance(1_000);
  check('maxActiveMs → completed(max_bot_time_exceeded)',
    h.lifecycle.events.at(-1)?.completion_reason === 'max_bot_time_exceeded');
}

// ── channel pool: reuse after leave, LRU eviction at capacity ───────────────────────
{
  const h = harness({}, { maxChannels: 2 });
  await h.session.start();
  h.handle!.audioPacket('u1', packet(), 1_000);
  h.handle!.audioPacket('u1', packet(), 1_020);
  h.handle!.audioPacket('u2', packet(), 2_000);
  h.handle!.audioPacket('u2', packet(), 2_020);
  const u1Channel = h.lane.frames.find((f) => f.participantId === 'u1')?.channel;
  const u2Channel = h.lane.frames.find((f) => f.participantId === 'u2')?.channel;
  check('two speakers get two distinct channels', u1Channel === 0 && u2Channel === 1, `${u1Channel}/${u2Channel}`);

  h.handle!.leaveChannel('u1');
  h.handle!.audioPacket('u3', packet(), 3_000);
  h.handle!.audioPacket('u3', packet(), 3_020);
  check('a freed channel is reused', h.lane.frames.find((f) => f.participantId === 'u3')?.channel === 0);

  // u2 is now the only live speaker; a third concurrent speaker must evict the LRU (u2).
  h.handle!.audioPacket('u4', packet(), 4_000);
  h.handle!.audioPacket('u4', packet(), 4_020);
  check('the least-recently-heard speaker is evicted at capacity',
    h.lane.frames.find((f) => f.participantId === 'u4')?.channel === 1);
}

console.log(failed === 0 ? '\nsession: all checks passed' : `\nsession: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
