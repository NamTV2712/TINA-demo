/**
 * The connector's workload registry: the `runtime.v1` lifecycle surface over voice sessions.
 *
 * meeting-api treats this exactly like a container kernel: `POST /workloads` starts a meeting
 * bot, `GET` probes liveness, `DELETE` tears it down. The registry is where that contract is
 * honoured — idempotent create, a hard concurrency cap (429), a confirmed delete, and a
 * short-lived tombstone so a stop followed by a GET reads `stopped`, not a spurious 404.
 *
 * If the connector process dies, the kernel (meeting-api's reaper) sees the workload disappear
 * and reconciles the meeting, exactly as it would for a crashed pod. There is no second state
 * store to keep in sync.
 */
import type { StopReason } from './config.js';
import type { CompletionReason } from './ports.js';
import type { SessionOutcome, SessionSpec } from './session.js';

export interface WorkloadRecord {
  workloadId: string;
  profile: string;
  state: 'starting' | 'running' | 'stopping' | 'stopped' | 'destroyed';
  backend: 'process';
  startedAt: string;
  stoppedAt?: string;
  exitCode?: number;
  stopReason?: StopReason;
}

/** The slice of `DiscordVoiceSession` the registry needs (structural, so tests stay offline). */
export interface ManagedSession {
  start(): Promise<void>;
  stop(reason?: CompletionReason): Promise<void>;
}

export type SessionFactory = (spec: SessionSpec, onTerminal: (outcome: SessionOutcome) => void) => ManagedSession;

export class WorkloadUnknownError extends Error {
  constructor(readonly workloadId: string) {
    super(`unknown workload: ${workloadId}`);
    this.name = 'WorkloadUnknownError';
  }
}

/** The connector is at its concurrency cap. `POST /workloads` maps this to 429 (runtime.v1's
 *  quota signal, which meeting-api surfaces as QuotaExceeded). */
export class CapacityExceededError extends Error {
  constructor(readonly max: number) {
    super(`discord connector at capacity (${max} live sessions)`);
    this.name = 'CapacityExceededError';
  }
}

export interface SessionManagerOptions {
  maxSessions: number;
  /** How long a stopped workload stays queryable before eviction. 0 evicts on the next tick. */
  retentionMs: number;
  createSession: SessionFactory;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  log?: (message: string) => void;
}

interface Managed {
  record: WorkloadRecord;
  session: ManagedSession;
  retention?: ReturnType<typeof setTimeout>;
}

export function stopReasonFor(outcome: SessionOutcome): StopReason {
  if (outcome.status === 'failed') {
    return outcome.failureStage === 'joining' || outcome.failureStage === 'requested'
      ? 'start_failed'
      : 'failed';
  }
  if (outcome.completionReason === 'stopped') return 'stopped';
  if (outcome.completionReason === 'max_bot_time_exceeded') return 'max_lifetime';
  return 'completed';
}

export class SessionManager {
  private readonly entries = new Map<string, Managed>();
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: SessionManagerOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimeout ?? setTimeout;
    this.clearTimer = opts.clearTimeout ?? clearTimeout;
    this.log = opts.log ?? ((m) => console.log(`[discord] ${m}`));
  }

  get size(): number {
    return this.entries.size;
  }

  get activeCount(): number {
    return [...this.entries.values()].filter((m) => !m.record.stoppedAt).length;
  }

  get capacity(): number {
    return this.opts.maxSessions;
  }

  /** Idempotent by `workloadId`. A tombstoned (stopped) id may be recreated; a live id returns
   *  the existing record rather than starting a second voice session. */
  create(spec: SessionSpec, profile = 'discord-bot'): WorkloadRecord {
    const existing = this.entries.get(spec.workloadId);
    if (existing) {
      if (!existing.record.stoppedAt) return { ...existing.record };
      this.drop(existing);
    }
    if (this.activeCount >= this.opts.maxSessions) {
      throw new CapacityExceededError(this.opts.maxSessions);
    }

    const record: WorkloadRecord = {
      workloadId: spec.workloadId,
      profile,
      state: 'running',
      backend: 'process',
      startedAt: new Date(this.now()).toISOString(),
    };
    const session = this.opts.createSession(spec, (outcome) => this.onTerminal(spec.workloadId, outcome));
    const managed: Managed = { record, session };
    this.entries.set(spec.workloadId, managed);

    void session.start().catch((e: unknown) => {
      this.log(`session ${spec.workloadId} start threw: ${(e as Error)?.message ?? String(e)}`);
      if (!managed.record.stoppedAt) {
        this.onTerminal(spec.workloadId, {
          status: 'failed',
          completionReason: 'join_failure',
          failureStage: 'joining',
          reason: (e as Error)?.message ?? String(e),
        });
      }
    });
    return { ...record };
  }

  get(workloadId: string): WorkloadRecord | undefined {
    const managed = this.entries.get(workloadId);
    return managed ? { ...managed.record } : undefined;
  }

  list(): WorkloadRecord[] {
    return [...this.entries.values()].map((m) => ({ ...m.record }));
  }

  /** Confirmed teardown: resolves only after the session has left, flushed, and emitted its
   *  terminal lifecycle event. Unknown id throws (the caller must NOT treat 404 as stopped). */
  async delete(workloadId: string): Promise<WorkloadRecord> {
    const managed = this.entries.get(workloadId);
    if (!managed) throw new WorkloadUnknownError(workloadId);
    if (!managed.record.stoppedAt) {
      try {
        await managed.session.stop('stopped');
      } catch (e) {
        this.log(`session ${workloadId} stop threw: ${(e as Error)?.message ?? String(e)}`);
      }
    }
    // A session contract that never called back must not leave the tombstone "running".
    if (!managed.record.stoppedAt) {
      this.onTerminal(workloadId, { status: 'completed', completionReason: 'stopped' });
    }
    return { ...managed.record };
  }

  async shutdown(): Promise<void> {
    const live = [...this.entries.values()].filter((m) => !m.record.stoppedAt);
    for (const managed of this.entries.values()) {
      if (managed.retention) {
        this.clearTimer(managed.retention);
        managed.retention = undefined;
      }
    }
    await Promise.all(live.map(async (managed) => {
      try {
        await managed.session.stop('stopped');
      } catch (e) {
        this.log(`session ${managed.record.workloadId} stop threw during shutdown: ${(e as Error)?.message ?? String(e)}`);
      }
    }));
    this.entries.clear();
  }

  private onTerminal(workloadId: string, outcome: SessionOutcome): void {
    const managed = this.entries.get(workloadId);
    if (!managed || managed.record.stoppedAt) return;
    managed.record.state = 'stopped';
    managed.record.stoppedAt = new Date(this.now()).toISOString();
    managed.record.exitCode = outcome.status === 'completed' ? 0 : 1;
    managed.record.stopReason = stopReasonFor(outcome);
    if (managed.retention) this.clearTimer(managed.retention);
    managed.retention = this.setTimer(() => this.drop(managed), Math.max(0, this.opts.retentionMs));
    managed.retention.unref?.();
  }

  private drop(managed: Managed): void {
    if (managed.retention) {
      this.clearTimer(managed.retention);
      managed.retention = undefined;
    }
    if (this.entries.get(managed.record.workloadId) === managed) {
      this.entries.delete(managed.record.workloadId);
    }
  }
}
