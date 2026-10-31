# TINA plugin for Claude Code

Claude Code plugin that connects the TINA MCP server (meeting bot + transcripts for Google Meet, Microsoft Teams and Zoom) and ships two skills: working with meetings, and setup.

The plugin marketplace is not published yet. For now, configure your MCP client with the local
gateway endpoint `http://localhost:18056/mcp` and the API key printed by `make all`. The plugin's
local configuration is in `.claude-plugin/plugin.json`.

See [`docs/docs/tina-mcp.mdx`](../../docs/docs/tina-mcp.mdx) for the MCP endpoint and tool list.
