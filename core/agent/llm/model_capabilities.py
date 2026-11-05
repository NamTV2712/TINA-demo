"""Automatic thinking policy and runner/model compatibility checks."""
from __future__ import annotations

import re
import hashlib
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=1)
def model_runtime_revision() -> str:
    """Refresh warm workers when the deployed provider adapters change, even on the same image tag."""
    digest = hashlib.sha256()
    for path in sorted(Path(__file__).parent.glob("*.py")):
        digest.update(path.name.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def normalized_effort(mode: str, model: str, effort: str | None) -> str:
    """Legacy saved/environment pins are ignored: all providers use Auto."""
    return ""


def groq_chat_model_error(model: str) -> str | None:
    """Known text-only models may summarize, but cannot run TINA's tool-using agent.

    Unknown/new IDs are not rejected here: Settings tests their actual tool round trip.
    ALLaM's Groq model card lists text/JSON output, and the API rejects function tools.
    """
    if model.strip() == "allam-2-7b":
        return (
            "Groq model allam-2-7b does not support tool calling required for TINA chat. "
            "Choose GPT-OSS or a tool-capable Qwen/Llama model in Settings → Models. "
            "ALLaM can still be selected as the Meeting model for summaries."
        )
    return None


def agy_builtin_model(model: str) -> bool:
    return bool(re.fullmatch(r"gemini-(?:(?:4-argon|3\.[678]-flash)(?:-(?:low|medium|high))?|3\.1-pro(?:-(?:low|high))?)", model))
