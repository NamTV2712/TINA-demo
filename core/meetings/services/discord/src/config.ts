/**
 * Connector configuration and contract loading.
 *
 * Two different config surfaces meet here:
 *
 *   • **Per session** — the `invocation.v1` object meeting-api ships as `TINA_BOT_CONFIG` in the
 *     runtime.v1 `WorkloadSpec.env`. It is validated against the PUBLISHED schema, loaded by
 *     path, exactly like `@tina/bot` does. Discord adds no private fields: the bot token is
 *     connector-level (one Gateway session for the whole connector), while everything that
 *     identifies the meeting rides the same contract as every other platform.
 *
 *   • **Connector-level** — the process env (`DISCORD_BOT_TOKEN`, port, guild allowlist, …).
 *     These are read once at boot and never per session.
 *
 * Fail-fast (P14): a malformed invocation or an explicit-but-invalid env value aborts with a
 * typed error. A default is only used when the variable is genuinely unset.
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Ajv, ValidateFunction } from 'ajv';
import addFormatsDefault from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// verbatimModuleSyntax (tsconfig.base): the CJS default export of ajv-formats isn't synthesized
// as callable, so bind its call signature explicitly. Runtime is unchanged.
const addFormats = addFormatsDefault as unknown as (ajv: Ajv) => Ajv;

const HERE = dirname(fileURLToPath(import.meta.url));
// src/ → ../../../contracts/invocation.v1/  (meetings/services/discord/src → meetings/contracts/…)
const INVOCATION_SCHEMA_PATH = join(HERE, '..', '..', '..', 'contracts', 'invocation.v1', 'invocation.schema.json');
// src/ → ../../../../runtime/contracts/runtime.v1/  (meetings/services/discord/src → core/runtime/…)
const RUNTIME_SCHEMA_PATH = join(HERE, '..', '..', '..', '..', 'runtime', 'contracts', 'runtime.v1', 'runtime.schema.json');

export type Platform = 'google_meet' | 'zoom' | 'teams' | 'jitsi' | 'discord';
export type TranscriptionTier = 'realtime' | 'deferred';

export interface AutomaticLeave {
  waitingRoomTimeout?: number;
  noOneJoinedTimeout?: number;
  everyoneLeftTimeout?: number;
}

/** The compile-time mirror of invocation.v1 `#/$defs/Invocation` (ajv is the runtime truth). */
export interface Invocation {
  platform: Platform;
  meetingUrl: string | null;
  botName: string;
  passcode?: string;
  nativeMeetingId?: string;
  token?: string;
  connectionId?: string;
  meeting_id?: number;
  container_name?: string;
  redisUrl: string;
  meetingApiCallbackUrl?: string;
  internalSecret?: string;
  language?: string | null;
  task?: string | null;
  allowedLanguages?: string[];
  transcribeEnabled?: boolean;
  transcriptionTier?: TranscriptionTier;
  transcriptionServiceUrl?: string;
  transcriptionServiceToken?: string;
  transcriptionModel?: string | null;
  recordingEnabled?: boolean;
  captureSignalEnabled?: boolean;
  captureModes?: string[];
  recordingUploadUrl?: string;
  automaticLeave?: AutomaticLeave;
  reconnectionIntervalMs?: number;
  voiceAgentEnabled?: boolean;
  defaultAvatarUrl?: string;
  videoReceiveEnabled?: boolean;
  cameraEnabled?: boolean;
  authenticated?: boolean;
  userdataS3Path?: string;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
}

/** A contract violation (bad invocation, bad workload spec) — mapped to HTTP 400 by the server. */
export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractError';
  }
}

/** The invocation specifically cannot be used by this connector. */
export class InvocationError extends ContractError {
  constructor(message: string) {
    super(message);
    this.name = 'InvocationError';
  }
}

interface Validator {
  ajv: Ajv;
  validate: ValidateFunction;
}

const validators = new Map<string, Validator>();

/** The sealed files are definition collections (`$defs`) with no root `$ref`, so the validator
 *  must point at the definition explicitly — compiling the document root would accept anything. */
