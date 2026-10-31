/**
 * The Discord voice-session state machine.
 *
 * One instance = one `runtime.v1` workload = one voice channel. It is pure logic over the
 * injected ports, so the whole path — join, roster, alone timers, voice loss, stop — is provable
 * offline (session.test.ts) without a Gateway or a Whisper server.
 *
 * Lifecycle mapping (lifecycle.v1):
 *
 *   start ──► joining ──► active ──► completed(stopped | left_alone | startup_alone |
 *              │                      max_bot_time_exceeded)
 *              └──► failed(join_failure, joining)          join rejected/failed
 *                   failed(stopped, joining)               stop arrived while joining
 *                   failed(join_failure, active)           voice socket lost mid-meeting
 *
 * Terminal is emitted EXACTLY ONCE. A stop that arrives while the join is still in flight is
 * honoured by leaving as soon as the join settles and reporting `failed/stopped`, because the
 * lifecycle machine (correctly) has no `joining → completed` edge: the session never became a
 * served meeting, and it must not be counted as one.
 */
import { Pcm48kStereoTo16kMono } from './audio.js';
import type {
  CompletionReason,
  FailureStage,
  LanePort,
  LifecycleEvent,
  LifecyclePort,
  Scheduler,
  VoiceSessionHandle,
  VoiceState,
  VoicePort,
} from './ports.js';
import { realScheduler } from './ports.js';
import type { Invocation } from './config.js';

export const DEFAULT_NO_ONE_JOINED_MS = 600_000;
export const DEFAULT_EVERYONE_LEFT_MS = 120_000;
export const DEFAULT_DISCONNECT_GRACE_MS = 30_000;
export const DEFAULT_LANE_STOP_TIMEOUT_MS = 20_000;
export const DEFAULT_LIFECYCLE_TIMEOUT_MS = 20_000;
/** The gmeet lane's `AudioTimelinePool` budget is 16 sources. A fixed channel pool keeps every
 *  speaker inside it: a channel is a SLOT, not an identity (the name + participant id rotate the
 *  lane's turn), so reusing one is safe. */
export const DEFAULT_MAX_CHANNELS = 16;

export interface SessionSpec {
  /** The runtime workload id (`dc-…`). Used as `container_id` on lifecycle events. */
  workloadId: string;
  invocation: Invocation;
  guildId: string;
  channelId: string;
  /** Hard cap on the active phase (runtime.v1 `maxLifetimeSec`). 0/undefined = off. */
  maxActiveMs?: number;
}

export interface SessionOutcome {
  status: 'completed' | 'failed';
  completionReason: CompletionReason;
  failureStage?: FailureStage;
  reason?: string;
}

export type SessionPhase = 'idle' | 'joining' | 'active' | 'terminal';

export interface SessionDeps {
  voice: VoicePort;
  lane: LanePort;
  lifecycle: LifecyclePort;
  scheduler?: Scheduler;
  /** Release per-session egress (redis) after the lane is flushed. */
  close?: () => Promise<void>;
  onTerminal?: (outcome: SessionOutcome) => void;
  maxChannels?: number;
  disconnectGraceMs?: number;
  laneStopTimeoutMs?: number;
  lifecycleTimeoutMs?: number;
  log?: (message: string) => void;
}

interface SpeakerState {
  userId: string;
  name: string;
  channel: number;
  resampler: Pcm48kStereoTo16kMono;
  lastTsMs: number;
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Resolve when `p` settles or `ms` elapses — whichever is first. Used to bound teardown so a
 *  wedged STT or lifecycle endpoint can never strand a stop. */
function bounded(p: Promise<unknown>, ms: number, onTimeout: () => void): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (done) return;
      onTimeout();
      finish();
    }, ms);
    timer.unref?.();
    p.then(finish, finish);
  });
}

export class DiscordVoiceSession {
  readonly workloadId: string;
  readonly guildId: string;
  readonly channelId: string;

  private phaseValue: SessionPhase = 'idle';
  private startPromise?: Promise<void>;
  private finishing?: Promise<void>;
  private activeEmit?: Promise<void>;
  private outcomeValue?: SessionOutcome;
  private handle?: VoiceSessionHandle;
  private stopIntent?: { reason: CompletionReason; detail?: string };
  private everActive = false;
  private hadHumans = false;
  private readonly scheduler: Scheduler;
  private readonly log: (message: string) => void;
  private readonly timers = new Map<string, () => void>();
  private readonly roster = new Map<string, string>();
  private readonly speakers = new Map<string, SpeakerState>();
  private readonly freeChannels: number[];
  private readonly maxChannels: number;
  private readonly laneStopTimeoutMs: number;
  private readonly lifecycleTimeoutMs: number;
  private readonly disconnectGraceMs: number;

