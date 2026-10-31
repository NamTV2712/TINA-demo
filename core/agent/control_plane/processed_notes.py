"""Dispatch durable canonical-window requests; model credentials resolve for the meeting owner."""
import json
import logging
import threading
import time
import os
import hmac
import hashlib
from uuid import UUID

from shared import units

log = logging.getLogger(__name__)
REQUESTS = 'canonical_notes_requests'


def dispatch_request(dispatcher, job, *, validate_lease):
    secret = os.environ.get('TINA_INTERNAL_API_SECRET', '')
    if not secret:
        raise RuntimeError('Canonical notes verification is not configured')
    if not isinstance(job, dict) or not isinstance(job.get('proof'), str):
        raise ValueError('Unsigned canonical request')
    expected = hmac.new(secret.encode(), json.dumps({k: v for k, v in job.items() if k != 'proof'},
        sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, job['proof']):
        raise ValueError('Invalid canonical request proof')
    if (not isinstance(job, dict) or type(job.get('meeting_id')) is not int or job['meeting_id'] <= 0
            or type(job.get('user_id')) is not int or job['user_id'] <= 0):
        raise ValueError('Invalid canonical notes owner/meeting')
    source = job['source']
    generation = str(UUID(source['generation']))
    if (not isinstance(source.get('fingerprint'), str) or len(source['fingerprint']) != 64
            or not isinstance(source.get('evidence'), list) or not source['evidence']):
        raise ValueError('Invalid canonical window')
    if not validate_lease(job):
        return None
    inv = units.make_dispatch(
        subject=str(job['user_id']), trigger='transcription',
        start=units.entrypoint(inline=units.CANONICAL_NOTES_PREFIX + json.dumps(job, ensure_ascii=False)),
        context={'kind': 'meeting', 'meeting': {'meeting_id': str(job['meeting_id']),
                 'session_uid': 'canonical-' + generation, 'platform': job.get('platform') or 'google_meet'}},
    )
    # The worker may select the canonical-notes runner only for requests that crossed this
    # proof + owner-scoped lease validation boundary.
    return dispatcher.dispatch(inv, trusted_canonical_notes=True)


def lease_validator(base_url):
    import urllib.request
    import urllib.error
    def validate(job):
        source = {k: job['source'][k] for k in ('window_id', 'generation', 'fingerprint')}
        req = urllib.request.Request(base_url.rstrip('/') + f'/transcripts/by-id/{job["meeting_id"]}/processed-notes/validate',
            data=json.dumps(source).encode(), method='POST',
            headers={'X-User-Id': str(job['user_id']), 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                return json.load(response).get('valid') is True
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return False
            raise
    return validate


def start(redis_url, dispatcher):
    def run():
        import redis
        client = redis.from_url(redis_url, decode_responses=True)
        validate = lease_validator(dispatcher.settings.meeting_api_url)
        while True:
            try:
                try:
                    client.xgroup_create(REQUESTS, 'canonical-agent', id='0-0', mkstream=True)
                except redis.exceptions.ResponseError as exc:
                    if 'BUSYGROUP' not in str(exc): raise
                pending = client.xreadgroup('canonical-agent', 'agent-api', {REQUESTS: '0'}, count=10)
                if not pending or not pending[0][1]:
                    pending = client.xreadgroup('canonical-agent', 'agent-api', {REQUESTS: '>'}, count=10, block=2000)
                for _, entries in pending or []:
                    for entry_id, fields in entries:
                        raw = fields.get('payload') or '{}'
                        try:
                            if len(raw) > 128000: raise ValueError('Window request too large')
                            job = json.loads(raw)
                            if not isinstance(job, dict): raise ValueError('Invalid canonical request')
                            if job.get('lease_until', 0) > time.time():
                                dispatch_request(dispatcher, job, validate_lease=validate)
                        except (ValueError, KeyError, TypeError):
                            log.error('Invalid canonical notes request rejected')
                        else:
                            client.xack(REQUESTS, 'canonical-agent', entry_id)
                            client.xdel(REQUESTS, entry_id)
                            continue
                        client.xack(REQUESTS, 'canonical-agent', entry_id)
                        client.xdel(REQUESTS, entry_id)
            except Exception:
                log.exception('Canonical notes dispatch unavailable; pending requests will retry')
                time.sleep(2)
    thread = threading.Thread(target=run, daemon=True, name='canonical-notes-watch')
    thread.start()
    return thread
