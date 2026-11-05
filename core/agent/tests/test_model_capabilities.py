"""Model/runner effort pins must not survive unsupported combinations."""
import json

import pytest

from control_plane.dispatch import overlay_model_config
from llm.antigravity import AntigravityHarness, build_argv
from llm.model_capabilities import normalized_effort


@pytest.mark.parametrize("mode,model", [
    ("gemini", "gemini-3.5-flash"), ("gemini", "gemini-3.8-flash"),
    ("antigravity", "gemini-3.1-pro"), ("groq", "openai/gpt-oss-20b"),
    ("groq", "qwen/qwen3-32b"), ("bedrock", "us.anthropic.claude-sonnet-4-6"),
    ("deepseek", "deepseek-reasoner"), ("openai-api", "gpt-5"),
    ("openai-subscription", "gpt-5.2"), ("subscription", "sonnet"),
    ("custom", "my-model"), ("", "deployment-model"),
])
def test_all_providers_ignore_every_legacy_effort(mode, model):
    for level in ["minimal", "low", "medium", "high", "xhigh", "max", "unexpected"]:
        assert normalized_effort(mode, model, level) == ""


@pytest.mark.parametrize("mode,model,effort", [
    ("gemini", "gemini-3.5-flash", "xhigh"),
    ("gemini", "gemini-3.8-flash", "max"),
    ("deepseek", "deepseek-chat", "high"),
    ("groq", "llama-3.3-70b-versatile", "high"),
])
def test_stale_saved_effort_is_explicitly_cleared_at_dispatch(mode, model, effort):
    env = {"TINA_AGENT_EFFORT": effort}
    overlay_model_config(env, {"mode": mode, "model": model, "effort": effort, "api_key": "dummy"})
    assert env["TINA_AGENT_EFFORT"] == ""


@pytest.mark.parametrize("model,effort", [
    ("gemini-3.5-flash", "xhigh"), ("gemini-3.8-flash", "xhigh"), ("gemini-3.1-pro", "medium"),
])
def test_agy_never_receives_unsupported_effort(model, effort):
    assert "--effort" not in build_argv("hi", model=model, effort=effort)


def test_gemini_api_model_outside_cli_registry_is_registered_without_credentials(monkeypatch, tmp_path):
    monkeypatch.setenv("TINA_ANTIGRAVITY_AUTH_MODE", "gemini-api")
    monkeypatch.setenv("GEMINI_API_KEY", "dummy-secret-never-written")
    harness = AntigravityHarness()
    harness.prepare(tmp_path)
    path = harness._write_settings([], set(), [], model="gemini-3.5-flash")
    raw = path.read_text()
    settings = json.loads(raw)
    assert "dummy-secret-never-written" not in raw
    config = settings["customModelsConfig"]["customModels"]["gemini-3.5-flash"]
    assert config["modelName"] == "gemini-3.5-flash"
    assert config["toolFormatterType"] == "TOOL_FORMATTER_TYPE_NONE"
    path = harness._write_settings([], set(), [], model="gemini-3.8-flash")
    assert "customModelsConfig" not in json.loads(path.read_text())