  constructor(private readonly deps: SessionDeps, private readonly spec: SessionSpec) {
    this.workloadId = spec.workloadId;
    this.guildId = spec.guildId;
    this.channelId = spec.channelId;
    this.scheduler = deps.scheduler ?? realScheduler;
    this.log = deps.log ?? ((m) => console.log(`[discord] ${m}`));
    this.maxChannels = Math.max(1, deps.maxChannels ?? DEFAULT_MAX_CHANNELS);
    this.freeChannels = Array.from({ length: this.maxChannels }, (_, i) => i);
    this.laneStopTimeoutMs = deps.laneStopTimeoutMs ?? DEFAULT_LANE_STOP_TIMEOUT_MS;
    this.lifecycleTimeoutMs = deps.lifecycleTimeoutMs ?? DEFAULT_LIFECYCLE_TIMEOUT_MS;
    this.disconnectGraceMs = deps.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS;
  }

  get phase(): SessionPhase {
    return this.phaseValue;
  }

  get outcome(): SessionOutcome | undefined {
    return this.outcomeValue;
  }

  /** Users currently in the channel (never bots). */
  presentUsers(): string[] {
    return [...this.roster.keys()];
  }

  // Property reads through methods: `stop()` mutates phase/intent while `run()` is suspended at
  // an await, and TypeScript's property narrowing otherwise assumes the pre-await value is stable.
  private currentPhase(): SessionPhase {
    return this.phaseValue;
  }

  private currentStopIntent(): { reason: CompletionReason; detail?: string } | undefined {
    return this.stopIntent;
  }

