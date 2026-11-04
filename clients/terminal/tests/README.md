# Terminal browser regressions

Run from `clients/terminal`:

```sh
node tests/brief-flow.browser.mjs
```

Requires installed Chrome, Terminal development dependencies and Dashboard development
dependencies (the harness reuses its installed Vite and Playwright packages).

The test bundles the real prep/chat UI and serves fixture API/SSE responses in an isolated
browser context. It checks Start brief delivery, explicit meeting/private workspace paths,
brief recovery after reload, shared README polling and preservation of the last good render
when a read fails. It also verifies research opt-in, final clickable sources replacing streamed
opaque citation ids, and source links surviving a chat-history reload. It does not use a real
provider account or modify production workspaces.

Component and unit regressions live in `src/**/__tests__/` and run with `npm test`.
