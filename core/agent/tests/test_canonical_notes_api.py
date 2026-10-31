import json

import fakeredis
from fastapi.testclient import TestClient

from control_plane.api import create_app
from control_plane.dispatch import Dispatcher
from shared.config import load_settings


def test_processing_uses_authenticated_owner_and_only_sets_flags_after_durable_configure(monkeypatch):
    import redis
    import urllib.request
    cache = fakeredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(redis, 'from_url', lambda *a, **kw: cache)
    seen = []
    class Response:
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def read(self): return b'{}'
    def request(req, **kwargs):
        seen.append((req.full_url, req.get_header('X-user-id'), json.loads(req.data)))
        return Response()
    monkeypatch.setattr(urllib.request, 'urlopen', request)
    class Runtime: pass
    class Identity: pass
    owner = {"id": 42, "native_meeting_id": "demo", "platform": "google_meet"}
    client = TestClient(create_app(
        Dispatcher(load_settings(), Runtime(), Identity()), redis_url='redis://test',
        meeting_owner_lookup=lambda user_id, meeting_id: owner if (user_id, meeting_id) == ("7", "42") else None,
    ))
    path = '/api/meeting/process'
    body = {'meeting_id': '42', 'native_id': 'demo', 'on': True, 'subject': 'forged'}
    assert client.post(path, json=body, headers={'X-User-Id':'7'}).status_code == 202
    assert seen[-1][1:] == ('7', {'enabled': True})
    assert cache.get('canonical:meeting:42:on') == '1'
    assert cache.get('proc:meeting:42:on') == 'owner:7'
    assert client.post(path, json=dict(body,on=False), headers={'X-User-Id':'7'}).status_code == 202
    assert cache.get('canonical:meeting:42:on') is None
    def unavailable(*a, **kw): raise OSError('unavailable')
    monkeypatch.setattr(urllib.request, 'urlopen', unavailable)
    assert client.post(path, json=body, headers={'X-User-Id':'7'}).status_code == 503
    assert cache.get('proc:meeting:42:on') is None