function validatorFor(schemaPath: string, definition: string): Validator {
  const key = `${schemaPath}#/${definition}`;
  const cached = validators.get(key);
  if (cached) return cached;
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(schema);
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` });
  const entry = { ajv, validate };
  validators.set(key, entry);
  return entry;
}

function describe(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`)
    .slice(0, 5)
    .join('; ');
}

/** Parse + validate one invocation.v1 object. Does NOT require a particular platform. */
export function parseInvocation(raw: unknown): Invocation {
  const { validate } = validatorFor(INVOCATION_SCHEMA_PATH, 'Invocation');
  if (!validate(raw)) throw new InvocationError(`invocation.v1: ${describe(validate)}`);
  return raw as Invocation;
}

/** Parse the `TINA_BOT_CONFIG` JSON string. */
export function parseInvocationJson(raw: string): Invocation {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw new InvocationError(`TINA_BOT_CONFIG is not valid JSON: ${(e as Error)?.message ?? String(e)}`);
  }
  return parseInvocation(value);
}

/** Boot-time loader. Missing config is as fatal as malformed config. */
export function loadInvocation(env: NodeJS.ProcessEnv = process.env): Invocation {
  const raw = env.TINA_BOT_CONFIG;
  if (raw === undefined || raw.trim() === '') {
    throw new InvocationError('TINA_BOT_CONFIG is missing');
  }
  const invocation = parseInvocationJson(raw);
  if (invocation.platform !== 'discord') {
    throw new InvocationError(`discord connector received platform '${invocation.platform}'`);
  }
  return invocation;
}

// ── runtime.v1 ─────────────────────────────────────────────────────────────────────────

export type RuntimeState = 'starting' | 'running' | 'stopping' | 'stopped' | 'destroyed';
export type StopReason = 'completed' | 'stopped' | 'idle_timeout' | 'failed' | 'oom' | 'start_failed' | 'max_lifetime';
export type Backend = 'docker' | 'k8s' | 'process';

export interface WorkloadSpec {
  workloadId: string;
  profile: string;
  env: Record<string, string>;
  callbackUrl?: string;
  resources?: { cpu?: number; memoryMb?: number; gpu?: number };
  idleTimeoutSec?: number;
  maxLifetimeSec?: number;
  backend?: Backend;
}

/** Validate a runtime.v1 `WorkloadSpec` at the seam (the kernel's published schema by path). */
export function validateWorkloadSpec(raw: unknown): WorkloadSpec {
  const { validate } = validatorFor(RUNTIME_SCHEMA_PATH, 'WorkloadSpec');
  if (!validate(raw)) throw new ContractError(`runtime.v1 WorkloadSpec: ${describe(validate)}`);
  return raw as WorkloadSpec;
}

// ── Discord target parsing ────────────────────────────────────────────────────────────

export interface DiscordTarget {
  guildId: string;
  channelId: string;
}

const SNOWFLAKE = /^\d{15,21}$/;
const DISCORD_HOSTS = new Set([
  'discord.com',
  'www.discord.com',
  'canary.discord.com',
  'ptb.discord.com',
  'discordapp.com',
  'www.discordapp.com',
]);

export function isSnowflake(value: string): boolean {
  return SNOWFLAKE.test(value);
}

/** `https://discord.com/channels/<guild>/<channel>` (app hosts included). Returns null for any
 *  other URL, including a guild-only or message-link URL — the bot needs a VOICE channel id. */
export function parseDiscordChannelUrl(raw: string): DiscordTarget | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!DISCORD_HOSTS.has(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'channels' || parts.length !== 3) return null;
  const [, guildId, channelId] = parts;
  if (!isSnowflake(guildId) || !isSnowflake(channelId)) return null;
  return { guildId, channelId };
}

/** The connector's own id shape: `<guildId>:<channelId>` (also accepts a `/` separator for
 *  hand-written fixtures). */
export function parseNativeDiscordId(raw: string): DiscordTarget | null {
  const m = /^(\d{15,21})[:/](\d{15,21})$/.exec(raw.trim());
  return m ? { guildId: m[1], channelId: m[2] } : null;
}

