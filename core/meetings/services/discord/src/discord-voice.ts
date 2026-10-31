/**
 * The real Discord voice adapter.
 *
 * One `joinVoiceChannel` per session, with `group` set to the workload id so two sessions can
 * never share a connection (the library otherwise caches one connection per guild). Voice
 * receive is per-user: `receiver.subscribe(userId, { end: Manual })` yields one stream of Opus
 * packets per speaker, exactly the topology TINA's per-channel lane expects.
 *
 * Two things this adapter owns and the state machine must not know about:
 *   • **DAVE.** Discord voice is end-to-end encrypted; `daveEncryption: true` (the default, stated
 *     explicitly) makes `@discordjs/voice` decrypt each packet before it reaches the stream. A
 *     build without `@snazzah/davey` fails to join encrypted channels — treated as a join failure.
 *   • **Timestamps.** Packets arrive in bursts; wall-clock arrival is not the audio clock. Each
 *     user's stream gets a synthetic monotonic cursor advanced by the decoded duration, and it is
 *     re-anchored to `Date.now()` after a ≥1 s packet gap (the lane closes a turn at that gap
 *     anyway), so absolute segment times stay truthful across pauses.
 *
 * Display names are best-effort: server nickname → global name → username → user id. The user id
 * always rides `participantId`, so a name miss degrades a label, never the identity.
 */
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type AudioReceiveStream,
  type VoiceConnection,
} from '@discordjs/voice';
import type { Client, Guild, GuildMember, VoiceBasedChannel, VoiceState } from 'discord.js';
import OpusScript from 'opusscript';
import { opusPacketDecoder, type OpusPacketDecoder } from './audio.js';
import type {
  VoicePort,
  VoiceSessionHandle,
  VoiceState as TinaVoiceState,
  VoiceTarget,
  VoiceUser,
} from './ports.js';

/** The decoder surface (opusscript fulfils it; tests can inject a fake). */
export interface OpusDecoderHandle {
  decode(packet: Uint8Array): Uint8Array | Buffer;
  delete?(): void;
}

export interface DiscordVoicePortOptions {
  client: Client;
  /** How long a join may take before it is declared a failure. Default 30 s. */
  joinTimeoutMs?: number;
  /** Passed to joinVoiceChannel — noisy, off by default. */
  debug?: boolean;
  log?: (message: string) => void;
  /** Injected for tests; production uses `joinVoiceChannel`. */
  joinImpl?: typeof joinVoiceChannel;
  /** Injected for tests; production builds an `OpusScript(48000, 2)`. */
  decoderFactory?: () => OpusDecoderHandle;
}

const SPEAKING_GAP_RESET_MS = 1000;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function displayNameFor(member: GuildMember | null | undefined, userId: string): string {
  if (!member) return userId;
  return member.displayName || member.user.globalName || member.user.username || userId;
}

/** Wrap a decoder so the session's audio port stays a plain `(userId, pcm, ts)` callback. */
function makeDecoder(factory: () => OpusDecoderHandle): { decode: OpusPacketDecoder; free: () => void } {
  const decoder = factory();
  const decode = opusPacketDecoder(decoder);
  return {
    decode,
    free: () => {
      try {
        decoder.delete?.();
      } catch {
        /* already freed / WASM teardown — nothing useful to do */
      }
    },
  };
}

