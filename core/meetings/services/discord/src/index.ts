/**
 * @tina/discord-connector — the composition root.
 *
 * One long-lived process holds ONE Discord Gateway session (one bot token) and joins voice
 * channels on demand. Per-meeting containers cannot do this: a second Gateway connection with the
 * same token would evict the first. So the connector is a tiny kernel of its own — meeting-api
 * talks to it through `runtime.v1` (`POST/GET/DELETE /workloads`), exactly as it talks to Docker,
 * and each workload is a `DiscordVoiceSession` in this process.
 *
 * Wiring only (Seemann): the state machine is pure over ports (`session.ts`); the adapters are
 * `discord-voice.ts` (Gateway/voice), `pipeline.ts` (the shared gmeet lane), `egress.ts`
 * (transcript.v1 + lifecycle.v1) and `acts.ts` (leave).
 *
 * Shutdown order matters and is deliberate:
 *   stop accepting workloads → leave every voice channel (flush STT, emit terminal events) →
 *   destroy the Gateway socket → exit. Destroying the client first would orphan live sessions
 *   from their terminal callback and leave ghost bots in channels.
 */
import { pathToFileURL } from 'node:url';
import { Client, GatewayIntentBits } from 'discord.js';
import { loadConnectorConfig, type Invocation } from './config.js';
import { consoleLifecycleSink, createHttpLifecycleSink, createSessionEgress } from './egress.js';
import { createDiscordLane } from './pipeline.js';
import { createDiscordVoicePort } from './discord-voice.js';
import { createLeaveActs, redisSubscriberFrom } from './acts.js';
import { SessionManager, type SessionFactory } from './session-manager.js';
import { DiscordVoiceSession } from './session.js';
import { createWorkloadServer } from './server.js';
import type { LifecyclePort } from './ports.js';

const SHUTDOWN_GRACE_MS = 25_000;

function log(message: string): void {
  console.log(`[discord] ${message}`);
}

/** The meeting id that keys the redis transcript/acts channels — same fallback chain as the bot,
 *  so both producers address the same meeting even when the numeric id is absent. */
function meetingChannelId(inv: Invocation, workloadId: string): string | number {
  return inv.meeting_id ?? inv.nativeMeetingId ?? inv.connectionId ?? workloadId;
}

function lifecycleFor(inv: Invocation): LifecyclePort {
  if (!inv.meetingApiCallbackUrl) return consoleLifecycleSink();
  return createHttpLifecycleSink({
    callbackUrl: inv.meetingApiCallbackUrl,
    internalSecret: inv.internalSecret,
  });
}

export interface ConnectorHandle {
  /** Stop accepting workloads, leave every channel, release the Gateway. Resolves when clean. */
  shutdown(): Promise<void>;
}

/**
 * Build and start the connector. Split from `main` so a test or an embedding host can drive the
 * lifecycle without a process exit; `main` adds signals + exit codes.
 */
export async function startConnector(env: NodeJS.ProcessEnv = process.env): Promise<ConnectorHandle> {
  const config = loadConnectorConfig(env);

  const client = new Client({
    // Guilds: channel metadata. GuildVoiceStates: who is in the channel. GuildMembers: display
    // names (privileged — the operator must enable "Server Members Intent" for the bot; without
    // it login fails fast rather than silently labelling every speaker with a user id).
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
  });
  client.on('error', (e: Error) => log(`gateway error: ${e.message}`));
  client.on('shardError', (e: Error) => log(`shard error: ${e.message}`));

  const voice = createDiscordVoicePort({ client });

  const createSession: SessionFactory = (spec, onTerminal) => {
    const invocation = spec.invocation;
    const lifecycle = lifecycleFor(invocation);
    const egress = createSessionEgress({
      redisUrl: invocation.redisUrl,
      meetingId: meetingChannelId(invocation, spec.workloadId),
      nativeMeetingId: invocation.nativeMeetingId,
      sessionUid: invocation.connectionId,
      lifecycle,
    });
    const lane = createDiscordLane({
      invocation,
      transcripts: egress.transcripts,
      onError: (e) => log(`lane fault in ${spec.workloadId}: ${String(e)}`),
    });

    let session!: DiscordVoiceSession;
    const acts = createLeaveActs({
      client: redisSubscriberFrom(invocation.redisUrl),
      meetingId: meetingChannelId(invocation, spec.workloadId),
      onLeave: (detail) => {
        // acts.v1 `leave` is a user action: completed(stopped), not a failure.
        void session.stop('stopped', detail);
      },
      log: (m) => log(`${spec.workloadId} ${m}`),
    });

    session = new DiscordVoiceSession({
      voice,
      lane,
      lifecycle,
      maxChannels: config.maxChannels,
      disconnectGraceMs: config.disconnectGraceMs,
      laneStopTimeoutMs: config.laneStopTimeoutMs,
      onTerminal,
      log: (m) => log(`${spec.workloadId} ${m}`),
      // Runs after the lane flushed and before the terminal event: close the two redis
      // connections only once no more segments can be produced.
      close: async () => {
        await acts.close();
        await egress.close();
      },
    }, spec);

    return {
      start: async () => {
        acts.start();
        await session.start();
      },
      stop: (reason) => session.stop(reason),
    };
  };

  const manager = new SessionManager({
    maxSessions: config.maxSessions,
    retentionMs: config.retentionMs,
    createSession,
    log,
  });
  const server = createWorkloadServer({
    manager,
    guildAllowlist: config.guildAllowlist,
    log,
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  log(`runtime.v1 workload server listening on ${config.host}:${config.port} (max ${config.maxSessions} session(s))`);

  try {
    await client.login(config.token);
    log(`gateway ready as ${client.user?.tag ?? 'unknown'} (${client.guilds.cache.size} guild(s))`);
  } catch (e) {
    server.close();
    await client.destroy();
    throw new Error(`Discord login failed: ${(e as Error)?.message ?? String(e)}`);
  }

  let shuttingDown: Promise<void> | undefined;
  return {
    shutdown() {
      shuttingDown ??= (async () => {
        log('shutting down');
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await manager.shutdown();
        await client.destroy();
        log('stopped');
      })();
      return shuttingDown;
    },
  };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let handle: ConnectorHandle;
  try {
    handle = await startConnector(env);
  } catch (e) {
    console.error(`[discord] FATAL ${(e as Error)?.stack ?? String(e)}`);
    return 1;
  }

  return new Promise<number>((resolve) => {
    let stopping = false;
    const onSignal = (signal: NodeJS.Signals): void => {
      if (stopping) return;
      stopping = true;
      log(`${signal} — graceful shutdown (watchdog ${SHUTDOWN_GRACE_MS}ms)`);
      // The watchdog is unref'd: a clean teardown must not wait for it, a wedged one must not
      // ride the orchestrator's stop grace into a silent SIGKILL.
      const watchdog = setTimeout(() => {
        console.error(`[discord] shutdown did not complete within ${SHUTDOWN_GRACE_MS}ms — exit 1`);
        process.exit(1);
      }, SHUTDOWN_GRACE_MS);
      watchdog.unref?.();
      void handle.shutdown().then(
        () => resolve(0),
        (e: unknown) => {
          console.error(`[discord] shutdown failed: ${(e as Error)?.stack ?? String(e)}`);
          resolve(1);
        },
      );
    };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code)).catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
