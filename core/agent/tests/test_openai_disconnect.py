import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from control_plane import openai_auth as auth
from control_plane.api import create_app
from control_plane.dispatch import Dispatcher
from shared.config import load_settings
from shared.agent_config import load_meeting_config
from control_plane.workspace_reader import WorkspaceReader


def profile(account='old'):
    return {'subject': account, 'email': account + '@example.test', 'client_id': 'client', 'host_id': 'host',
            'id_token': 'private-id', 'access_token': 'private-access', 'refresh_token': 'private-refresh',
            'expires_at': 0, 'scopes': sorted(auth._SCOPES), 'saved_at': '2026-10-27T00:00:00Z'}


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setenv('TINA_OPENAI_AUTH_DIR', str(tmp_path))


def test_disconnect_isolated_idempotent_and_stale_callback_rejected():
    epoch = auth.connection_generation('one')
    auth.save_connection('one', epoch, profile())
    auth.save_connection('two', auth.connection_generation('two'), profile('other'))
    auth.disconnect('one'); auth.disconnect('one')
    assert auth.profile_status('one') == {'connected': False}
    assert auth.profile_status('two')['connected']
    with pytest.raises(auth.ChatGPTAuthError, match='cancelled'):
        auth.save_connection('one', epoch, profile('late-old-account'))
    with pytest.raises(auth.ChatGPTAuthError): auth.access_token('one')
    auth.save_connection('one', auth.connection_generation('one'), profile('new'))
    assert auth.profile_status('one')['email'] == 'new@example.test'
    assert auth._path('one').stat().st_mode & 0o777 == 0o600
    with pytest.raises(auth.ChatGPTAuthError): auth.disconnect('../two')


def test_disconnect_waits_for_refresh_and_cannot_resurrect(monkeypatch):
    auth.save_connection('one', auth.connection_generation('one'), profile())
    started, release = threading.Event(), threading.Event()
    class Response:
        def __enter__(self):
            started.set(); assert release.wait(3); return self
        def __exit__(self, *_): pass
        def read(self): return json.dumps({'access_token': 'refreshed', 'expires_in': 3600}).encode()
    monkeypatch.setattr(auth.urllib.request, 'urlopen', lambda *_args, **_kwargs: Response())
    with ThreadPoolExecutor(2) as pool:
        refresh = pool.submit(auth.access_token, 'one'); assert started.wait(3)
        logout = pool.submit(auth.disconnect, 'one'); time.sleep(.02); assert not logout.done()
        release.set(); assert refresh.result() == 'refreshed'; logout.result()
    assert not auth._path('one').exists()


def test_internal_connection_routes_fail_closed(monkeypatch):
    monkeypatch.setenv('TINA_INTERNAL_API_SECRET', 'internal-only')
    class Runtime:
        def spawn(self, *_): return 'unused'
    class Identity: pass
    client = TestClient(create_app(Dispatcher(load_settings(), Runtime(), Identity())))
    url = '/internal/openai-auth/one'
    for method in ['get', 'put', 'delete']:
        assert getattr(client, method)(url).status_code == 403
    headers = {'X-Internal-Secret': 'internal-only'}
    epoch = client.get(url, headers=headers).json()['generation']
    assert client.put(url, headers=headers, json={'generation': epoch, 'profile': profile()}).status_code == 200
    assert client.delete(url, headers=headers).json() == {'connected': False}
    assert client.put(url, headers=headers, json={'generation': epoch, 'profile': profile()}).status_code == 409
    monkeypatch.delenv('TINA_INTERNAL_API_SECRET')


def test_meeting_selection_uses_personal_default_until_workspace_pins_it(tmp_path, monkeypatch):
    monkeypatch.setenv('TINA_LLM_MODEL', 'old-local-model')
    assert load_meeting_config(tmp_path, default_model='gpt-6-luna').model == 'gpt-6-luna'
    config = tmp_path / 'agents/meeting.md'; config.parent.mkdir()
    config.write_text('---\nmodel: ""\n---\n')
    assert load_meeting_config(tmp_path, default_model='gpt-6-luna').model == 'gpt-6-luna'
    config.write_text('---\nmodel: deliberate-pin\n---\n')
    assert load_meeting_config(tmp_path, default_model='gpt-6-luna').model == 'deliberate-pin'


def test_model_labels_match_personal_selection_and_disconnect_state(tmp_path):
    class Runtime:
        def spawn(self, *_): return 'unused'
    class Identity: pass
    class Models:
        def resolve(self, subject):
            assert subject == 'one'
            return {'mode': 'openai-subscription', 'model': 'gpt-6-luna'}
    client = TestClient(create_app(
        Dispatcher(load_settings(llm_model='old-local-model'), Runtime(), Identity(), model_config=Models()),
        reader=WorkspaceReader(str(tmp_path / 'workspaces')),
    ))
    headers = {'X-User-Id': 'one'}
    auth.save_connection('one', auth.connection_generation('one'), profile())
    labels = client.get('/api/models', headers=headers).json()
    assert labels['streaming_model'] == labels['chat_model'] == 'gpt-6-luna'
    assert labels['chatgpt_connected'] is True
    auth.disconnect('one')
    assert client.get('/api/models', headers=headers).json()['chatgpt_connected'] is False