export function createDiscordVoicePort(opts: DiscordVoicePortOptions): VoicePort {
  const {
    client,
    joinTimeoutMs = 30_000,
    debug = false,
    joinImpl = joinVoiceChannel,
    log = (m) => console.log(`[discord] voice: ${m}`),
  } = opts;
  const decoderFactory = opts.decoderFactory ?? (() => new OpusScript(48_000, 2, OpusScript.Application.AUDIO));

  return {
    async join(target: VoiceTarget): Promise<VoiceSessionHandle> {
      const guild = await resolveGuild(client, target.guildId);
      const channel = await resolveVoiceChannel(guild, target.channelId);

      let connection: VoiceConnection;
      try {
        connection = joinImpl({
          guildId: target.guildId,
          channelId: target.channelId,
          // A group isolates the connection: two workloads never share one guild-level connection.
          group: target.group ?? target.guildId,
          adapterCreator: guild.voiceAdapterCreator,
          // Receiving requires NOT being deafened; the bot never speaks in this increment.
          selfDeaf: false,
          selfMute: true,
          // Mandatory for Discord voice since 2026-03-01; explicit so a future refactor cannot
          // silently turn it off.
          daveEncryption: true,
          debug,
        });
      } catch (e) {
        throw new Error(`voice join failed for ${target.guildId}/${target.channelId}: ${errorText(e)}`);
      }

      try {
        await entersState(connection, VoiceConnectionStatus.Ready, joinTimeoutMs);
      } catch (e) {
        try {
          connection.destroy();
        } catch {
          /* best effort */
        }
        throw new Error(
          `voice connection to ${target.guildId}/${target.channelId} was not ready within ${joinTimeoutMs}ms: ${errorText(e)}`,
        );
      }

      return new DiscordVoiceHandle({ client, guild, channel, connection, decoderFactory, log });
    },
  };
}

async function resolveGuild(client: Client, guildId: string): Promise<Guild> {
  const cached = client.guilds.cache.get(guildId);
  if (cached) return cached;
  try {
    return await client.guilds.fetch(guildId);
  } catch (e) {
    throw new Error(`guild ${guildId} is not available to the bot: ${errorText(e)}`);
  }
}

async function resolveVoiceChannel(guild: Guild, channelId: string): Promise<VoiceBasedChannel> {
  const cached = guild.channels.cache.get(channelId);
  const channel = cached ?? await guild.channels.fetch(channelId).catch((e: unknown) => {
    throw new Error(`channel ${channelId} is not available to the bot: ${errorText(e)}`);
  });
  if (!channel) throw new Error(`channel ${channelId} does not exist`);
  if (!channel.isVoiceBased()) throw new Error(`channel ${channelId} is not a voice channel`);
  return channel;
}

interface HandleOptions {
  client: Client;
  guild: Guild;
  channel: VoiceBasedChannel;
  connection: VoiceConnection;
  decoderFactory: () => OpusDecoderHandle;
  log: (message: string) => void;
}

class DiscordVoiceHandle implements VoiceSessionHandle {
  readonly guildId: string;
  readonly channelId: string;

  private readonly client: Client;
  private readonly guild: Guild;
  private readonly channel: VoiceBasedChannel;
  private readonly connection: VoiceConnection;
  private readonly decoderFactory: () => OpusDecoderHandle;
  private readonly log: (message: string) => void;

  private readonly audioHandlers: Array<(userId: string, pcm: Int16Array, tsMs: number) => void> = [];
  private readonly joinHandlers: Array<(userId: string, displayName?: string) => void> = [];
  private readonly leaveHandlers: Array<(userId: string) => void> = [];
  private readonly stateHandlers: Array<(state: TinaVoiceState, reason?: string) => void> = [];

  private readonly roster = new Map<string, VoiceUser>();
  private readonly streams = new Map<string, { stream: AudioReceiveStream; free: () => void }>();
  private lastState: TinaVoiceState = 'connecting';
  private lastReason?: string;
  private leaving = false;
  private left = false;

  private readonly onVoiceStateUpdateBound = (oldState: VoiceState, newState: VoiceState): void =>
    this.onVoiceStateUpdate(oldState, newState);

