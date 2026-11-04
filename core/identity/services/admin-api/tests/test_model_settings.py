"""Settings → Models (identity side) — /user/models + /user/transcription self-serve, the
platform_settings internal CRUD, and the resolution edges dispatch/bot_spawn consume.

Secrets (api_key, transcription token) are masked on every user-facing read and cross in the
clear ONLY over the X-Internal-Secret edges (`/internal/users/{id}/model-config`, bot-context).
Effective config resolves FIELD-BY-FIELD user > platform; env fallback stays downstream.

Same testcontainers-PG harness as O-STACK-3 (skips without docker).
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from admin_api.app import db as app_db
from admin_api.app.main import create_app
from admin_api.schema.models import Base
from admin_api.schema.sync import ensure_schema_sync

from conftest import requires_docker
from test_stack_admin_api import ADMIN_TOKEN, INTERNAL_SECRET, _admin, _dispose_async_engine

pytestmark = requires_docker


@pytest.fixture()
def client(pg_url, pg_async_url, monkeypatch):
    sync_engine = create_engine(pg_url)
    Base.metadata.drop_all(sync_engine)
    ensure_schema_sync(sync_engine, Base)
    sync_engine.dispose()
    monkeypatch.setenv("ADMIN_API_TOKEN", ADMIN_TOKEN)
    monkeypatch.setenv("INTERNAL_API_SECRET", INTERNAL_SECRET)
    monkeypatch.setenv("DEV_MODE", "false")
    app_db.configure(pg_async_url)
    with TestClient(create_app()) as c:
        yield c
    _dispose_async_engine()


def _internal():
    return {"X-Internal-Secret": INTERNAL_SECRET}


def _user_token(client, email="models@example.test"):
    uid = client.post("/admin/users", headers=_admin(), json={"email": email}).json()["id"]
    tok = client.post(f"/admin/users/{uid}/tokens?scopes=bot", headers=_admin()).json()["token"]
    return uid, tok


def test_user_models_set_masked_readback_and_clear(client):
    _uid, tok = _user_token(client)
    h = {"X-API-Key": tok}

    r = client.put("/user/models", headers=h, json={
        "mode": "custom", "model": "qwen3-coder", "base_url": "https://llm.example.com/v1",
        "api_key": "sk-secret-1234abcd",
    })
    assert r.status_code == 200, r.text
    cfg = r.json()
    assert cfg["mode"] == "custom"
    assert cfg["model"] == "qwen3-coder"
    assert cfg["api_key_set"] is True
    # masked: the secret NEVER echoes in the clear
    assert "sk-secret" not in (cfg["api_key"] or "")
    assert cfg["api_key"].endswith("abcd")

    # partial update leaves other fields; empty string clears one
    r = client.put("/user/models", headers=h, json={"model": ""})
    cfg = r.json()
    assert cfg["model"] is None
    assert cfg["mode"] == "custom"          # untouched
    assert cfg["api_key_set"] is True       # untouched


def test_user_models_validation(client):
    _uid, tok = _user_token(client, email="val@example.test")
    h = {"X-API-Key": tok}
    assert client.put("/user/models", headers=h, json={"mode": "yolo"}).status_code == 422
    assert client.put("/user/models", headers=h, json={"base_url": "not-a-url"}).status_code == 422
    assert client.put("/user/transcription", headers=h, json={"url": "ftp://x"}).status_code == 422


def test_antigravity_user_mode_requires_and_persists_terms_acknowledgment(client):
    uid, tok = _user_token(client, email="agy@example.test")
    headers = {"X-API-Key": tok}

    assert client.put("/user/models", headers=headers, json={
        "mode": "antigravity",
    }).status_code == 422

    response = client.put("/user/models", headers=headers, json={
        "mode": "antigravity",
        "model": "gemini-3.1-pro",
        "api_key": "gemini-secret-1234abcd",
        "antigravity_terms_acknowledged": "true",
    })
    assert response.status_code == 200, response.text
    prefs = response.json()
    assert prefs["mode"] == "antigravity"
    assert prefs["antigravity_terms_acknowledged"] == "true"
    assert prefs["api_key_set"] is True
    assert prefs["api_key"].endswith("abcd")
    assert "gemini-secret" not in prefs["api_key"]

    effective = client.get(
        f"/internal/users/{uid}/model-config", headers=_internal(),
    ).json()["models"]
    assert effective["mode"] == "antigravity"
    assert effective["antigravity_terms_acknowledged"] == "true"
    assert effective["api_key"] == "gemini-secret-1234abcd"


def test_platform_settings_crud_and_gate(client):
    # internal edge only — no/wrong secret fails closed
    assert client.get("/internal/settings/models").status_code == 403
    assert client.put("/internal/settings/models",
                      headers={"X-Internal-Secret": "wrong"}, json={}).status_code == 403
    # unknown key 404s
    assert client.get("/internal/settings/nope", headers=_internal()).status_code == 404

    r = client.put("/internal/settings/models", headers=_internal(),
                   json={"model": "haiku", "mode": "subscription"})
    assert r.status_code == 200, r.text
    assert r.json()["value"] == {"model": "haiku", "mode": "subscription"}
    # partial update + clear
    r = client.put("/internal/settings/models", headers=_internal(), json={"mode": ""})
    assert r.json()["value"] == {"model": "haiku"}
    assert client.get("/internal/settings/models", headers=_internal()).json()["value"] == {"model": "haiku"}
    # same field rules as the user tier
    assert client.put("/internal/settings/models", headers=_internal(),
                      json={"mode": "yolo"}).status_code == 422


def test_model_config_resolves_user_over_platform(client):
    uid, tok = _user_token(client, email="resolve@example.test")
    client.put("/internal/settings/models", headers=_internal(),
               json={"model": "global-model", "meeting_model": "global-meeting",
                     "base_url": "https://global.example.com"})
    client.put("/user/models", headers={"X-API-Key": tok},
               json={"model": "my-model", "api_key": "sk-user-key"})

    r = client.get(f"/internal/users/{uid}/model-config", headers=_internal())
    assert r.status_code == 200, r.text
    models = r.json()["models"]
    assert models["model"] == "my-model"                       # user beats platform
    assert models["meeting_model"] == "global-meeting"         # platform fills the gap
    assert models["base_url"] == "https://global.example.com"  # field-by-field, not all-or-nothing
    assert models["api_key"] == "sk-user-key"                  # the secret crosses ONLY here

    # unknown subject → 404 (dispatch treats it as env defaults)
    assert client.get("/internal/users/999999/model-config", headers=_internal()).status_code == 404


def test_bot_context_carries_effective_transcription(client):
    uid, tok = _user_token(client, email="stt@example.test")
    # nothing configured → no transcription key at all (bot_spawn keeps its env)
    r = client.get(f"/internal/users/{uid}/bot-context", headers=_internal())
    assert "transcription" not in r.json()

    client.put("/internal/settings/transcription", headers=_internal(),
               json={"url": "https://stt-global.example.com", "token": "tok-global"})
    r = client.get(f"/internal/users/{uid}/bot-context", headers=_internal())
    assert r.json()["transcription"] == {
        "url": "https://stt-global.example.com",
        "token": "tok-global",
        "provider": "tina",
    }

    client.put("/user/transcription", headers={"X-API-Key": tok},
               json={"url": "https://stt-mine.example.com"})
    r = client.get(f"/internal/users/{uid}/bot-context", headers=_internal())
    # A customer URL never inherits the platform credential.
    assert r.json()["transcription"] == {
        "url": "https://stt-mine.example.com",
        "provider": "customer",
    }

    # masked user-facing read-back
    cfg = client.get("/user/transcription", headers={"X-API-Key": tok}).json()
    assert cfg["url"] == "https://stt-mine.example.com"
    assert cfg["token_set"] is False


def test_managed_viegem_persists_without_personal_credentials(client):
    uid, tok = _user_token(client, email="viegem@example.test")
    h = {"X-API-Key": tok}
    assert client.put("/user/transcription", headers=h, json={"backend": "viegem"}).status_code == 422
    r = client.put("/internal/settings/transcription", headers=_internal(), json={
        "viegem_url": "https://asr.example.test", "viegem_token": "managed-secret",
    })
    assert r.status_code == 200
    r = client.put("/user/transcription", headers=h, json={"backend": "viegem"})
    assert r.status_code == 200
    cfg = client.get("/user/transcription", headers=h).json()
    assert cfg["backend"] == "viegem"
    assert cfg["token_set"] is False
    assert cfg["url"] is None
    assert "managed-secret" not in str(cfg)
    effective = client.get(f"/internal/users/{uid}/bot-context", headers=_internal()).json()["transcription"]
    assert effective["backend"] == "viegem"
    assert effective["url"] == "https://asr.example.test"
    assert effective["token"] == "managed-secret"
    assert effective["provider"] == "tina"


def test_deployment_viegem_token_never_persists_in_settings(client, monkeypatch):
    monkeypatch.setenv("TINA_VIEGEM_TOKEN", "dotenvx-injected-secret")
    fresh = client.get("/internal/settings/transcription", headers=_internal()).json()
    assert fresh["configured"] is False
    assert fresh["value"]["viegem_token"] == "dotenvx-injected-secret"
    uid, tok = _user_token(client, email="encrypted-viegem@example.test")
    payload = {"viegem_url": "https://asr.example.test", "default_backend": "viegem"}
    r = client.put("/internal/settings/transcription", headers=_internal(), json=payload)
    assert r.status_code == 200
    assert r.json()["value"] == payload
    assert client.get("/internal/settings/transcription", headers=_internal()).json()["configured"] is True
    assert client.put("/internal/settings/transcription", headers=_internal(),
                      json={"viegem_token": "must-not-store"}).status_code == 422
    assert client.put("/user/transcription", headers={"X-API-Key": tok},
                      json={"backend": "viegem"}).status_code == 200
    effective = client.get(f"/internal/users/{uid}/bot-context", headers=_internal()).json()["transcription"]
    assert effective["token"] == "dotenvx-injected-secret"
    assert "dotenvx-injected-secret" not in client.get("/user/transcription", headers={"X-API-Key": tok}).text
    from sqlalchemy import text
    engine = create_engine(app_db._engine.url.set(drivername="postgresql+psycopg"))
    try:
        with engine.connect() as db:
            assert db.execute(text("SELECT value FROM platform_settings WHERE key = 'transcription'")).scalar_one() == payload
    finally:
        engine.dispose()


def test_asr_runtime_keeps_accounts_independent_and_fences_stale_updates(client):
    h = _internal()
    assert client.put("/internal/settings/transcription", headers=h, json={
        "gipformer_url": "http://gipformer.example.test", "gipformer_token": "gip-secret",
        "viegem_url": "http://viegem.example.test", "viegem_token": "vie-secret"}).status_code == 200
    first, one = _user_token(client, email="asr-one@example.test")
    second, two = _user_token(client, email="asr-two@example.test")
    for token in (one, two):
        assert client.put("/user/transcription", headers={"X-API-Key": token}, json={"backend": "viegem"}).status_code == 200
    before = client.get(f"/internal/transcription/runtime?user_id={first}", headers=h).json()
    assert before["counts"] == {"gipformer": 0, "viegem": 2}
    assert set(before) == {"counts", "account"}
    assert set(before["account"]) == {"backend", "enabled", "revision"}
    assert "token" not in str(before) and "email" not in str(before)
    revision = before["account"]["revision"]
    payload = {"backend": "gipformer", "enabled": "true", "expected_revision": revision}
    assert client.put(f"/internal/users/{first}/transcription-runtime", headers=h, json=payload).status_code == 200
    assert client.put(f"/internal/users/{first}/transcription-runtime", headers=h, json=payload).status_code == 409
    runtime = client.get(f"/internal/transcription/runtime?user_id={first}", headers=h).json()
    assert runtime["counts"] == {"gipformer": 1, "viegem": 1}
    assert "secret" not in str(runtime) and "asr-two" not in str(runtime)
    assert client.get("/user/transcription", headers={"X-API-Key": two}).json()["backend"] == "viegem"
    assert client.put(f"/internal/users/{first}/transcription-runtime", headers={"X-API-Key": two}, json=payload).status_code == 403
    payload = {"backend": "gipformer", "enabled": "false", "expected_revision": runtime["account"]["revision"]}
    assert client.put(f"/internal/users/{first}/transcription-runtime", headers=h, json=payload).status_code == 200
    config = client.get(f"/internal/users/{first}/transcription", headers=h).json()
    assert config["disabled"] is True and not config.get("url") and "token" not in config
