"""Settings → Models live catalogue — provider parsing, filtering and fail-loud statuses.

The picker's list is the provider's own answer for the caller's credential, so the parser must drop
non-chat entries (embeddings, TTS, dated snapshots) and surface a rejected key instead of an empty
list. Fixed endpoints only: no caller-supplied base URL reaches this module.
"""
import json

import pytest
from fastapi.testclient import TestClient

from control_plane import model_catalog as mc
from control_plane.api import create_app
from control_plane.dispatch import Dispatcher
from shared.config import load_settings


def _payload(entries):
    return json.dumps({"data": entries})


def test_groq_uses_fixed_endpoint_bearer_auth_and_drops_audio_models():
    calls = []

    def get(url, headers):
        calls.append((url, headers))
        return 200, _payload([
            {"id": "openai/gpt-oss-20b"},
            {"id": "whisper-large-v3"},
            {"id": "llama-3.3-70b-versatile"},
        ])

    out = mc.list_models("groq", "gsk_test", get=get)

    assert calls == [("https://api.groq.com/openai/v1/models", {"Authorization": "Bearer gsk_test"})]
    assert [model["id"] for model in out["models"]] == [
        "llama-3.3-70b-versatile", "openai/gpt-oss-20b",
    ]


def test_openai_drops_embeddings_tts_and_dated_snapshots():
    payload = _payload([
        {"id": "gpt-4o", "created": 1},
        {"id": "gpt-5", "created": 2},
        {"id": "gpt-5-2025-08-07", "created": 3},
        {"id": "text-embedding-3-large", "created": 4},
        {"id": "whisper-1", "created": 5},
        {"id": "dall-e-3", "created": 6},
        {"id": "ft:gpt-4o:acme", "created": 7},
    ])

    out = mc.list_models("openai-api", "sk-test", get=lambda url, headers: (200, payload))

    assert [model["id"] for model in out["models"]] == ["gpt-5", "gpt-4o"]


def test_gemini_uses_native_catalogue_headers_and_requires_generate_content():
    calls = []
    payload = json.dumps({"models": [
        {"name": "models/gemini-2.5-pro", "displayName": "Gemini 2.5 Pro",
         "supportedGenerationMethods": ["generateContent"]},
        {"name": "models/gemini-2.5-flash", "displayName": "Gemini 2.5 Flash",
         "supportedGenerationMethods": ["generateContent"]},
        {"name": "models/text-embedding-004", "displayName": "Embedding",
         "supportedGenerationMethods": ["embedContent"]},
    ]})

    def get(url, headers):
        calls.append((url, headers))
        return 200, payload

    out = mc.list_models("gemini", "gem-key", get=get)

    assert calls[0][0].startswith("https://generativelanguage.googleapis.com/v1beta/models")
    assert calls[0][1] == {"x-goog-api-key": "gem-key"}
    assert out["models"] == [
        {"id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash"},
        {"id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro"},
    ]


def test_antigravity_reuses_the_gemini_catalogue():
    seen = {}

    def get(url, headers):
        seen["url"] = url
        seen["headers"] = headers
        return 200, json.dumps({"models": [
            {"name": "models/gemini-2.5-pro", "supportedGenerationMethods": ["generateContent"]},
        ]})

    out = mc.list_models("antigravity", "gem-key", get=get)

    assert seen["url"].startswith("https://generativelanguage.googleapis.com/v1beta/models")
    assert seen["headers"] == {"x-goog-api-key": "gem-key"}
    assert out["models"][0]["id"] == "gemini-2.5-pro"


def test_rejected_key_is_an_auth_status_not_an_empty_list():
    with pytest.raises(mc.CatalogError) as error:
        mc.list_models("groq", "bad-key", get=lambda url, headers: (403, "{}"))

    assert error.value.auth is True
    assert error.value.status == 403
    assert "rejected the API key" in str(error.value)


def test_missing_key_and_unknown_mode_fail_with_400():
    with pytest.raises(mc.CatalogError) as missing:
        mc.list_models("deepseek", "")
    assert missing.value.status == 400

    with pytest.raises(mc.CatalogError) as unknown:
        mc.list_models("bedrock", "key")
    assert unknown.value.status == 400


def test_non_json_or_unexpected_shapes_are_upstream_errors():
    with pytest.raises(mc.CatalogError):
        mc.list_models("groq", "key", get=lambda url, headers: (200, "not json"))
    with pytest.raises(mc.CatalogError):
        mc.list_models("groq", "key", get=lambda url, headers: (200, json.dumps({"nope": []})))


def test_masked_read_back_is_not_a_credential():
    assert mc.masked_or_blank("********abcd") == ""
    assert mc.masked_or_blank("  gsk_real  ") == "gsk_real"
    assert mc.masked_or_blank(None) == ""


# ── the HTTP seam: which key reaches the provider ────────────────────────────────────────────────

class _Runtime:
    def spawn(self, workload_id, profile, env):  # pragma: no cover - the catalogue never dispatches
        return workload_id

    def await_done(self, workload_id, timeout_sec=0.0):  # pragma: no cover
        return "completed"


class _Identity:
    def mint(self, subject, launcher, workspaces, tools):  # pragma: no cover
        return "tok"


class _SavedConfig:
    """The resolver admin-api normally provides (user pref > platform setting, already collapsed)."""

    def __init__(self, config):
        self.config = config

    def resolve(self, subject):
        return self.config


def _app(config=None):
    dispatcher = Dispatcher(load_settings(), _Runtime(), _Identity())
    dispatcher._model_config = _SavedConfig(config) if config is not None else None
    return TestClient(create_app(dispatcher))


def _catalog(client, body, monkeypatch, *, seen):
    def fake(mode, api_key, get=mc._get):
        seen.append((mode, api_key))
        return {"mode": mode, "models": [{"id": "m", "name": "m"}]}

    monkeypatch.setattr(mc, "list_models", fake)
    response = client.post("/api/models/catalog", json=body, headers={"x-user-id": "u_jane"})
    return response


def test_draft_key_from_the_form_is_the_one_sent_to_the_provider(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    seen = []

    response = _catalog(_app(), {"mode": "groq", "api_key": "gsk_draft"}, monkeypatch, seen=seen)

    assert response.status_code == 200
    assert seen == [("groq", "gsk_draft")]


def test_saved_key_is_used_only_when_its_mode_matches_the_request(monkeypatch):
    """A saved GROQ key must never be sent to OpenAI — that mismatch is what looked like a bad key."""
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    seen = []
    client = _app({"mode": "groq", "api_key": "gsk_saved"})

    _catalog(client, {"mode": "openai-api"}, monkeypatch, seen=seen)
    _catalog(client, {"mode": "groq"}, monkeypatch, seen=seen)

    assert seen == [("openai-api", ""), ("groq", "gsk_saved")]


def test_masked_read_back_falls_back_to_the_saved_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    seen = []
    client = _app({"mode": "groq", "api_key": "gsk_saved"})

    _catalog(client, {"mode": "groq", "api_key": "********abcd"}, monkeypatch, seen=seen)

    assert seen == [("groq", "gsk_saved")]


def test_rejected_key_keeps_its_auth_status_on_the_wire(monkeypatch):
    def refuse(mode, api_key, get=mc._get):
        raise mc.CatalogError("Groq rejected the API key (HTTP 403).", auth=True, status=403)

    monkeypatch.setattr(mc, "list_models", refuse)

    response = _app().post("/api/models/catalog", json={"mode": "groq", "api_key": "bad"},
                           headers={"x-user-id": "u_jane"})

    assert response.status_code == 403
    assert "rejected the API key" in response.json()["detail"]
