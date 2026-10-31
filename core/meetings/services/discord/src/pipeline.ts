/**
 * The Discord transcript lane.
 *
 * Discord's audio topology is the friendliest TINA has: **one Opus stream per user**. That is
 * exactly the gmeet lane's premise (a channel per participant, the name bound at capture), so
 * no diarization and no mixed-lane namer are involved. The connector only has to give each
 * Discord user a stable channel index and their display name.
 *
 * STT is the shared stt.v1 client (`@tina/transcribe-whisper`), pointed at the endpoint the
 * invocation carries. When transcription is disabled or unconfigured the lane is still built —
 * it simply produces no text — so a join/leave-only meeting remains observable instead of
 * crashing the connector.
 */
import { createGmeetPipeline, type GmeetPipeline, type SpeakerStreamManagerConfig } from '@tina/gmeet-pipeline';
import { TranscriptionClient } from '@tina/transcribe-whisper';
import type { LanePort } from './ports.js';
import type { ConnectorTranscriptSink } from './egress.js';
import { laneSinkAdapter } from './egress.js';

/** The invocation fields the lane needs (a structural subset of invocation.v1). */
export interface LaneInvocation {
  language?: string | null;
  transcribeEnabled?: boolean;
  transcriptionServiceUrl?: string;
  transcriptionServiceToken?: string;
  transcriptionModel?: string | null;
}

export interface DiscordLaneOptions {
  invocation: LaneInvocation;
  transcripts: ConnectorTranscriptSink;
  /** Injected transcription round-trip (tests); default: the shared stt.v1 client. */
  transcribe?: (pcm: Float32Array, prompt?: string) => Promise<{ text: string; language?: string; duration?: number; segments?: unknown[] }>;
  config?: SpeakerStreamManagerConfig;
  onError?: (e: unknown) => void;
}

/** Read the same speaker-stream knobs the browser bot reads, so Discord turns gate identically. */
export function speakerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SpeakerStreamManagerConfig {
  const num = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === '') return undefined;
    const v = Number(raw);
    return Number.isFinite(v) ? v : undefined;
  };
  return {
    minAudioDuration: num('BOT_SPEAKER_MIN_AUDIO_SEC'),
    submitInterval: num('BOT_SPEAKER_SUBMIT_INTERVAL_SEC'),
    confirmThreshold: num('BOT_SPEAKER_CONFIRM_THRESHOLD'),
    maxBufferDuration: num('BOT_SPEAKER_MAX_BUFFER_SEC'),
    idleTimeoutSec: num('BOT_SPEAKER_IDLE_TIMEOUT_SEC'),
  };
}

/** The real stt.v1 round-trip, closed over the invocation's language. */
function transcribeFrom(inv: LaneInvocation) {
  if (inv.transcribeEnabled === false || !inv.transcriptionServiceUrl) {
    return async () => ({ text: '', language: inv.language ?? 'en', duration: 0, segments: [] });
  }
  const client = new TranscriptionClient({
    source: 'meeting-bot',
    serviceUrl: inv.transcriptionServiceUrl,
    apiToken: inv.transcriptionServiceToken,
    model: inv.transcriptionModel ?? undefined,
  });
  const language = inv.language ?? undefined;
  return (pcm: Float32Array, prompt?: string) => client.transcribe(pcm, language, prompt);
}

/**
 * Build the lane. `feedAudio(channel, name, pcm, tsMs, participantId)` is the whole entry:
 * channel indices are allocated by the session and never reused within a run, so speaker
 * identity cannot leak between two people who joined at different times.
 */
export function createDiscordLane(opts: DiscordLaneOptions): LanePort {
  const transcribe = opts.transcribe ?? transcribeFrom(opts.invocation);
  const sink = laneSinkAdapter(opts.transcripts);
  const onError = opts.onError ?? ((e: unknown) => console.error(`[discord] lane: ${String(e)}`));
  const lane: GmeetPipeline = createGmeetPipeline({
    transcribe: (pcm, prompt) => transcribe(pcm, prompt) as never,
    sink: sink as never,
    config: opts.config ?? speakerConfigFromEnv(),
    onError,
    unknownLabel: 'Speaker',
    // 1 s of per-channel silence ends a turn; Discord packets are continuous, so this is what
    // makes a speaker's pause visible to the lane without ending their channel.
    onsetGapMs: 1000,
  });
  return {
    feedAudio(channel, glowName, pcm, tsMs, participantId) {
      lane.feedAudio(channel, glowName, pcm, tsMs, participantId ?? null);
    },
    async stop() { await lane.dispose(); },
  };
}
