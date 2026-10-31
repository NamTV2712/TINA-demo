/**
 * acts.v1 ingress for the connector: the control plane's `leave` command.
 *
 * meeting-api stops a bot the same way on every platform — publish `{"action":"leave"}` on
 * `bot_commands:meeting:{meetingId}` (acts.v1). Discord honours it here rather than inventing a
 * second control path, so a dashboard "remove bot" works unchanged. `DELETE /workloads/{id}` (the
 * reconciler's path) remains the other, confirmed teardown.
 *
 * One SUBSCRIBER connection per session: node-redis reserves a subscribed client for pub/sub, so
 * it must not share the transcript writer. Off-contract messages are dropped silently — acts.v1
 * defines unknown actions as ignorable, and a malformed control message must never end a meeting.
 */
import { createClient } from 'redis';

export const actsChannel = (meetingId: string | number): string => `bot_commands:meeting:${meetingId}`;

/** The minimal subscriber surface; injected so this adapter is offline-testable. */
export interface RedisSubscriber {
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
  unsubscribe?(channel: string): Promise<unknown>;
  quit?(): Promise<unknown>;
}

export interface LeaveActsOptions {
  client: RedisSubscriber;
  meetingId: string | number;
  /** Called at most once per message, for every recognized `leave` act. */
  onLeave: (detail: string) => void;
  log?: (message: string) => void;
}

export interface LeaveActsSubscription {
  /** Subscribe in the background; a redis outage is logged and leaves the session running. */
  start(): void;
  close(): Promise<void>;
}

/** `leave` is the only act this increment honours. Everything else is logged and ignored. */
export function createLeaveActs(opts: LeaveActsOptions): LeaveActsSubscription {
  const channel = actsChannel(opts.meetingId);
  const log = opts.log ?? ((m: string) => console.log(`[discord] acts: ${m}`));
  let started = false;
  let closed = false;

  return {
    start() {
      if (started || closed) return;
      started = true;
      void Promise.resolve()
        .then(() => opts.client.subscribe(channel, (message) => {
          if (closed) return;
          let decoded: unknown;
          try {
            decoded = JSON.parse(message);
          } catch {
            log(`dropped a non-JSON message on ${channel}`);
            return;
          }
          const action = (decoded as { action?: unknown } | null)?.action;
          if (action === 'leave') {
            opts.onLeave('leave command from control plane');
            return;
          }
          if (typeof action === 'string') log(`ignored '${action}' (not supported by the Discord connector)`);
        }))
        .catch((e: unknown) => {
          log(`subscribe to ${channel} failed: ${(e as Error)?.message ?? String(e)}`);
        });
    },

    async close() {
      if (closed) return;
      closed = true;
      try {
        await opts.client.unsubscribe?.(channel);
      } catch {
        /* the connection may already be gone */
      }
      try {
        await opts.client.quit?.();
      } catch {
        /* best-effort teardown */
      }
    },
  };
}

/** Wrap a node-redis client for one session's acts subscription. Connects lazily on subscribe so
 *  an unreachable broker cannot block the join. */
export function redisSubscriberFrom(redisUrl: string): RedisSubscriber {
  const client = createClient({ url: redisUrl });
  client.on('error', (err: unknown) => {
    console.error(`[discord] redis (acts) error: ${(err as Error)?.message ?? String(err)}`);
  });
  let connecting: Promise<void> | undefined;
  const ensure = (): Promise<void> => {
    if (client.isOpen) return Promise.resolve();
    connecting ??= client.connect().then(() => undefined).finally(() => { connecting = undefined; });
    return connecting;
  };
  return {
    async subscribe(channel, listener) {
      await ensure();
      await client.subscribe(channel, (message: string) => listener(message));
    },
    async unsubscribe(channel) {
      if (client.isOpen) await client.unsubscribe(channel);
    },
    async quit() {
      if (client.isOpen) await client.quit();
    },
  };
}
