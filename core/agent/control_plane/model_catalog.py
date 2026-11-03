"""model_catalog.py — live provider model lists behind Settings → Models.

The picker must show the models the caller's OWN credential can use, so the provider API answers the
question instead of a curated list maintained here. The terminal keeps a small offline fallback for
the no-key / provider-unreachable case; this module is only the live answer.

Endpoints are FIXED first-party URLs selected by mode. No caller-supplied base URL reaches this
module, so it cannot be turned into a generic egress proxy. A credential may arrive from admin-api's
internal model-config edge or straight from the edit form; it is used for this one provider request,
never logged, and never returned.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Callable, Optional

HttpGet = Callable[[str, dict[str, str]], tuple[int, str]]

_TIMEOUT = 15.0
_MAX_MODELS = 80

# Chat models only: these families cannot run a conversation turn. A picker that lists them invites
# a 400 at the first message, so they are filtered before the list leaves this module.
_EXCLUDED_FRAGMENTS = (
    "embedding", "embed-", "whisper", "tts", "transcribe", "moderation", "dall-e", "gpt-image",
    "realtime", "audio", "sora", "computer-use", "search-preview", "search-api", "guard",
    "rerank", "ocr",
)
_LEGACY_PREFIXES = ("davinci", "babbage", "curie", "ada", "code-davinci", "code-cushman", "text-")
_DATED_SNAPSHOT = re.compile(r"-\d{4}-\d{2}-\d{2}$")

_PROVIDERS: dict[str, tuple[str, str]] = {
    "openai-api": ("OpenAI", "https://api.openai.com/v1/models"),
    "groq": ("Groq", "https://api.groq.com/openai/v1/models"),
    "deepseek": ("DeepSeek", "https://api.deepseek.com/models"),
    "gemini": ("Gemini", "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"),
    "antigravity": ("Gemini", "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"),
}

# Modes whose credential arrives in the query/header of a fixed endpoint above.
LIVE_MODES = frozenset(_PROVIDERS)


class CatalogError(Exception):
    """The provider could not answer, or answered with something that is not a model list.

    ``auth`` marks a rejected credential (401/403) so the route can pass that status through; every
    other failure is an upstream problem (502), not the user's key.
    """

    def __init__(self, message: str, *, auth: bool = False, status: int = 0) -> None:
        super().__init__(message)
        self.auth = auth
        self.status = status


def _get(url: str, headers: dict[str, str]) -> tuple[int, str]:
    """One fixed-provider GET. HTTP errors are values (the route decides the user-facing status)."""
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")


def _chat_model(model_id: str, *, drop_dated_snapshots: bool) -> bool:
    low = model_id.strip().lower()
    if not low or ":" in low:
        return False
    if low.startswith(_LEGACY_PREFIXES):
        return False
    if any(fragment in low for fragment in _EXCLUDED_FRAGMENTS):
        return False
    if drop_dated_snapshots and _DATED_SNAPSHOT.search(low):
        return False
    return True


def _openai_entries(payload: dict, *, drop_dated_snapshots: bool) -> list[dict]:
    """Parse the OpenAI-compatible ``{"data": [{"id", "created"}]}`` shape."""
    listed = payload.get("data")
    if not isinstance(listed, list):
        raise CatalogError("The provider returned an unexpected model list.")
    entries: list[dict] = []
    seen: set[str] = set()
    for item in listed:
        if not isinstance(item, dict):
            continue
        model_id = item.get("id")
        if not isinstance(model_id, str) or not model_id.strip() or model_id in seen:
            continue
        if not _chat_model(model_id, drop_dated_snapshots=drop_dated_snapshots):
            continue
        created = item.get("created")
        entries.append({
            "id": model_id,
            "name": model_id,
            "created": created if isinstance(created, int) else 0,
        })
        seen.add(model_id)
    entries.sort(key=lambda entry: (-entry["created"], entry["id"]))
    return entries


def _gemini_entries(payload: dict) -> list[dict]:
    """Parse Gemini's native ``{"models": [{"name": "models/<id>", ...}]}`` shape.

    ``supportedGenerationMethods`` is the capability gate: an embedding/vision-only entry never
    belongs in a chat picker even when its display name looks plausible.
    """
    listed = payload.get("models")
    if not isinstance(listed, list):
        raise CatalogError("Gemini returned an unexpected model list.")
    entries: list[dict] = []
    seen: set[str] = set()
    for item in listed:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        methods = item.get("supportedGenerationMethods")
        if isinstance(methods, list) and "generateContent" not in methods:
            continue
        model_id = name.split("/", 1)[1] if name.startswith("models/") else name
        low = model_id.lower()
        if model_id in seen or any(fragment in low for fragment in ("embedding", "aqa", "imagen", "veo")):
            continue
        display = item.get("displayName")
        entries.append({
            "id": model_id,
            "name": display if isinstance(display, str) and display.strip() else model_id,
        })
        seen.add(model_id)
    entries.sort(key=lambda entry: entry["id"])
    return entries


def list_models(mode: str, api_key: str, *, get: HttpGet = _get) -> dict:
    """Return ``{"mode", "models": [{"id", "name"}]}`` for one provider.

    The list is the provider's own answer for THIS credential. A missing key is a 400 (the form has
    not been filled yet); a rejected key is a 401 (the remedy is a new key), never a silent empty
    list that looks like \"this provider has no models\".
    """
    provider = _PROVIDERS.get(mode)
    if provider is None:
        raise CatalogError(f"Unknown model provider {mode!r}.", status=400)
    label, url = provider
    key = (api_key or "").strip()
    if not key:
        raise CatalogError(f"Add a {label} API key to load its model list.", status=400)
    headers = (
        {"x-goog-api-key": key} if mode in ("gemini", "antigravity") else {"Authorization": f"Bearer {key}"}
    )
    try:
        status, raw = get(url, headers)
    except Exception as error:  # DNS, TLS, refused connection, timeout
        detail = str(error).replace(key, "[redacted]")[:200]
        raise CatalogError(f"Could not reach {label}: {detail}") from error
    if status in (401, 403):
        raise CatalogError(
            f"{label} rejected the API key (HTTP {status}). Check the key and try again.",
            auth=True, status=status,
        )
    if not 200 <= status < 300:
        raise CatalogError(f"{label} model list answered HTTP {status}.")
    try:
        payload = json.loads(raw)
    except (ValueError, TypeError) as error:
        raise CatalogError(f"{label} returned a model list that is not JSON.") from error
    if not isinstance(payload, dict):
        raise CatalogError(f"{label} returned an unexpected model list.")
    entries = (
        _gemini_entries(payload)
        if mode in ("gemini", "antigravity")
        else _openai_entries(payload, drop_dated_snapshots=mode == "openai-api")
    )
    return {
        "mode": mode,
        "models": [{"id": entry["id"], "name": entry["name"]} for entry in entries[:_MAX_MODELS]],
    }


def masked_or_blank(value: Optional[str]) -> str:
    """The read-back mask (``********abcd``) is not a credential; treat it as absent."""
    text = (value or "").strip()
    return "" if text.startswith("********") else text