  /** Begin joining. Resolves when the session is active or terminal; callers that need the
   *  runtime.v1 201 immediately must NOT await it. */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.phaseValue = 'joining';
    this.startPromise = this.run();
    return this.startPromise;
  }

  /**
   * Ask the session to end. `reason` is the lifecycle completion reason for an active session.
   * Idempotent: the first reason wins (except that a default `stopped` never overwrites a timer's
   * more specific reason). Resolves after teardown + the terminal event.
   */
  async stop(reason: CompletionReason = 'stopped', detail?: string): Promise<void> {
    if (this.currentPhase() === 'terminal') {
      await this.finishing;
      return;
    }
    const existing = this.currentStopIntent();
    if (!existing) this.stopIntent = { reason, detail };
    else if (existing.reason === 'stopped' && reason !== 'stopped') this.stopIntent = { reason, detail };

    if (this.currentPhase() === 'idle') {
      await this.start();
    }
    if (this.currentPhase() === 'joining') {
      await this.startPromise;
      return;
    }
    if (this.currentPhase() === 'active') {
      if (this.activeEmit) await this.activeEmit;
      const intent = this.currentStopIntent();
      if (!intent || this.currentPhase() === 'terminal') return;
      await this.finalize('completed', intent.reason, intent.detail);
    }
  }

  // ── join / activate ─────────────────────────────────────────────────────────────────

  private async run(): Promise<void> {
    try {
      await this.safeEmit(this.event('joining'));
      // A stop that landed while the joining event was in flight must not put a bot in a
      // channel the user already said no to.
      const early = this.currentStopIntent();
      if (early) {
        return this.finishPreActive('stopped', early.detail ?? 'stopped while joining');
      }

      let handle: VoiceSessionHandle;
      try {
        handle = await this.deps.voice.join({
          guildId: this.guildId,
          channelId: this.channelId,
          botName: this.spec.invocation.botName,
          group: this.workloadId,
        });
      } catch (e) {
        const stopped = this.currentStopIntent();
        if (stopped) {
          return this.finishPreActive('stopped', `stopped while joining: ${errorText(e)}`);
        }
        return this.finishPreActive('join_failure', errorText(e));
      }
      this.handle = handle;

      const late = this.currentStopIntent();
      if (late) {
        await this.leaveQuietly();
        this.handle = undefined;
        return this.finishPreActive('stopped', late.detail ?? 'stopped while joining');
      }

      this.attach(handle);
      this.phaseValue = 'active';
      this.everActive = true;
      this.activeEmit = this.safeEmit(this.event('active'));
      this.armTimers();
      await this.activeEmit;
    } catch (e) {
      // Defensive: nothing above should throw, but a port that does must still terminate
      // truthfully rather than leave a workload running with no session behind it.
      await this.finalize(
        'failed',
        'join_failure',
        errorText(e),
        this.everActive ? 'active' : 'joining',
      );
    }
  }

  private attach(handle: VoiceSessionHandle): void {
    handle.onUserAudio((userId, pcm, tsMs) => this.onAudio(userId, pcm, tsMs));
    handle.onUserJoin((userId, displayName) => this.onUserJoin(userId, displayName));
    handle.onUserLeave((userId) => this.onUserLeave(userId));
    handle.onStateChange((state, reason) => this.onVoiceState(state, reason));

    try {
      for (const user of handle.presentUsers()) {
        this.roster.set(user.userId, user.displayName || 'Speaker');
      }
    } catch (e) {
      this.log(`presentUsers() failed: ${errorText(e)}`);
    }
    if (this.roster.size > 0) this.hadHumans = true;
  }

  // ── roster ─────────────────────────────────────────────────────────────────────────

  private onUserJoin(userId: string, displayName?: string): void {
    const name = displayName || this.roster.get(userId) || 'Speaker';
    this.roster.set(userId, name);
    this.hadHumans = true;
    this.cancel('startupAlone');
    this.cancel('everyoneLeft');
    const speaker = this.speakers.get(userId);
    if (speaker) speaker.name = name;
  }

  private onUserLeave(userId: string): void {
    const known = this.roster.delete(userId);
    this.releaseSpeaker(userId);
    if (!known || this.phaseValue !== 'active') return;
    if (this.roster.size === 0) {
      this.armEveryoneLeft();
    }
  }

  private onAudio(userId: string, pcm: Int16Array, tsMs: number): void {
    if (this.phaseValue !== 'active') return;
    // Audio for a user the roster has not announced (a join edge can race the first packet):
    // treat them as present, so an empty channel can never look populated only to the lane.
    if (!this.roster.has(userId)) this.onUserJoin(userId, undefined);

    const speaker = this.speakerFor(userId);
    speaker.lastTsMs = tsMs;
    const mono = speaker.resampler.push(pcm);
    if (mono.length) this.feed(speaker, mono, tsMs);
  }

  private speakerFor(userId: string): SpeakerState {
    const existing = this.speakers.get(userId);
    const name = this.roster.get(userId) || 'Speaker';
    if (existing) {
      existing.name = name;
      return existing;
    }
    const channel = this.takeChannel();
    const speaker: SpeakerState = {
      userId,
      name,
      channel,
      resampler: new Pcm48kStereoTo16kMono(),
      lastTsMs: this.scheduler.now(),
    };
    this.speakers.set(userId, speaker);
    return speaker;
  }

  /** A channel slot: a free one, else the least-recently-heard speaker's. Identity rides the
   *  name/participant-id tuple, so a takeover is a turn rotation — never a mislabel. */
  private takeChannel(): number {
    const free = this.freeChannels.shift();
    if (free !== undefined) return free;
    let oldest: SpeakerState | undefined;
    for (const speaker of this.speakers.values()) {
      if (!oldest || speaker.lastTsMs < oldest.lastTsMs) oldest = speaker;
    }
    if (!oldest) return 0; // unreachable: the pool is non-empty and every slot is owned
    this.speakers.delete(oldest.userId);
    this.log(`channel ${oldest.channel} evicted ${oldest.userId} (pool of ${this.maxChannels})`);
    return oldest.channel;
  }

  private releaseSpeaker(userId: string): void {
    const speaker = this.speakers.get(userId);
    if (!speaker) return;
    // Flush the resampler's few-sample tail before handing the slot back, so the end of the
    // last word is not truncated by the slot change.
    const tail = speaker.resampler.flush();
    if (tail.length && this.phaseValue === 'active') this.feed(speaker, tail, speaker.lastTsMs + 20);
    this.speakers.delete(userId);
    if (!this.freeChannels.includes(speaker.channel)) this.freeChannels.push(speaker.channel);
  }

  private feed(speaker: SpeakerState, pcm: Float32Array, tsMs: number): void {
    try {
      this.deps.lane.feedAudio(speaker.channel, speaker.name, pcm, tsMs, speaker.userId);
    } catch (e) {
      this.log(`lane feed failed for ${speaker.userId}: ${errorText(e)}`);
    }
  }

  // ── connection state ──────────────────────────────────────────────────────────────

  private onVoiceState(state: VoiceState, reason?: string): void {
    if (state === 'ready') {
      this.cancel('disconnect');
      return;
    }
    if (state === 'disconnected') {
      // The library auto-reconnects for ordinary websocket closes. Give it a grace window
      // before declaring the meeting lost; 4014 (kicked) may never recover.
      this.log(`voice disconnected${reason ? ` (${reason})` : ''} — ${this.disconnectGraceMs}ms grace`);
      if (this.phaseValue === 'active' && !this.timers.has('disconnect')) {
        this.arm('disconnect', this.disconnectGraceMs, () => {
          void this.finalize('failed', 'join_failure', 'voice connection lost', 'active');
        });
      }
      return;
    }
    if (state === 'destroyed') {
      void this.finalize('failed', 'join_failure', 'voice connection destroyed', 'active');
    }
  }

  // ── timers ────────────────────────────────────────────────────────────────────────

  private armTimers(): void {
    const maxActive = this.spec.maxActiveMs ?? 0;
    if (maxActive > 0) {
      this.arm('maxActive', maxActive, () => {
        void this.stop('max_bot_time_exceeded', 'maximum session duration reached');
      });
    }
    if (this.roster.size === 0) this.armStartupAlone();
  }

  private armStartupAlone(): void {
    if (this.hadHumans) return;
    const timeout = this.spec.invocation.automaticLeave?.noOneJoinedTimeout ?? DEFAULT_NO_ONE_JOINED_MS;
    this.arm('startupAlone', timeout, () => {
      if (this.phaseValue === 'active' && this.roster.size === 0) {
        void this.stop('startup_alone', 'no participant joined the voice channel');
      }
    });
  }

  private armEveryoneLeft(): void {
    const timeout = this.spec.invocation.automaticLeave?.everyoneLeftTimeout ?? DEFAULT_EVERYONE_LEFT_MS;
    this.arm('everyoneLeft', timeout, () => {
      if (this.phaseValue === 'active' && this.roster.size === 0) {
        void this.stop('left_alone', 'everyone left the voice channel');
      }
    });
  }

  private arm(name: string, ms: number, fn: () => void): void {
    this.cancel(name);
    const cancel = this.scheduler.after(Math.max(0, ms), () => {
      this.timers.delete(name);
      fn();
    });
    this.timers.set(name, cancel);
  }

  private cancel(name: string): void {
    const cancel = this.timers.get(name);
    if (!cancel) return;
    cancel();
    this.timers.delete(name);
  }

  private cancelAllTimers(): void {
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }

  // ── terminal ─────────────────────────────────────────────────────────────────────

  private finishPreActive(reason: 'stopped' | 'join_failure', detail: string): Promise<void> {
    return this.finalize('failed', reason, detail, 'joining');
  }

  private finalize(
    status: 'completed' | 'failed',
    reason: CompletionReason,
    detail?: string,
    failureStage?: FailureStage,
  ): Promise<void> {
    if (this.finishing) return this.finishing;
    this.phaseValue = 'terminal';
    const outcome: SessionOutcome = {
      status,
      completionReason: reason,
      ...(status === 'failed' ? { failureStage: failureStage ?? (this.everActive ? 'active' : 'joining') } : {}),
      ...(detail ? { reason: detail } : {}),
    };
    this.outcomeValue = outcome;
    this.cancelAllTimers();
    this.finishing = this.doFinalize(outcome);
    return this.finishing;
  }

  private async doFinalize(outcome: SessionOutcome): Promise<void> {
    await this.leaveQuietly();

    await bounded(
      Promise.resolve().then(() => this.deps.lane.stop()),
      this.laneStopTimeoutMs,
      () => this.log(`lane stop timed out after ${this.laneStopTimeoutMs}ms`),
    );

    if (this.deps.close) {
      try {
        await this.deps.close();
      } catch (e) {
        this.log(`egress close failed: ${errorText(e)}`);
      }
    }

    const event: LifecycleEvent = outcome.status === 'completed'
      ? this.event('completed', { completion_reason: outcome.completionReason })
      : this.event('failed', {
          completion_reason: outcome.completionReason,
          failure_stage: outcome.failureStage ?? 'active',
          ...(outcome.reason ? { reason: outcome.reason } : {}),
        });
    await this.safeEmit(event);

    try {
      this.deps.onTerminal?.(outcome);
    } catch (e) {
      this.log(`onTerminal failed: ${errorText(e)}`);
    }
    this.log(`session ${this.workloadId} ${outcome.status} (${outcome.completionReason})`);
  }

  private async leaveQuietly(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    if (!handle) return;
    try {
      await handle.leave();
    } catch (e) {
      this.log(`voice leave failed: ${errorText(e)}`);
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────

  private event(
    status: LifecycleEvent['status'],
    extra: Partial<LifecycleEvent> = {},
  ): LifecycleEvent {
    return {
      connection_id: this.spec.invocation.connectionId ?? this.spec.workloadId,
      container_id: this.spec.workloadId,
      status,
      timestamp: new Date(this.scheduler.now()).toISOString(),
      ...extra,
    };
  }

  private async safeEmit(event: LifecycleEvent): Promise<void> {
    await bounded(
      Promise.resolve()
        .then(() => this.deps.lifecycle.emit(event))
        .catch((e: unknown) => this.log(`lifecycle ${event.status} emit failed: ${errorText(e)}`)),
      this.lifecycleTimeoutMs,
      () => this.log(`lifecycle ${event.status} emit timed out after ${this.lifecycleTimeoutMs}ms`),
    );
  }
}
