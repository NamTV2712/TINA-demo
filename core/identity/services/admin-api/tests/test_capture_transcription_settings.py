"""Offline identity-bound capture configuration: central precedence and closed secret boundary."""
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from admin_api.app import db as app_db
from admin_api.app.main import create_app, _transcription_summary


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "internal-test-secret")
    monkeypatch.setenv("ADMIN_API_TOKEN", "admin-test-secret")
    monkeypatch.setenv("DEV_MODE", "true")
    user = SimpleNamespace(id=7, email="test@example.test", max_concurrent_bots=1,
                           data={"transcription_prefs": {"backend": "funasr"}})
    token = SimpleNamespace(expires_at=None, scopes=["bot"], last_used_at=None)
    platform = {"default_backend": "sherpa", "sherpa_url": "http://host.docker.internal:18001",
                "funasr_url": "http://host.docker.internal:18000", "token": "not-for-clients"}

    class DB:
        async def get(self, *_):
            return SimpleNamespace(value=platform)

        async def execute(self, statement):
            values = list(statement.compile().params.values())
            row = (token, user) if "valid-key" in values else None
            return SimpleNamespace(first=lambda: row, scalar_one_or_none=lambda: user)

        async def commit(self):
            pass

    app = create_app()

    async def database():
        yield DB()

    app.dependency_overrides[app_db.get_db] = database
    with TestClient(app) as client:
        yield client, token


def test_capture_config_uses_same_precedence_and_never_trusts_a_user_id(client):
    c, _ = client
    headers = {"X-Internal-Secret": "internal-test-secret"}
    url = "/internal/transcription/resolve"
    global_config = c.post(url, headers=headers, json={}).json()
    assert global_config["backend"] == "sherpa"
    assert global_config["summary"]["source"] == "platform"
    personal = c.post(url, headers=headers, json={"token": "valid-key", "user_id": 999}).json()
    assert personal["backend"] == "funasr"
    assert personal["summary"]["source"] == "user"
    assert personal["model"] == "custom"
    assert "url" not in personal["summary"] and "token" not in personal["summary"]
    assert c.post(url, headers=headers, json={"token": "bad-key"}).status_code == 401


def test_capture_door_rejects_missing_secret_and_wrong_scopes_even_in_dev(client, monkeypatch):
    c, token = client
    url = "/internal/transcription/resolve"
    assert c.post(url, json={}).status_code == 403
    token.scopes = ["browser"]
    assert c.post(url, headers={"X-Internal-Secret": "internal-test-secret"},
                  json={"token": "valid-key"}).status_code == 403
    monkeypatch.delenv("INTERNAL_API_SECRET")
    assert c.post(url, json={}).status_code == 503


def test_public_summary_is_safe_for_personal_custom_service_and_environment_fallback():
    summary = _transcription_summary({"backend": "custom", "url": "https://private.example", "token": "secret"}, {})
    assert summary == {"backend": "custom", "label": "Custom endpoint", "model": None, "source": "user"}
    assert _transcription_summary({}, {})["source"] == "environment"
    assert _transcription_summary({"backend": "default"}, {"default_backend": "sherpa"})["source"] == "platform"