export function discordChannelUrl(target: DiscordTarget): string {
  return `https://discord.com/channels/${target.guildId}/${target.channelId}`;
}

/**
 * Resolve the voice target from an invocation. `nativeMeetingId` is authoritative (meeting-api
 * derives it from the URL); a full `meetingUrl` is the fallback. When both are present they MUST
 * agree — joining a different channel than the one recorded would put the bot in the wrong room.
 */
export function resolveDiscordTarget(inv: Invocation): DiscordTarget {
  const native = inv.nativeMeetingId ? parseNativeDiscordId(inv.nativeMeetingId) : null;
  const fromUrl = inv.meetingUrl ? parseDiscordChannelUrl(inv.meetingUrl) : null;
  if (native && fromUrl && (native.guildId !== fromUrl.guildId || native.channelId !== fromUrl.channelId)) {
    throw new InvocationError(
      `nativeMeetingId ${inv.nativeMeetingId} disagrees with meetingUrl ${inv.meetingUrl}`,
    );
  }
  if (native) return native;
  if (fromUrl) return fromUrl;
  throw new InvocationError(
    'discord invocation needs nativeMeetingId "<guildId>:<channelId>" or a https://discord.com/channels/<guild>/<channel> meetingUrl',
  );
}

// ── connector-level env ───────────────────────────────────────────────────────────────

export interface ConnectorConfig {
  /** Bot token. ONE token means ONE Gateway session — this connector must run as one replica. */
  token: string;
  host: string;
  port: number;
  /** Concurrent voice channels this connector will hold. */
  maxSessions: number;
  /** When non-empty, a guild id not listed here is refused at create time. */
  guildAllowlist: Set<string>;
  /** How long a stopped workload stays queryable (`GET /workloads/{id}`) before eviction. */
  retentionMs: number;
  /** How long a `disconnected` voice socket may stay down before the session fails. */
  disconnectGraceMs: number;
  /** Upper bound on flushing the lane (STT) at teardown. */
  laneStopTimeoutMs: number;
  /** Fixed per-session channel pool (matches the lane's 16-source timeline budget). */
  maxChannels: number;
}

function envString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw.trim();
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number, opts: { min?: number; max?: number } = {}): number {
  const raw = envString(env, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer, got '${raw}'`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is out of range: ${raw}`);
  if (opts.min !== undefined && value < opts.min) throw new Error(`${name} must be >= ${opts.min}, got ${value}`);
  if (opts.max !== undefined && value > opts.max) throw new Error(`${name} must be <= ${opts.max}, got ${value}`);
  return value;
}

export function loadConnectorConfig(env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
  const token = envString(env, 'DISCORD_BOT_TOKEN');
  if (!token) throw new Error('DISCORD_BOT_TOKEN is required');

  const allowlist = new Set(
    (envString(env, 'DISCORD_GUILD_ALLOWLIST') ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  );
  for (const guildId of allowlist) {
    if (!isSnowflake(guildId)) throw new Error(`DISCORD_GUILD_ALLOWLIST contains a non-snowflake guild id: '${guildId}'`);
  }

  return {
    token,
    host: envString(env, 'DISCORD_CONNECTOR_HOST') ?? '0.0.0.0',
    port: envInt(env, 'DISCORD_CONNECTOR_PORT', 8091, { min: 1, max: 65535 }),
    maxSessions: envInt(env, 'DISCORD_MAX_SESSIONS', 4, { min: 1, max: 64 }),
    guildAllowlist: allowlist,
    retentionMs: envInt(env, 'DISCORD_WORKLOAD_RETENTION_MS', 600_000, { min: 0 }),
    disconnectGraceMs: envInt(env, 'DISCORD_DISCONNECT_GRACE_MS', 30_000, { min: 0 }),
    laneStopTimeoutMs: envInt(env, 'DISCORD_LANE_STOP_TIMEOUT_MS', 20_000, { min: 100 }),
    maxChannels: envInt(env, 'DISCORD_MAX_CHANNELS', 16, { min: 1, max: 64 }),
  };
}