  constructor(o: HandleOptions) {
    this.guildId = o.guild.id;
    this.channelId = o.channel.id;
    this.client = o.client;
    this.guild = o.guild;
    this.channel = o.channel;
    this.connection = o.connection;
    this.decoderFactory = o.decoderFactory;
    this.log = o.log;

    this.seedRoster();
    this.client.on('voiceStateUpdate', this.onVoiceStateUpdateBound);
    this.wireConnectionState();
    this.wireSpeaking();
    // Pre-subscribe every present member so a person already talking when the bot joins is not
    // missed while waiting for their next speaking edge.
    for (const user of this.roster.keys()) this.subscribeUser(user);
  }

  // ── roster ────────────────────────────────────────────────────────────────────────

  private seedRoster(): void {
    const seen = new Set<string>();
    const add = (member: GuildMember | null | undefined): void => {
      if (!member || member.user.bot || seen.has(member.id)) return;
      seen.add(member.id);
      this.roster.set(member.id, { userId: member.id, displayName: displayNameFor(member, member.id) });
    };
    // channel.members is the primary cache; voiceStates covers a partially hydrated channel cache.
    for (const member of this.channel.members.values()) add(member);
    for (const state of this.guild.voiceStates.cache.values()) {
      if (state.channelId === this.channelId) add(state.member);
    }
  }

  presentUsers(): VoiceUser[] {
    return [...this.roster.values()];
  }

  private onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    if (this.leaving) return;
    if (newState.guild.id !== this.guildId && oldState.guild.id !== this.guildId) return;

