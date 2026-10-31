"""Build the ``runtime.v1`` WorkloadSpec ``env`` for an agent worker.

The agent worker is spawned via runtime.v1 (profile ``agent``) with the workspace repo + a scoped
identity token in its ``env`` — exactly the shape of golden ``runtime.v1/spec-agent.json`` (P8):

    TINA_AGENT_IDENTITY_TOKEN · TINA_WORKSPACE_REPO · TINA_WORKSPACE_REF · TINA_WORKSPACE_PATH

This is the only place the agent-api shapes the runtime seam; the token is read from validated
config (a SecretStr) and never logged.
"""
from __future__ import annotations

from shared.config import Settings


def build_worker_env(settings: Settings, workspace_repo: str) -> dict[str, str]:
    """Map config + a target workspace to the worker's runtime.v1 env (12-factor, P7)."""
    env = {
        "TINA_AGENT_IDENTITY_TOKEN": settings.agent_identity_token.get_secret_value(),
        "TINA_WORKSPACE_REPO": workspace_repo,
        "TINA_WORKSPACE_REF": settings.workspace_ref,
        "TINA_WORKSPACE_PATH": settings.workspace_path,
    }
    if settings.agent_model:
        env["TINA_AGENT_MODEL"] = settings.agent_model
    return env
