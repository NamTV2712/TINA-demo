"""MVP3 generic tool mechanism — tool.v1 → a runner-neutral MCP grant.

Proves agent-api is TOOL-AGNOSTIC: a unit's toolbelt (unit.v1.tools names) resolves to the two levers
Claude Code and Codex understand; auto tools enter the allow-set, gate tools attach but are withheld;
Codex's selected per-server tool list prevents exposing sibling MCP operations; unknown names are
fail-closed. The legacy Claude Code helper injects an .mcp.json under .claude (never committed).
No tool's behaviour is hardcoded anywhere.
"""
from __future__ import annotations

import json
from pathlib import Path

import contracts
from llm.claude_code import build_argv
from shared.tools import ToolRegistry, apply_tool_grant

_EMAIL_TOOL = {
    "tool": {
        "name": "email", "scope": "inbox:read,draft:write", "grant": "auto",
        "cred_ref": "secret://email/oauth", "transport": "mcp", "mcp_server": "tina-email",
    },
    "mcp": {
        "command": "python", "args": ["-m", "tina_email_mcp"],
        "env": {"EMAIL_SERVICE_URL": "http://email:8200"}, "tool_name": "search",
    },
}
_SEND_TOOL = {
    "tool": {
        "name": "email.send", "scope": "send:self", "grant": "gate",
        "cred_ref": "secret://email/oauth", "transport": "mcp", "mcp_server": "tina-email-send",
        "barriers": ["info-barrier"],
    },
    "mcp": {
        "command": "python", "args": ["-m", "tina_email_send_mcp"],
        "tool_name": "send", "env_vars": ["TINA_AGENT_IDENTITY_TOKEN"],
    },
}


def _registry(tmp_path: Path) -> ToolRegistry:
    d = tmp_path / "tools-seed"
    d.mkdir()
    (d / "email.json").write_text(json.dumps(_EMAIL_TOOL))
    (d / "email.send.json").write_text(json.dumps(_SEND_TOOL))
    return ToolRegistry.from_dir(d)


def test_tool_descriptors_are_conformant():
    contracts.validate_tool(_EMAIL_TOOL["tool"])
    contracts.validate_tool(_SEND_TOOL["tool"])


def test_auto_tool_enters_allowset_gate_tool_is_withheld(tmp_path):
    reg = _registry(tmp_path)
    grant = reg.resolve(["email", "email.send"])

    # auto email tool → allow-set + attached server; gate send tool → attached but NOT allowed.
    assert "mcp__tina-email" in grant.allowed_tools
    assert "mcp__tina-email-send" not in grant.allowed_tools
    assert "email.send" in grant.gated
    assert set(grant.mcp_servers) == {"tina-email", "tina-email-send"}      # both ATTACHED
    assert grant.mcp_tools == {"tina-email": ["search"], "tina-email-send": ["send"]}
    assert grant.mcp_servers["tina-email"]["command"] == "python"
    assert grant.mcp_servers["tina-email-send"]["env_vars"] == ["TINA_AGENT_IDENTITY_TOKEN"]


def test_gate_tool_sharing_an_auto_server_never_becomes_auto(tmp_path):
    registry_dir = tmp_path / "tools-seed"
    registry_dir.mkdir()
    (registry_dir / "email.json").write_text(json.dumps(_EMAIL_TOOL))
    (registry_dir / "email.delete.json").write_text(json.dumps({
        "tool": {
            "name": "email.delete", "scope": "delete:self", "grant": "gate",
            "cred_ref": "secret://email/oauth", "transport": "mcp", "mcp_server": "tina-email",
        },
        "mcp": {"command": "python", "args": ["-m", "tina_email_mcp"], "tool_name": "delete"},
    }))

    grant = ToolRegistry.from_dir(registry_dir).resolve(["email", "email.delete"])

    assert "mcp__tina-email" not in grant.allowed_tools
    assert grant.gated_mcp_servers == ["tina-email"]
    assert "tina-email" in grant.mcp_servers
    assert grant.mcp_tools["tina-email"] == ["search", "delete"]


def test_mcp_tool_without_server_tool_name_is_fail_closed(tmp_path):
    registry_dir = tmp_path / "tools-seed"
    registry_dir.mkdir()
    spec = {
        "tool": {
            "name": "email", "scope": "inbox:read", "grant": "auto",
            "cred_ref": "secret://email/oauth", "transport": "mcp", "mcp_server": "tina-email",
        },
        "mcp": {"command": "email-read", "args": []},
    }
    (registry_dir / "email.json").write_text(json.dumps(spec))

    grant = ToolRegistry.from_dir(registry_dir).resolve(["email"])

    assert grant.allowed_tools == []
    assert grant.mcp_servers == {}
    assert grant.mcp_tools == {}


def test_unknown_tool_is_fail_closed(tmp_path):
    grant = _registry(tmp_path).resolve(["email", "nope"])
    assert "nope" not in grant.gated
    assert set(grant.mcp_servers) == {"tina-email"}                          # the unknown is silently dropped


def test_build_argv_attaches_mcp_config():
    argv = build_argv("hi", allowed_tools=["Read", "Write", "mcp__tina-email"], mcp_config="/ws/.claude/mcp.json")
    assert "--mcp-config" in argv and "/ws/.claude/mcp.json" in argv
    assert "--strict-mcp-config" in argv
    i = argv.index("--allowedTools")
    assert "mcp__tina-email" in argv[i + 1]


def test_apply_tool_grant_injects_mcp_json_under_dot_claude(tmp_path):
    ws = tmp_path / "ws" / "u_jane"
    ws.mkdir(parents=True)
    allowed, mcp_config = apply_tool_grant(ws, ["email"], _registry(tmp_path))

    mcp = ws / ".claude" / "mcp.json"
    assert mcp.exists()                                                      # injected, NOT in the kg
    assert "tina-email" in json.loads(mcp.read_text())["mcpServers"]
    assert mcp_config == str(mcp)
    assert "mcp__tina-email" in allowed
    # the mcp config is under .claude (excluded from governance) — never a workspace entity.
    assert not (ws / "mcp.json").exists()
    # and it wires through build_argv exactly as the runner used to.
    argv = build_argv("triage", allowed_tools=allowed, mcp_config=mcp_config)
    assert "--mcp-config" in argv and str(mcp) in argv
    assert "mcp__tina-email" in argv[argv.index("--allowedTools") + 1]
