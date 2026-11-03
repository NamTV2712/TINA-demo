"""Bedrock settings use native InvokeModel and region-scoped discovery."""
import json

import httpx
import pytest

from control_plane import config_test, dispatch, model_catalog
from llm.anthropic_api import AnthropicCompletion
from llm.claude_code import ClaudeCodeHarness


def test_native_bedrock_completion_encodes_profile_and_preserves_system():
    seen = []

    def respond(request):
        seen.append(request)
        return httpx.Response(200, json={"content": [{"type": "text", "text": "OK"}]})

    client = AnthropicCompletion(base_url="https://bedrock-runtime.us-east-1.amazonaws.com/anthropic",
                                 api_key="test-key", model="us.anthropic.claude-sonnet-4-6",
                                 transport=httpx.MockTransport(respond))
    assert client.complete("Hi", system="Be concise").text == "OK"
    request = seen[0]
    assert request.url.path.endswith("/model/us.anthropic.claude-sonnet-4-6/invoke")
    assert request.headers["Authorization"] == "Bearer test-key"
    assert "x-api-key" not in request.headers
    payload = json.loads(request.content)
    assert payload["anthropic_version"] == "bedrock-2023-05-31"
    assert payload["system"] == "Be concise"
    assert "model" not in payload
    assert payload["max_tokens"] > 0


def test_bedrock_test_explains_model_access_and_redacts_key():
    def post(url, body, headers):
        assert url.endswith("/model/us.anthropic.claude-sonnet-5/invoke-with-response-stream")
        assert headers == {"Authorization": "Bearer private-test-key"}
        return 403, json.dumps({"message": "Model is not available for this account. private-test-key"})

    result = config_test.test_bedrock("private-test-key", "us.anthropic.claude-sonnet-5", "us-east-1", post=post)
    assert not result["ok"]
    assert "not available for this account" in result["summary"]
    assert "private-test-key" not in result["summary"]


def test_bedrock_summary_model_is_tested_separately_and_no_foreign_key_fallback():
    seen = []

    def post(url, body, headers):
        seen.append(url)
        if len(seen) == 1:
            return 200, '{"content":[{"type":"tool_use","id":"probe-1","name":"tina_connection_check","input":{"nonce":"tina_probe"}}]}'
        if len(seen) == 2:
            return 200, '{"stop_reason":"end_turn","content":[{"type":"text","text":"OK"}]}'
        return 403, '{"message":"Meeting model denied"}'

    config = {"mode": "bedrock", "api_key": "own-key", "region": "us-east-1",
              "model": "chat", "meeting_model": "meeting"}
    result = config_test.run_models_test(config, env={}, post=post)
    assert len(seen) == 3
    assert not result["ok"] and "Meeting model" in result["summary"]
    del config["api_key"]
    seen.clear()
    result = config_test.run_models_test(config, env={"ANTHROPIC_AUTH_TOKEN": "foreign"}, post=post)
    assert not result["ok"] and seen == []


def test_bedrock_dispatch_pins_native_auth_and_aliases(monkeypatch):
    env = {}
    dispatch.overlay_model_config(env, {"mode": "bedrock", "api_key": "own-key",
                                       "region": "us-east-1", "model": "us.anthropic.claude-sonnet-4-6"})
    assert env["TINA_RUNNER"] == "claude-code"
    assert env["CLAUDE_CODE_USE_BEDROCK"] == "1"
    assert env["AWS_BEARER_TOKEN_BEDROCK"] == "own-key"
    assert env["AWS_REGION"] == "us-east-1"
    assert env["ANTHROPIC_API_KEY"] == env["ANTHROPIC_AUTH_TOKEN"] == ""
    assert env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] == env["TINA_AGENT_MODEL"]
    assert env["TINA_MEETING_MODEL"] == env["TINA_AGENT_MODEL"]
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    assert ClaudeCodeHarness().preflight() is None
    dispatch.overlay_model_config(env, {"mode": "groq", "api_key": "groq-key"})
    assert env["CLAUDE_CODE_USE_BEDROCK"] == env["AWS_BEARER_TOKEN_BEDROCK"] == ""


def test_regional_bedrock_catalog_uses_control_plane_and_inference_profiles():
    calls = []

    def get(url, headers):
        calls.append(url)
        assert url.startswith("https://bedrock.us-east-1.amazonaws.com/")
        assert headers == {"Authorization": "Bearer own-key"}
        if "inference-profiles" in url:
            return 200, json.dumps({"inferenceProfileSummaries": [
                {"inferenceProfileId": "us.anthropic.claude-sonnet-4-6", "status": "ACTIVE"},
                {"inferenceProfileId": "us.amazon.nova", "status": "ACTIVE"},
            ]})
        return 200, json.dumps({"modelSummaries": [
            {"modelId": "anthropic.claude-haiku-4-5", "inferenceTypesSupported": ["ON_DEMAND"]},
            {"modelId": "anthropic.claude-sonnet-4-6", "inferenceTypesSupported": ["PROVISIONED"]},
        ]})

    result = model_catalog.list_models("bedrock", "own-key", region="us-east-1", get=get)
    assert len(calls) == 2
    assert [x["id"] for x in result["models"]] == ["us.anthropic.claude-sonnet-4-6", "anthropic.claude-haiku-4-5"]


def test_bedrock_catalog_reads_later_pages_and_ranks_regional_suggestion():
    calls = []
    def get(url, headers):
        calls.append(url)
        if "foundation-models" in url:
            return 200, '{"modelSummaries":[]}'
        if "nextToken=" not in url:
            return 200, json.dumps({"inferenceProfileSummaries": [
                {"inferenceProfileId": "us.anthropic.claude-sonnet-5"}], "nextToken": "page/two+token"})
        assert "nextToken=page%2Ftwo%2Btoken" in url
        return 200, json.dumps({"inferenceProfileSummaries": [
            {"inferenceProfileId": "us.anthropic.claude-sonnet-4-6"}]})
    result = model_catalog.list_models("bedrock", "dummy", region="us-east-1", get=get)
    assert len(calls) == 3
    assert result["models"][0]["id"] == "us.anthropic.claude-sonnet-4-6"


@pytest.mark.parametrize("region", ["", "us-east-1.evil.test", "https://example.test", "../x"])
def test_bedrock_discovery_rejects_invalid_regions_without_sending_credentials(region):
    def forbidden(*args):
        raise AssertionError("must not call provider")

    with pytest.raises(model_catalog.CatalogError):
        model_catalog.list_models("bedrock", "key", region=region, get=forbidden)
