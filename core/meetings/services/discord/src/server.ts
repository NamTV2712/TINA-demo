/**
 * The connector's `runtime.v1` HTTP surface.
 *
 * meeting-api's `HttpRuntimeClient` is the only caller, and it speaks the same four operations a
 * container kernel would: create (`POST /workloads`), probe (`GET /workloads/{id}`), tear down
 * (`DELETE /workloads/{id}`), plus the kernel's health endpoint. Everything is validated at the
 * seam against the PUBLISHED runtime.v1 + invocation.v1 schemas (loaded by path), so a Discord
 * session cannot be started from a spec the kernel would have rejected.
 *
 * Deliberate choices, all matching the kernel contract the caller already relies on:
 *   • create returns **201** with a live `WorkloadStatus` (`state: running`) — the join itself is
 *     asynchronous, exactly like a pod starting; a join failure is reported on lifecycle.v1.
 *   • create is idempotent by `workloadId` (runtime.v1 ADR 0027), delegated to `SessionManager`.
 *   • delete is CONFIRMED: it resolves only after the session has left, flushed and emitted its
 *     terminal lifecycle event. An unknown id is 404, never a silent success.
 *   • 429 is the kernel's quota signal, mapped by meeting-api to QuotaExceeded.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ContractError,
  InvocationError,
  parseInvocationJson,
  resolveDiscordTarget,
  validateWorkloadSpec,
  type Invocation,
  type WorkloadSpec,
} from './config.js';
import {
  CapacityExceededError,
  SessionManager,
  WorkloadUnknownError,
  type WorkloadRecord,
} from './session-manager.js';
import type { SessionSpec } from './session.js';

/** The runtime.v1 profile this connector serves. Anything else belongs to another kernel. */
export const DISCORD_PROFILE = 'discord-bot';

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface WorkloadServerOptions {
  manager: SessionManager;
  /** When non-empty, a guild outside it is refused at create time. */
  guildAllowlist?: Set<string>;
  maxBodyBytes?: number;
  log?: (message: string) => void;
}

/** Turn a validated runtime.v1 spec into the session the connector will run. */
export function sessionSpecFromWorkload(spec: WorkloadSpec): SessionSpec {
  if (spec.profile !== DISCORD_PROFILE) {
    throw new ContractError(
      `profile '${spec.profile}' is not served by the Discord connector (expected '${DISCORD_PROFILE}')`,
    );
  }
  const raw = spec.env.TINA_BOT_CONFIG;
  if (raw === undefined || raw.trim() === '') {
    throw new InvocationError('WorkloadSpec.env.TINA_BOT_CONFIG is missing');
  }
  const invocation: Invocation = parseInvocationJson(raw);
  if (invocation.platform !== 'discord') {
    throw new InvocationError(`discord connector received platform '${invocation.platform}'`);
  }
  const target = resolveDiscordTarget(invocation);
  const maxActiveMs = spec.maxLifetimeSec !== undefined && spec.maxLifetimeSec > 0
    ? Math.round(spec.maxLifetimeSec * 1000)
    : undefined;
  return {
    workloadId: spec.workloadId,
    invocation,
    guildId: target.guildId,
    channelId: target.channelId,
    ...(maxActiveMs !== undefined ? { maxActiveMs } : {}),
  };
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) throw new HttpError(413, `request body exceeds ${maxBytes} bytes`);
    chunks.push(buf);
  }
  if (total === 0) throw new HttpError(400, 'empty request body');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    throw new HttpError(400, `request body is not JSON: ${(e as Error)?.message ?? String(e)}`);
  }
}

function statusBody(record: WorkloadRecord): WorkloadRecord {
  // Runtime WorkloadStatus is additionalProperties:false; the record is already exactly its fields.
  return record;
}

/** Build the server. The caller owns `listen()`/`close()` and `manager.shutdown()` ordering. */
export function createWorkloadServer(opts: WorkloadServerOptions): Server {
  const { manager } = opts;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const allowlist = opts.guildAllowlist ?? new Set<string>();
  const log = opts.log ?? ((m: string) => console.error(`[discord] server: ${m}`));

  const server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof HttpError) {
        json(res, e.status, { detail: e.message });
        return;
      }
      if (e instanceof CapacityExceededError) {
        json(res, 429, { detail: e.message });
        return;
      }
      if (e instanceof WorkloadUnknownError) {
        json(res, 404, { detail: e.message });
        return;
      }
      if (e instanceof ContractError) {
        json(res, 400, { detail: e.message });
        return;
      }
      log(`unhandled ${req.method ?? '?'} ${req.url ?? '?'}: ${(e as Error)?.stack ?? String(e)}`);
      json(res, 500, { detail: 'internal connector error' });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://connector.invalid');
    } catch {
      throw new HttpError(400, 'malformed request URL');
    }
    let parts: string[];
    try {
      parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      throw new HttpError(400, 'malformed path encoding');
    }

    if (parts.length === 0) {
      throw new HttpError(404, 'not found');
    }

    if (parts[0] === 'healthz') {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      json(res, 200, {
        ok: true,
        service: 'discord-connector',
        sessions: manager.activeCount,
        capacity: manager.capacity,
      });
      return;
    }

    if (parts[0] !== 'workloads') throw new HttpError(404, 'not found');

    // /workloads
    if (parts.length === 1) {
      if (method === 'POST') {
        const raw = await readJson(req, maxBodyBytes);
        const spec = validateWorkloadSpec(raw);
        const sessionSpec = sessionSpecFromWorkload(spec);
        if (allowlist.size > 0 && !allowlist.has(sessionSpec.guildId)) {
          throw new ContractError(`guild ${sessionSpec.guildId} is not in DISCORD_GUILD_ALLOWLIST`);
        }
        const record = manager.create(sessionSpec, spec.profile);
        json(res, 201, statusBody(record));
        return;
      }
      if (method === 'GET' || method === 'HEAD') {
        const profile = url.searchParams.get('profile');
        const records = manager.list().filter((r) => !profile || r.profile === profile);
        json(res, 200, records.map(statusBody));
        return;
      }
      throw new HttpError(405, 'method not allowed');
    }

    // /workloads/{id}
    if (parts.length === 2) {
      const workloadId = parts[1];
      if (!workloadId) throw new HttpError(400, 'missing workload id');
      if (method === 'GET' || method === 'HEAD') {
        const record = manager.get(workloadId);
        if (!record) throw new WorkloadUnknownError(workloadId);
        json(res, 200, statusBody(record));
        return;
      }
      if (method === 'DELETE') {
        const record = await manager.delete(workloadId);
        json(res, 200, statusBody(record));
        return;
      }
      throw new HttpError(405, 'method not allowed');
    }

    throw new HttpError(404, 'not found');
  }

  return server;
}
