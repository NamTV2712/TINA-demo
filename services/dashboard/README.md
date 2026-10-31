# TINA Dashboard

## Why

Users need a visual interface to launch bots into meetings, watch live transcripts with speaker attribution, manage API tokens, and review past meetings. Without the dashboard, all interaction with TINA requires direct API calls. The dashboard provides the self-service experience for non-technical users and a convenient dev tool for API users.

## What

A Next.js web application that provides:
- Meeting management: launch bots (with optional authenticated mode toggle), see active/past meetings
- Live transcript viewer: real-time segments via WebSocket with speaker labels
- Recording playback: audio player synced with transcript segments
- Browser session management: VNC view, save/clear storage for authenticated bot credentials
- User/token management: create API keys, configure webhooks
- Admin analytics: user and meeting statistics

### Documentation
- [Dashboard UI](../../docs/ui-dashboard.mdx)

### Dependencies

- **api-gateway** -- all API calls route through the gateway
- **admin-api** (via gateway) -- user authentication and token management
- No direct database access -- fully API-driven

## How

See Quick Start and Local Development sections below.

---

This is an optional legacy TINA web UI. The Terminal (`clients/terminal`) is the primary workbench.
TINA is self-hosted; this dashboard connects to the gateway URL configured at runtime.

## Quick Start (Docker)

From the repository root, build and run the optional Compose profile:

```bash
docker compose -f deploy/compose/docker-compose.yml --profile dashboard up -d --build dashboard
```

It listens on `http://localhost:13001` by default.

## Local Development

The dashboard lives at `services/dashboard/` in this checkout.

```bash
cd /path/to/TINA/services/dashboard
npm install
cp .env.example .env.local
npm run dev
```

Local dev server runs on `http://localhost:3001`.

## Recording Playback (Post-Meeting)

On completed meetings, the meeting detail page can show an audio playback strip (if a recording exists) and highlight transcript segments during playback. Clicking a segment seeks the audio.

Backend requirements:
- TINA must expose recordings in the transcript response (so the dashboard can discover recordings without extra calls).
- `GET /recordings/{recording_id}/media/{media_file_id}/raw` should stream audio with `Range` support (`206`) and `Content-Disposition: inline` so browser seeking works.

Notes:
- The dashboard fetches audio through its own `/api/tina/...` proxy to avoid MinIO/S3 CORS issues.

## URL Proxy Pattern

All gateway requests from the browser go through Next.js server-side proxies — never directly to the gateway URL. This avoids CORS issues and keeps the gateway URL as a single env var (`TINA_API_URL`).

| Browser path | Proxied to | Configured in |
|---|---|---|
| `/api/tina/*` | `${TINA_API_URL}/*` | `src/app/api/tina/[...path]/route.ts` |
| `/b/*` | `${TINA_API_URL}/b/*` | `next.config.ts` rewrites |

**Rule:** Components must use relative paths (`/b/{token}/save`, `/api/tina/meetings`) for fetch calls. The public gateway URL (`publicApiUrl` from `/api/config`) is only for display purposes (e.g., CDP connection strings for external tools).

In Docker Compose, `TINA_API_URL` comes from the root `.env`. In Kubernetes, it comes from a ConfigMap.

## Zoom Notes

Zoom meeting joins require additional setup in the TINA backend (Zoom Meeting SDK + OAuth/OBF). See the TINA repo doc: `docs/zoom-app-setup.mdx`.

## Required Configuration

| Variable | Required | Notes |
|---|---|---|
| `TINA_API_URL` | Yes | TINA API base URL (usually `http://localhost:8056` for local TINA) |
| `TINA_ADMIN_API_KEY` | Yes | Admin API key used for auth/user management |
| `TINA_ADMIN_API_URL` | No | Optional override; defaults to `TINA_API_URL` |

## Common Optional Configuration

| Area | Variables |
|---|---|
| Session/auth | `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `JWT_SECRET`, `NEXT_PUBLIC_APP_URL` |
| Magic-link email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` |
| Google OAuth | `ENABLE_GOOGLE_AUTH`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Zoom OAuth | `ZOOM_OAUTH_CLIENT_ID`, `ZOOM_OAUTH_CLIENT_SECRET`, `ZOOM_OAUTH_REDIRECT_URI`, `ZOOM_OAUTH_STATE_SECRET` |
| AI assistant | `AI_MODEL`, `AI_API_KEY`, `AI_BASE_URL` |
| Registration policy | `ALLOW_REGISTRATIONS`, `ALLOWED_EMAIL_DOMAINS` |
| Bot defaults | `DEFAULT_BOT_NAME` |
| Frontend/public URLs | `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_BASE_URL`, `NEXT_PUBLIC_TRANSCRIPT_SHARE_BASE_URL` |

See `.env.example` for a complete template.

## Compose Example

```yaml
services:
  tina-dashboard:
    build:
      context: .
      dockerfile: services/dashboard/Dockerfile
      args:
        TINA_API_URL: http://gateway:8000
    image: tina/tina-dashboard:dev
    ports:
      - "3000:3000"
    environment:
      TINA_API_URL: http://tina:8056
      TINA_ADMIN_API_KEY: ${TINA_ADMIN_API_KEY}
```