    const was = oldState.channelId === this.channelId;
    const now = newState.channelId === this.channelId;
    if (now && !was) {
      const member = newState.member;
      if (member?.user.bot) return;
      const userId = newState.id;
      const user: VoiceUser = { userId, displayName: displayNameFor(member, userId) };
      this.roster.set(userId, user);
      this.subscribeUser(userId);
      for (const handler of this.joinHandlers) handler(userId, user.displayName);
      return;
    }
    if (was && !now) {
      // A bot leaving is not a participant change for the transcript; it is also not in the roster.
      if (!this.roster.has(newState.id)) return;
      this.roster.delete(newState.id);
      this.unsubscribeUser(newState.id);
      for (const handler of this.leaveHandlers) handler(newState.id);
    }
  }

  // ── receive ───────────────────────────────────────────────────────────────────────

  private wireSpeaking(): void {
    // A speaking edge is the earliest signal that a new SSRC is about to deliver packets. Voice
    // state updates normally subscribe first; this is the belt for a join we did not observe.
    this.connection.receiver.speaking.on('start', (userId: string) => {
      if (this.leaving) return;
      if (!this.roster.has(userId)) {
        const member = this.guild.members.cache.get(userId);
        if (member?.user.bot) return;
        const user: VoiceUser = { userId, displayName: displayNameFor(member, userId) };
        this.roster.set(userId, user);
        for (const handler of this.joinHandlers) handler(userId, user.displayName);
      }
      this.subscribeUser(userId);
    });
  }

  private subscribeUser(userId: string): void {
    if (this.leaving || this.streams.has(userId)) return;
    let stream: AudioReceiveStream;
    try {
      stream = this.connection.receiver.subscribe(userId, {
        // Manual: the stream lives for the whole session. The lane, not the transport, decides
        // when a speaker's turn ends (a 1 s gap), so a pause must not tear the subscription down.
        end: { behavior: EndBehaviorType.Manual },
      });
    } catch (e) {
      this.log(`subscribe(${userId}) failed: ${errorText(e)}`);
      return;
    }

    const decoder = makeDecoder(this.decoderFactory);
    let nextTsMs = 0;
    let lastArrivalMs = 0;
    let closed = false;

    const onData = (packet: Buffer): void => {
      if (this.leaving || closed) return;
      const arrival = Date.now();
      // A burst after a pause is a new turn on the lane's clock. Re-anchor so absolute times do
      // not drift by the length of the silence.
      if (nextTsMs === 0 || arrival - lastArrivalMs >= SPEAKING_GAP_RESET_MS) nextTsMs = arrival;
      lastArrivalMs = arrival;

      let pcm: Int16Array;
      try {
        pcm = decoder.decode(packet);
      } catch (e) {
        // A corrupt/lost packet must not kill the speaker's whole stream.
        this.log(`opus decode failed for ${userId}: ${errorText(e)}`);
        return;
      }
      if (pcm.length === 0) return;

      const startMs = nextTsMs;
      // 48 kHz stereo s16: every frame is 2 samples of 2 bytes.
      nextTsMs += (pcm.length / 2 / 48_000) * 1000;
      for (const handler of this.audioHandlers) handler(userId, pcm, startMs);
    };
    const onError = (e: Error): void => {
      this.log(`receive stream error for ${userId}: ${errorText(e)}`);
    };
    const onClose = (): void => {
      closed = true;
      stream.off('data', onData);
      stream.off('error', onError);
      decoder.free();
      const current = this.streams.get(userId);
      if (current?.stream === stream) this.streams.delete(userId);
    };

    stream.on('data', onData);
    stream.on('error', onError);
    stream.on('close', onClose);
    this.streams.set(userId, { stream, free: () => stream.destroy() });
  }

  private unsubscribeUser(userId: string): void {
    const entry = this.streams.get(userId);
    if (!entry) return;
    this.streams.delete(userId);
    entry.free();
  }

  // ── connection state ─────────────────────────────────────────────────────────────

  private wireConnectionState(): void {
    this.connection.on('stateChange', (oldState, newState) => {
      if (this.leaving) return;
      switch (newState.status) {
        case VoiceConnectionStatus.Connecting:
        case VoiceConnectionStatus.Signalling:
          this.emitState('connecting');
          break;
        case VoiceConnectionStatus.Ready:
          this.emitState('ready');
          break;
        case VoiceConnectionStatus.Disconnected: {
          const detail = newState as { reason?: number; closeCode?: number };
          this.emitState(
            'disconnected',
            detail.closeCode !== undefined ? `websocket close ${detail.closeCode}` : `reason ${detail.reason ?? 'unknown'}`,
          );
          break;
        }
        case VoiceConnectionStatus.Destroyed:
          this.emitState('destroyed', oldState.status);
          break;
        default:
          break;
      }
    });
  }

  private emitState(state: TinaVoiceState, reason?: string): void {
    this.lastState = state;
    this.lastReason = reason;
    for (const handler of this.stateHandlers) handler(state, reason);
  }

  onStateChange(handler: (state: TinaVoiceState, reason?: string) => void): void {
    this.stateHandlers.push(handler);
    // Replay a state that settled before the session attached (join awaits Ready, so 'ready' is
    // the normal replay; 'destroyed' is the one that matters).
    if (this.lastState === 'ready' || this.lastState === 'destroyed') {
      const state = this.lastState;
      const reason = this.lastReason;
      queueMicrotask(() => handler(state, reason));
    }
  }

  // ── public wiring ────────────────────────────────────────────────────────────────

  onUserAudio(handler: (userId: string, pcm: Int16Array, tsMs: number) => void): void {
    this.audioHandlers.push(handler);
  }

  onUserJoin(handler: (userId: string, displayName?: string) => void): void {
    this.joinHandlers.push(handler);
  }

  onUserLeave(handler: (userId: string) => void): void {
    this.leaveHandlers.push(handler);
  }

  async leave(): Promise<void> {
    if (this.left) return;
    this.left = true;
    this.leaving = true;
    this.audioHandlers.length = 0;
    this.joinHandlers.length = 0;
    this.leaveHandlers.length = 0;
    this.stateHandlers.length = 0;
    try {
      this.client.off('voiceStateUpdate', this.onVoiceStateUpdateBound);
    } catch {
      /* listener already gone */
    }
    for (const userId of [...this.streams.keys()]) this.unsubscribeUser(userId);
    try {
      this.connection.destroy();
    } catch (e) {
      this.log(`connection.destroy failed: ${errorText(e)}`);
    }
    this.roster.clear();
  }
}
