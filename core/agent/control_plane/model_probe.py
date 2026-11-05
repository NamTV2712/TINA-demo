"""No-op tool round trips for the native APIs used by the chat runners.

The caller owns fixed endpoint selection and credentials. These probes execute no
workspace or external tool, and preserve every assistant part (including thinking
signatures) when sending a tool result back to the model.
"""
from __future__ import annotations

import json
from typing import Callable

HttpPost = Callable[[str, dict, dict], tuple[int, str]]
RequestBuilder = Callable[[dict], tuple[str, dict, dict]]
TOOL = "tina_connection_check"
NONCE = "tina_probe"
INSTRUCTION = ("Call tina_connection_check with nonce tina_probe exactly once. "
               "After it returns, reply only OK. This tool has no side effects.")


def _request(label: str, secret: str, post: HttpPost, request: tuple[str, dict, dict]):
    try:
        status, body = post(*request)
    except Exception as exc:
        return None, {"ok": False, "summary": f"{label} endpoint unreachable: "
                      + str(exc).replace(secret, "[redacted]")[:200]}
    if not 200 <= status < 300:
        try:
            payload = json.loads(body)
            error = payload.get("error", {})
            reason = error.get("message", "") if isinstance(error, dict) else str(error)
            if not reason:
                reason = payload.get("message") or payload.get("Message") or payload.get("detail") or payload.get("__type") or body
        except (ValueError, TypeError, AttributeError):
            reason = body or ""
        return None, {"ok": False, "status": status,
                      "summary": f"{label} rejected the request (HTTP {status}): "
                                 + str(reason).replace(secret, "[redacted]")[:300]}
    try:
        result = json.loads(body)
        if not isinstance(result, dict):
            raise ValueError("not an object")
    except (ValueError, TypeError):
        return None, {"ok": False, "summary": f"{label} returned an invalid JSON response."}
    return result, None


def anthropic_tools(label: str, model: str, secret: str, post: HttpPost,
                    build: RequestBuilder) -> dict:
    request = {
        "model": model, "max_tokens": 1024, "system": INSTRUCTION,
        "messages": [{"role": "user", "content": "Check the connection using the tool."}],
        "tools": [{"name": TOOL, "description": "No-op connection check.", "input_schema": {
            "type": "object", "properties": {"nonce": {"type": "string"}}, "required": ["nonce"],
            "additionalProperties": False,
        }}],
        "tool_choice": {"type": "auto"},
    }
    response, error = _request(label + " chat tool calling", secret, post, build(request))
    if error:
        return error
    try:
        content = response["content"]
        call, = [part for part in content if part.get("type") == "tool_use"]
        valid = (call.get("name") == TOOL and call.get("input") == {"nonce": NONCE}
                 and isinstance(call.get("id"), str) and bool(call["id"]))
    except (KeyError, TypeError, ValueError, AttributeError):
        valid = False
    if not valid:
        return {"ok": False, "summary": f"{label} model {model} did not return a valid function tool call. "
                "A text completion alone does not verify TINA agent chat."}
    followup = {**request, "messages": request["messages"] + [
        {"role": "assistant", "content": content},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": call["id"], "content": "OK"}]},
    ]}
    response, error = _request(label + " chat tool results", secret, post, build(followup))
    if error:
        return error
    try:
        text = "".join(part.get("text", "") for part in response.get("content", [])
                       if part.get("type") == "text")
        completed = response.get("stop_reason") == "end_turn" and bool(text.strip())
    except (TypeError, AttributeError):
        completed = False
    if not completed:
        return {"ok": False, "summary": f"{label} model {model} did not complete its reply after a tool result."}
    return {"ok": True, "status": 200, "summary": f"{label} native chat tool round trip OK ({model})."}


def gemini_tools(model: str, secret: str, post: HttpPost) -> dict:
    from urllib.parse import quote
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{quote(model, safe='')}:generateContent"
    headers = {"x-goog-api-key": secret}
    request = {
        "systemInstruction": {"parts": [{"text": INSTRUCTION}]},
        "contents": [{"role": "user", "parts": [{"text": "Check the connection using the tool."}]}],
        "tools": [{"functionDeclarations": [{"name": TOOL, "description": "No-op connection check.",
            "parameters": {"type": "OBJECT", "properties": {"nonce": {"type": "STRING"}},
                           "required": ["nonce"]}}]}],
        "toolConfig": {"functionCallingConfig": {"mode": "ANY", "allowedFunctionNames": [TOOL]}},
        "generationConfig": {"maxOutputTokens": 1024},
    }
    response, error = _request("Gemini native chat tool calling", secret, post, (url, request, headers))
    if error:
        return error
    try:
        content = response["candidates"][0]["content"]
        call, = [part["functionCall"] for part in content["parts"] if "functionCall" in part]
        valid = call.get("name") == TOOL and call.get("args") == {"nonce": NONCE}
    except (KeyError, IndexError, TypeError, ValueError, AttributeError):
        valid = False
    if not valid:
        return {"ok": False, "summary": f"Gemini model {model} did not return a valid function call. "
                "Choose a model with function calling for TINA chat."}
    result = {"name": TOOL, "response": {"result": "OK"}}
    if call.get("id"):
        result["id"] = call["id"]
    followup = {**request, "contents": request["contents"] + [content, {
        "role": "user", "parts": [{"functionResponse": result}],
    }], "toolConfig": {"functionCallingConfig": {"mode": "AUTO"}}}
    response, error = _request("Gemini native chat tool results", secret, post, (url, followup, headers))
    if error:
        return error
    try:
        candidate = response["candidates"][0]
        text = "".join(part.get("text", "") for part in candidate["content"]["parts"]
                       if not part.get("thought"))
        completed = candidate.get("finishReason") == "STOP" and bool(text.strip())
    except (KeyError, IndexError, TypeError, AttributeError):
        completed = False
    if not completed:
        return {"ok": False, "summary": f"Gemini model {model} did not complete its reply after a tool result."}
    return {"ok": True, "status": 200, "summary": f"Gemini native chat tool round trip OK ({model})."}
