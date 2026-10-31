"""Redis sorted-set job scheduler — schedule HTTP-call requests for future execution. Ported from
0.11's `runtime_api/scheduler.py`, reimplemented SYNCHRONOUS and behind the Clock port so evals
advance time deterministically (fakeredis + FakeClock, no wall clock, no background asyncio task).

Faithful to the parent's real shape and behaviour:
  • jobs live in a sorted set keyed by execute_at (score), member = job JSON;
  • idempotency_key dedups (returns the existing job);
  • due jobs fire via an injectable `dispatch(request) -> result`; the real dispatch does HTTP, the
    eval captures the request;
  • a failing dispatch retries with exponential backoff up to max_attempts, then marks the job failed;
  • a `cron`-tagged job re-arms itself (croniter) after a successful run;
  • orphan recovery re-queues jobs that were mid-flight when the process died.

`tick()` is the unit the parent's `_executor_loop` runs each poll: it pulls everything due (per the
Clock) and processes it. A real deployment loops tick() on an interval; the eval calls it explicitly
after advancing the FakeClock."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Callable, Optional
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from redis.exceptions import WatchError

from croniter import croniter

from .clock import Clock, SystemClock

logger = logging.getLogger("runtime_kernel.scheduler")

# Redis keys (mirror 0.11).
JOBS_KEY = "scheduler:jobs"            # sorted set: score=execute_at, member=job JSON
EXECUTING_KEY = "scheduler:executing"  # hash: job_id -> job JSON (in-flight)
HISTORY_KEY = "scheduler:history"      # hash: job_id -> job JSON (completed/failed/cancelled)
IDEMPOTENCY_PREFIX = "scheduler:idem:"
HISTORY_TTL = 86400 * 7

DEFAULT_RETRY = {"max_attempts": 3, "backoff": [30, 120, 300], "attempt": 0}

# A dispatch returns a result dict on success and raises on a retryable failure.
Dispatch = Callable[[dict[str, Any]], dict[str, Any]]


class DispatchError(Exception):
    """Raised by a dispatch to signal a retryable failure (e.g. a 5xx)."""


def _s(v) -> str:
    return v.decode() if isinstance(v, (bytes, bytearray)) else v


def _next_cron(cron: str, zone: ZoneInfo, now: float) -> float:
    # Calculate wall-clock slots first: croniter's aware-date arithmetic drifts across DST.
    iterator = croniter(cron, datetime.fromtimestamp(now, zone).replace(tzinfo=None))
    for _ in range(1000):
        wall = iterator.get_next(datetime)
        candidate = wall.replace(tzinfo=zone, fold=0).timestamp()
        if candidate > now and datetime.fromtimestamp(candidate, zone).replace(tzinfo=None) == wall:
            return candidate  # Skip nonexistent slots; ambiguous wall-clock slots run once, first fold.
    raise ValueError('No valid future cron time')


class Scheduler:
    def __init__(
        self,
        redis,
        dispatch: Dispatch,
        clock: Optional[Clock] = None,
    ) -> None:
        self._r = redis
        self._dispatch = dispatch
        self.clock: Clock = clock or SystemClock()

    # ── job CRUD ─────────────────────────────────────────────────────────────
    def _make_job(self, spec: dict[str, Any]) -> dict[str, Any]:
        now = self.clock.now()
        execute_at = spec.get("execute_at")
        cron = spec.get("cron")
        try:
            zone = ZoneInfo(spec.get("timezone") or "UTC")
        except (ZoneInfoNotFoundError, TypeError) as exc:
            raise ValueError('Invalid IANA time zone') from exc
        if execute_at is None and cron:
            execute_at = _next_cron(cron, zone, now)
        if isinstance(execute_at, str):
            execute_at = datetime.fromisoformat(execute_at).timestamp()
        if execute_at is None:
            raise ValueError("execute_at or cron is required")

        request = spec.get("request")
        if not request or not request.get("url"):
            raise ValueError("request.url is required")

        return {
            "job_id": f"job_{uuid4().hex[:16]}",
            "execute_at": execute_at,
            "created_at": now,
            "status": "pending",
            "request": {
                "method": request.get("method", "POST"),
                "url": request["url"],
                "headers": request.get("headers", {}),
                "body": request.get("body"),
                "timeout": request.get("timeout", 30),
            },
            "retry": {**DEFAULT_RETRY, **(spec.get("retry") or {})},
            "metadata": spec.get("metadata", {}),
            "cron": cron,
            "timezone": zone.key,
            "idempotency_key": spec.get("idempotency_key"),
        }

    def schedule(self, spec: dict[str, Any]) -> dict[str, Any]:
        job = self._make_job(spec)
        idem_key = job.get("idempotency_key")
        if idem_key:
            redis_key = f"{IDEMPOTENCY_PREFIX}{idem_key}"
            existing = self._r.get(redis_key)
            if existing:
                logger.info("duplicate idempotency_key=%s, returning existing job", idem_key)
                return json.loads(_s(existing))
            self._r.set(redis_key, json.dumps(job), ex=HISTORY_TTL)
        self._r.zadd(JOBS_KEY, {json.dumps(job): job["execute_at"]})
        return job

    def cancel(self, job_id: str) -> Optional[dict[str, Any]]:
        while True:
            with self._r.pipeline() as pipe:
                try:
                    pipe.watch(JOBS_KEY, EXECUTING_KEY, HISTORY_KEY)
                    pending = {json.loads(_s(raw))['job_id']: (raw, json.loads(_s(raw)))
                               for raw in pipe.zrange(JOBS_KEY, 0, -1)}
                    target, seen = job_id, set()
                    while target not in seen:
                        seen.add(target)
                        pair = pending.get(target)
                        raw = pipe.hget(EXECUTING_KEY, target)
                        job = pair[1] if pair else json.loads(_s(raw)) if raw else None
                        if job is not None:
                            job['status'] = 'cancelled'
                            pipe.multi()
                            if pair:
                                pipe.zrem(JOBS_KEY, pair[0])
                            pipe.hdel(EXECUTING_KEY, target)
                            pipe.hset(HISTORY_KEY, target, json.dumps(job))
                            pipe.execute()
                            return job
                        history = pipe.hget(HISTORY_KEY, target)
                        target = (json.loads(_s(history)).get('next_job_id') if history else None)
                        if not target:
                            return None
                    return None
                except WatchError:
                    continue

    def _finish(self, job, *, retry_at=None):
        """Publish completion/retry/next cron atomically with the cancellation tombstone."""
        jid = job['job_id']
        next_job = None
        if retry_at is None and job['status'] == 'completed' and job.get('cron'):
            next_job = self._make_job({'cron': job['cron'], 'timezone': job.get('timezone', 'UTC'),
                'request': job['request'], 'metadata': job.get('metadata', {}),
                'retry': {k: v for k, v in job.get('retry', {}).items() if k != 'attempt'}})
            job['next_job_id'] = next_job['job_id']
        while True:
            with self._r.pipeline() as pipe:
                try:
                    pipe.watch(HISTORY_KEY, EXECUTING_KEY)
                    previous = pipe.hget(HISTORY_KEY, jid)
                    if previous and json.loads(_s(previous)).get('status') == 'cancelled':
                        return False
                    pipe.multi()
                    pipe.hdel(EXECUTING_KEY, jid)
                    if retry_at is not None:
                        pipe.zadd(JOBS_KEY, {json.dumps(job): retry_at})
                    else:
                        pipe.hset(HISTORY_KEY, jid, json.dumps(job))
                        if next_job:
                            pipe.zadd(JOBS_KEY, {json.dumps(next_job): next_job['execute_at']})
                    pipe.execute()
                    return True
                except WatchError:
                    continue

    def get(self, job_id: str) -> Optional[dict[str, Any]]:
        for store_key, getter in ((EXECUTING_KEY, self._r.hget), (HISTORY_KEY, self._r.hget)):
            raw = getter(store_key, job_id)
            if raw:
                return json.loads(_s(raw))
        for raw in self._r.zrange(JOBS_KEY, 0, -1):
            job = json.loads(_s(raw))
            if job.get("job_id") == job_id:
                return job
        return None

    def list(self, status: Optional[str] = None, limit: int = 50) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        with self._r.pipeline() as pipe:
            pipe.zrange(JOBS_KEY, 0, -1)
            pipe.hgetall(EXECUTING_KEY)
            pending, executing = pipe.execute()
        if status in (None, "pending"):
            for raw in pending:
                results.append(json.loads(_s(raw)))
        if status in (None, "executing"):
            for raw in executing.values():
                results.append(json.loads(_s(raw)))
        results.sort(key=lambda j: j.get("execute_at", 0))
        return results[:limit]

    # ── execution ────────────────────────────────────────────────────────────
    def recover_orphans(self) -> int:
        """Re-queue jobs that were executing when the process died (run on startup)."""
        executing = self._r.hgetall(EXECUTING_KEY)
        recovered = 0
        for job_id, raw in executing.items():
            job = json.loads(_s(raw))
            job["status"] = "pending"
            if not self._finish(job, retry_at=self.clock.now()):
                self._r.hdel(EXECUTING_KEY, _s(job_id))
                continue
            logger.warning("recovered orphaned job %s", _s(job_id))
            recovered += 1
        return recovered

    def _process(self, raw: str) -> None:
        job = json.loads(raw)
        job_id = job["job_id"]
        with self._r.pipeline() as pipe:
            try:
                pipe.watch(JOBS_KEY)
                if pipe.zscore(JOBS_KEY, raw) is None:
                    return
                job['status'] = 'executing'
                pipe.multi()
                pipe.zrem(JOBS_KEY, raw)
                pipe.hset(EXECUTING_KEY, job_id, json.dumps(job))
                pipe.execute()
            except WatchError:
                return

        retry = job.get("retry", {})
        try:
            result = self._dispatch(job["request"])
            job["status"] = "completed"
            job["result"] = result
            job["completed_at"] = self.clock.now()
        except Exception as e:  # noqa: BLE001 — any dispatch failure is a retry candidate
            attempt = retry.get("attempt", 0) + 1
            max_attempts = retry.get("max_attempts", 3)
            backoff = retry.get("backoff", [30, 120, 300])
            if attempt < max_attempts:
                delay = backoff[min(attempt - 1, len(backoff) - 1)]
                job["retry"]["attempt"] = attempt
                job["status"] = "pending"
                self._finish(job, retry_at=self.clock.now() + delay)
                logger.warning(
                    "job %s attempt %d/%d failed (%s), retry in %ss",
                    job_id, attempt, max_attempts, e, delay,
                )
                return
            job["status"] = "failed"
            job["error"] = str(e)
            job["failed_at"] = self.clock.now()
            logger.error("job %s permanently failed after %d attempts: %s", job_id, max_attempts, e)

        self._finish(job)

    def tick(self) -> int:
        """Fire every job due at the current Clock time. Returns the count processed."""
        now = self.clock.now()
        due = self._r.zrangebyscore(JOBS_KEY, "-inf", now)
        processed = 0
        for raw in due:
            self._process(_s(raw))
            processed += 1
        return processed
