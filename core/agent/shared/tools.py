"""tools.py — the generic toolbelt mechanism (tool.v1 → a runner grant).

agent-api is TOOL-AGNOSTIC: it knows email/calendar/news/… not at all. Every capability is a ``tool.v1``
descriptor (name, grant auto|gate, transport mcp, the MCP server that backs it, governance barriers)
plus an MCP *launch* spec (how to start that server) — thousands of them, all loaded the same way. A
unit's scoped toolbelt (``unit.v1.tools`` = tool.v1 names) resolves HERE into a runner-neutral grant:
selected tools per server, server launch config, and auto/prompt modes. Claude Code consumes its
``--allowedTools`` and MCP config; Codex consumes per-server ``enabled_tools`` and its MCP approval
mode, surfacing gated calls through ``tool-approval.v1``. Unknown names are fail-closed (never
granted). This is the one place a tool becomes real for the unit; adding a tool is a descriptor, not
code.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional

import contracts


@dataclass
class ToolGrant:
    """The resolved, runner-neutral grant for a unit's selected tools."""
    allowed_tools: list[str] = field(default_factory=list)   # mcp__<server> entries for --allowedTools
    mcp_servers: dict = field(default_factory=dict)          # .mcp.json mcpServers (server id → launch)
    gated: list[str] = field(default_factory=list)           # attached but withheld (per-call approval)
    gated_mcp_servers: list[str] = field(default_factory=list)
    mcp_tools: dict[str, list[str]] = field(default_factory=dict)

    @property
    def has_mcp(self) -> bool:
        return bool(self.mcp_servers)

    def mcp_config(self) -> dict:
        return {"mcpServers": self.mcp_servers}


class ToolRegistry:
    """Resolves tool.v1 names → a ToolGrant. Built from a directory of tool specs (one JSON per tool:
    ``{"tool": <tool.v1>, "mcp": {"command","args","env"|"url","type"}}``) — config, not code."""

    def __init__(self, specs: Optional[dict] = None) -> None:
        self._specs = specs or {}

    @classmethod
    def from_dir(cls, path: str | Path) -> "ToolRegistry":
        specs: dict = {}
        p = Path(path)
        if p.exists():
            for f in sorted(p.glob("*.json")):
                spec = json.loads(f.read_text())
                tool = spec["tool"]
                contracts.validate_tool(tool)        # fail loud on a non-conformant descriptor (P8)
                specs[tool["name"]] = spec
        return cls(specs)

    def names(self) -> list[str]:
        return sorted(self._specs)

    def resolve(self, names: Iterable[str]) -> ToolGrant:
        grant = ToolGrant()
        server_modes: dict[str, str] = {}
        for name in names:
            spec = self._specs.get(name)
            if not spec:
                continue                              # fail-closed: an ungranted/unknown tool is silent
            tool = spec["tool"]
            mcp = spec.get("mcp")
            if tool.get("transport") == "mcp" and mcp:
                server = tool.get("mcp_server", name)
                mcp_tool_name = mcp.get("tool_name")
                if not isinstance(mcp_tool_name, str) or not mcp_tool_name.strip():
                    continue                              # fail-closed: never expose all sibling tools
                grant.mcp_servers[server] = {
                    k: v for k, v in mcp.items()
                    if k in (
                        "command", "args", "env", "env_vars", "url", "type",
                        "bearer_token_env_var", "env_http_headers",
                    )
                }
                server_tools = grant.mcp_tools.setdefault(server, [])
                if mcp_tool_name not in server_tools:
                    server_tools.append(mcp_tool_name)
                if tool.get("grant") == "auto":
                    server_modes.setdefault(server, "auto")
                else:
                    server_modes[server] = "prompt"
                    grant.gated.append(name)
        for server, mode in server_modes.items():
            if mode == "prompt":
                grant.gated_mcp_servers.append(server)
            else:
                grant.allowed_tools.append(f"mcp__{server}")   # auto grant for this server
        return grant


def apply_tool_grant(
    ws: Path, tools: Iterable[str], registry: Optional[ToolRegistry]
) -> "tuple[list[str], Optional[str]]":
    """Resolve a unit's toolbelt (unit.v1.tools names) onto a workspace → (--allowedTools, an injected
    .mcp.json path or None). The mcp config is written under ``.claude/`` so it is never staged/committed
    by the governance layer. Defaults to Read/Write/Edit; unknown tools are fail-closed (dropped).
    (The single place a tool grant becomes real for a turn — used by the worker's chat/meeting runners.)"""
    allowed = ["Read", "Write", "Edit"]
    names = list(tools)
    if registry is None or not names:
        return allowed, None
    grant = registry.resolve(names)
    allowed += grant.allowed_tools
    if not grant.has_mcp:
        return allowed, None
    (ws / ".claude").mkdir(parents=True, exist_ok=True)
    mcp_path = ws / ".claude" / "mcp.json"
    mcp_path.write_text(json.dumps(grant.mcp_config()))
    return allowed, str(mcp_path)
