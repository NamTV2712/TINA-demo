---
name: tina-setup
description: Set up or fix the self-hosted TINA MCP connection — where the API key comes from, which URL to use, and how to check the connection. Use when the tina server is missing, returns 401, or the user asks how to connect.
---

# TINA setup

The plugin needs a **TINA API key** (`tina_api_key`) and optionally the **MCP URL** (`tina_mcp_url`).

Run `make all` in the TINA checkout; it prints an API key when the stack is ready. The default MCP URL is `http://localhost:18056/mcp`. For another self-hosted deployment, point `tina_mcp_url` at its gateway's `/mcp` endpoint.

Check the connection by calling `whats_waiting`. A 401 means the key is missing or wrong; a connection error usually means the URL points at a stack that is not up.

Do not paste keys into chat or files. Tell the user to enter the key in the plugin's settings (it is stored in the OS keychain).
