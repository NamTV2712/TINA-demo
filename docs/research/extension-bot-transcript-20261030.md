# Extension — Meeting Bot transcript viewer

Implemented a separate **Meeting Bot** transcript source alongside **Local capture**.
Built artifact: `clients/extension/dist`, version `0.1030.1908.20` / `10-30 19:08:20`.

## Use

1. Load/reload the built extension while local capture is idle.
2. In Settings, use the API key for the account that owns or may view the meeting.
3. Set **Meeting Bot API gateway** and **TINA Terminal URL**. The selected production Compose
   configuration currently publishes `http://127.0.0.1:28056` and `http://127.0.0.1:23000`.
   Fresh-install standard ports are 18056 and 13000. These fields are separate from capture endpoints.
4. Choose **Transcript source → Meeting Bot**, Refresh meetings, select the exact row and
   press **Watch transcript**. **Open Terminal** opens `/meetings/{row_id}`.
5. **Ngừng xem** stops viewing and retains displayed text. The Bot keeps running.

The source selection persists across panel reopen. The meeting selection is chosen again on reopen;
history reloads from the server. Send a Bot from Terminal when no meeting exists. The viewer itself
never joins, starts or stops a Bot.

## Implementation boundaries

- Reuses `/meetings?limit=100&exclude_planned=true` and `/transcripts/by-id/{row_id}` with
  `X-API-Key`, no embedded URL credentials, cookies or redirects. Authorization remains server-owned.
- Uses exact row ID plus platform/native identity validation. Sessions sharing one meeting URL
  remain distinct. Invalid or unauthorized responses never become transcript content.
- Reads authoritative snapshots, which already merge Redis drafts, persisted segments, canonical
  edit/Restore and speaker identity overlays. The shared renderer preserves pending/final treatment,
  stable segment DOM, scroll control and timestamps. Legacy rows without segment IDs get a local
  render key only; nothing is written back to the backend.
- Polls 1.5 seconds after each completed request, retries transient failures after 3 seconds, and
  aborts outstanding requests/timers on unwatch or source/row/credential change. Requests have
  7-second timeouts. 401/403/404/410 clear private text/selection and stop automatic retry.
- Bot mode blocks automatic/manual local capture and toolbar tab-audio acquisition in background.
  Active capture or queued PCM prevents switching. Capture controls retain their original semantics
  and their Stop label when returning from Bot mode.
- API credentials remain in existing extension-local settings. No new extension permissions,
  backend endpoints, API contracts, ASR selection or production deployment were introduced.
- Architecture description, edge description, seal and generated views were synchronized.

## Verification

- `npm run typecheck`: PASS.
- `npm test`: PASS, including new Bot adapter and panel integration cases plus existing capture,
  lifecycle, canonical revisions, timeline and PCM replay regression suites.
- `npm run build`: PASS; final artifact version above.
- Extension import-isolation check: PASS (26 source files).
- Repository graph, dataflow and contract-version gates: PASS (40 sealed contracts unchanged).
- Whitespace check: PASS.
- Dedicated real Chrome profile, built side-panel bundle and local HTTP fixture: history/drafts,
  canonical edit/Restore, speaker rename, 503 recovery, exact-row switching on the same meeting URL,
  correct Terminal link, unwatch stopping requests while retaining text, permission/credential
  revocation clearing private text, no capture-control messages or mutating HTTP requests, and
  restoring the local Stop label all passed. Zero JavaScript exceptions; UI fit a 390px viewport.
- Browser evidence: `/var/folders/70/rdl_3lt13hz5vs7nrq835qcw0000gn/T/tina-bot-viewer-browser-wI784b/`
  (`result.json`, `bot-viewer.png`). Harness: `/tmp/tina-bot-viewer-browser-check.mjs`.
- Unit/regression output: `/tmp/tina-extension-bot-tests.log`.

The Chrome DevTools MCP profile was busy; it was left untouched. The isolated harness initially
attached to a Chrome component-extension target rather than a page. Creating a dedicated page
fixed that harness error. Final browser verification used the final build.

## Limits

Browser verification used synthetic meetings/audio text and mocked Chrome APIs. No real Meet/Zoom/
Teams Bot session, ASR inference, installed-user-profile extension reload or physical audio test
was performed. No production service/container restart or settings change was needed.

This viewer uses full REST snapshots, not ASR token streaming or a new WebSocket protocol.
Long transcripts/many viewers can justify an exact-row delta feed. The meeting list shows at most
100 recent accessible meetings; use Terminal for older records. HTTPS deployments require matching
Chrome extension host permissions; this manifest continues to grant loopback hosts only.
