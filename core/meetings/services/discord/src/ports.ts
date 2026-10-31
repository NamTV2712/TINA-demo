/**
 * The connector's ports.
 *
 * Everything that touches the network or Discord sits behind one of these; the session state
 * machine (`session.ts`) is pure logic over them, so the join → active → leave path is provable
 * offline with fakes (session.test.ts). The real adapters live in `discord-voice.ts`,
 * `pipeline.ts` and `egress.ts`.
 */

export type VoiceState = 'connecting' | 'ready' | 'disconnected' | 'destroyed';

/** A non-bot guild member currently in the voice channel. */
export interface VoiceUser {
  userId: string;
  displayName: string;
}

/** One joined voice channel. The adapter owns the Gateway/VoiceConnection details; the core sees
 *  per-user decoded PCM and coarse connection state. */
export interface VoiceSessionHandle {
  readonly guildId: string;
  readonly channelId: string;
  /** One decoded 20 ms packet: interleaved 48 kHz stereo s16le. */
  onUserAudio(handler: (userId: string, pcm: Int16Array, tsMs: number) => void): void;
  /** A user's stream started (the adapter resolves a display name when it can). */
  onUserJoin(handler: (userId: string, displayName?: string) => void): void;
  /** A user's stream ended. */
  onUserLeave(handler: (userId: string) => void): void;
  /** Snapshot of every human currently in the channel (never bots). Used to seed the roster at
   *  join, before any voice-state edge arrives. */
  presentUsers(): VoiceUser[];
  onStateChange(handler: (state: VoiceState, reason?: string) => void): void;
  /** Leave the channel and release the voice connection. Idempotent. */
  leave(): Promise<void>;
}

export interface VoiceTarget {
  guildId: string;
  channelId: string;
  /** The bot's display name in the channel (from invocation.v1 `botName`). */
  botName: string;
  /** Isolates this voice connection from any other session in the same guild
   *  (`@discordjs/voice` otherwise caches one connection per guild). The session passes the
   *  workload id. */
  group?: string;
}

export interface VoicePort {
  /** Join a voice channel. Resolves once the Gateway has acknowledged the join (or rejects with
   *  a typed reason). The returned handle owns the per-user streams. */
  join(target: VoiceTarget): Promise<VoiceSessionHandle>;
}

/** The transcript lane, reduced to the one operation this platform needs: a named per-user
 *  channel frame. Identical in shape to the bot's `BotPipeline.feedAudio`, so a Discord speaker
 *  is just another channel with a name bound at capture. */
export interface LanePort {
  feedAudio(channel: number, glowName: string | undefined, pcm: Float32Array, tsMs: number, participantId?: string | null): void;
  /** Flush + dispose. Every buffered turn is finalized before this resolves. */
  stop(): Promise<void>;
}

export type LifecycleStatus = 'joining' | 'active' | 'completed' | 'failed';
export type CompletionReason =
  | 'stopped'
  | 'left_alone'
  | 'startup_alone'
  | 'evicted'
  | 'awaiting_admission_timeout'
  | 'awaiting_admission_rejected'
  | 'join_failure'
  | 'auth_session_missing'
  | 'validation_error'
  | 'max_bot_time_exceeded';
export type FailureStage = 'requested' | 'joining' | 'awaiting_admission' | 'active';

export interface LifecycleEvent {
  connection_id: string;
  container_id?: string;
  status: LifecycleStatus;
  timestamp?: string;
  completion_reason?: CompletionReason;
  failure_stage?: FailureStage;
  reason?: string;
  bot_logs?: string[];
}

export interface LifecyclePort {
  emit(event: LifecycleEvent): Promise<void>;
}

/** Injectable timers: the session's alone/lifetime windows must be testable without waiting. */
export interface Scheduler {
  /** Run `fn` after `ms`; returns a cancel function. */
  after(ms: number, fn: () => void): () => void;
  now(): number;
}

export const realScheduler: Scheduler = {
  after(ms, fn) {
    const t = setTimeout(fn, ms);
    // A pending alone-timer must never hold the process open past a leave.
    t.unref?.();
    return () => clearTimeout(t);
  },
  now: () => Date.now(),
};