## Test

```bash
cd services/dashboard
npm install
npm test
```

Runs vitest against `tests/` — covers `parseMeetingInput`, `parseUTCTimestamp`, `cn`, and language utilities.

## Troubleshooting

- Login or admin routes fail: verify `TINA_ADMIN_API_KEY` is valid.
- Dashboard loads but data is empty: verify `TINA_API_URL` is reachable from the container/runtime.
- OAuth callbacks fail: verify `NEXTAUTH_URL` and provider redirect URIs match exactly.
- Transcript page shows no data: verify the dashboard's `TINA_API_KEY` (or user's token) has `tx` scope. Tokens with only `bot` scope can create bots but can't read transcripts (403 on `/transcripts` endpoints).
- Browser session creation fails: verify the token has `browser` scope and concurrent bot limit is not exceeded (error: "Concurrent bot limit reached (N/5)").
- POST /bots returns 422 `[object Object]`: the gateway requires `platform` + `native_meeting_id` fields. The dashboard client-side parses meeting URLs to extract these. If the URL parse fails, the raw URL is sent and the gateway rejects it.

TINA has not yet been live-verified with this dashboard deployment.

## Screenshots

![Dashboard](docs/screenshots/01-dashboard.png)
![Join Meeting](docs/screenshots/02-join-meeting.png)
![Live Transcript](docs/screenshots/06-live-transcript.png)

## Related

- [`docs/docs/deployment.mdx`](../../docs/docs/deployment.mdx)
- [`docs/docs/tina-mcp.mdx`](../../docs/docs/tina-mcp.mdx)

## DoD

| # | Check | Weight | Ceiling | Status | Evidence | Last checked | Tests |
|---|-------|--------|---------|--------|----------|--------------|-------|
| 1 | Dashboard loads on port 3000 (Docker) / 3001 (dev) without errors | 20 | ceiling | untested | — | — | — |
| 2 | `TINA_API_URL` reachable and proxy `/api/tina/*` returns upstream responses | 25 | ceiling | untested | — | — | — |
| 3 | Login flow works (admin key or OAuth) and user session established | 20 | ceiling | untested | — | — | — |
| 4 | Meeting list page loads via `GET /meetings` through gateway | 15 | — | untested | — | — | — |
| 5 | `TINA_ADMIN_API_KEY` set and admin endpoints accessible | 10 | ceiling | untested | — | — | — |
| 6 | `npm test` passes (parseMeetingInput, parseUTCTimestamp, cn, language utils) | 10 | — | untested | — | — | — |

Confidence: 75 (5/6 items covered by tests3: DASHBOARD_UP health check, DASHBOARD_LOGIN contract, dashboard-auth.sh (login+cookie+identity), dashboard-proxy.sh (meetings+pagination+transcript), DASHBOARD_ADMIN_KEY_VALID. -15: npm test not run. -10: DoD items not scored individually against evidence.)

## License

Apache-2.0 (`LICENSE`)

## Shared Agent, meeting knowledge and reviewed actions

Dashboard `/api/agent/*` now forwards the signed-in user's cookie key to the existing Gateway `/agent/*` surface. No deployment token, caller-supplied user ID or direct Agent API service credential is used. Chat speaks `prompt/session/turn_id` and current UnitEvent SSE, with complete-frame cursor resumption. The shared `/api/models` selection is shown by `/api/ai/config`; Dashboard no longer needs a separate `AI_MODEL` or provider key for these flows. Change models and the ChatGPT connection in Terminal Settings; Compose supplies the public Terminal port for that link.

**Meetings → Ask AI** reads owner-scoped canonical sources, accepts explicitly selected related documents, shows clickable quotations/audio availability and supports reviewed create-only Wiki Apply. The `/workspace` page lists authorized active mounts and opens linked Markdown pages with source-freshness warnings. Private Markdown edits use the current content SHA-256; conflicts preserve the draft. **Lưu và ghi phiên bản** commits only the selected path locally, never pushes, and keeps unrelated staged changes untouched. Shared documents remain read-only in this editor.

The same meeting panel lists extracted actions/decisions/facts. Edit the display text and explicitly approve, discard or reopen a suggestion. Reviews have their own expected revision and source fingerprint; they do not rewrite canonical facts, transcript, speaker identity or audio. Stale evidence cannot be approved. This is review state, not a task assignment/notification system.

The first implementation retains bounded lexical retrieval (40 excerpts / 48,000 source characters) and single-meeting scope. Citation identity is validated; semantic correctness still needs human review. Workspace file writes and canonical reads do not form a distributed transaction. Test long-running live meetings separately.

## Navigation to Terminal

The Dashboard sidebar offers **TINA Terminal** in place of Wiki and TINA Agent. It opens the runtime-configured `terminalUrl` in a new tab; the Dashboard stays open. `TINA_TERMINAL_URL` can pin a public HTTP(S) URL; otherwise the request's public hostname and `TINA_TERMINAL_PUBLIC_PORT` are used. Existing direct `/workspace` and `/agent` routes and saved content remain available.
