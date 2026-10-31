# terminal — the browser-CLI workbench (Next.js)

## Routine scheduling and editing

`/routine` authors `routines/<file>.md` in the current private workspace. New commands include the
browser's IANA `timezone`; ask for the cadence when it is missing. Cron hours are local to that zone,
not preconverted to UTC. Legacy files with no zone retain UTC. The Routines board shows the zone,
workspace and next run; it refreshes while no draft is open.

Use Edit → Save/Cancel to change the display name, cron, zone or task. Display names are separate
from stable workspace/file IDs. Edit, toggle and delete carry the loaded source SHA-256; conflicts
keep the draft rather than overwriting a newer file. A private attached workspace participates in
the same listing/reconcile path. Shared workspace files do not automatically authorize schedules.
Delete removes the source file and cancels recurrence, including when the routine is disabled.
Stopping recurrence does not terminate an agent already admitted by the server.

## Meeting → transcript → Wiki

Open a meeting and use **Hỏi về cuộc họp này**. By default only that meeting's canonical transcript is used; expand **Tài liệu liên quan** to select linked private Wiki documents. Each answer shows clickable source quotations with speaker/time and saved segment audio when available. Bounded retrieval is labeled rather than presented as a complete meeting search.

Choose **Đề xuất cập nhật Wiki**, review the answer and sources, then **Xác nhận lưu vào Wiki**. This creates a new Markdown page and keeps existing documents unchanged. Source edits, Restore, speaker rename or timing/audio-reference changes make the answer stale and prevent Apply. The meeting panel and saved Wiki page recheck sources on focus, transcript correction and a 15-second interval; failures show unverified status. The feature is hidden in meetings-only deployments.

## Purpose

The user-facing client for the agent domain: a browser "terminal" that renders a
[dockview](https://dockview.dev) workbench over a registry of surfaces (chat, meeting,
workspace, routines, sessions, tasks). It owns no business logic — every surface talks to
agent-api through thin `/api/*` Next route proxies that keep the backend host (and any key)
server-side. Next.js because the workbench is a rich client UI and the proxies want a
same-origin server runtime (SSE relay, no CORS).

## Seams

| Direction | Neighbour | Via | What crosses |
|---|---|---|---|
| calls | agent-api | `POST /api/chat` (SSE proxy → `${AGENT_API}/api/chat`) | a chat now-dispatch; SSE relay of the agent's output stream |
| calls | agent-api | `GET /api/sessions?subject=` | a subject's chat-session list (resume) |
| calls | agent-api | `GET/POST /api/routines`, `PATCH /api/routines/{name}/enabled`, `DELETE /api/routines/{id}` | list / create / enable·disable / delete a `routine.v1` cron job |
| produces | agent-api | `POST /api/events` (→ `${AGENT_API}/events`) | an `event.v1` Event → a `unit.v1` Invocation → Dispatcher |
| calls | meeting-api (via gateway) | `GET /meetings` + `WS /ws` (`u:{user}:meetings`) | the user's meetings (live + past); live status deltas over the socket (no poll) |
| calls | agent-api | `GET /api/meeting/stream?meeting_id=&session_uid=` (SSE, `EventSource`) | live transcript + copilot output wire |
| calls | meeting-api (via gateway) | `POST /bots`, `DELETE /bots/{platform}/{native}`, `PUT /meetings/{platform}/{native}/intent` | launch / stop a self-hosted meeting bot; schedule·cancel its scheduling intent |
| calls | agent-api | `GET /api/workspace/{tree,file,git}?subject=` (git polled 5s) | workspace tree, file content, the agent's real git state |
| consumes | browser | dockview workbench + surfaces registry (`src/surfaces/index.tsx`) | LEFT lists, CENTER tab-kinds, RIGHT context-kinds, `/`-skill commands |

All upstreams resolve to `AGENT_API_URL` (default `http://127.0.0.1:18100`).

## Contracts

**Owns:** none — the terminal defines no `*.v1`; it is a pure client of the agent domain.
**Consumes:** `core/agent/contracts/event.v1` (the `/api/events` ingress shape), `routine.v1`
(routines CRUD), `unit.v1` (chat + SSE relay), and the meeting/workspace surfaces of
`core/agent/services/agent-api`. Schemas are sealed in `contracts.seal.json` (repo root) — the
proxies forward bodies verbatim, they do not re-declare schemas.

## Terminal modes

`NEXT_PUBLIC_TERMINAL_MODE` (build-time public env — inlined by `next build`, changing it requires a
rebuild; see `src/app/mode.ts`):

- unset / empty (default) — every surface registers.
- `meetings` — a meetings-only terminal: only the **Meetings** list, the **meeting/canvas** tabs, and
  the **API Tokens** surface register. The agent surfaces (chat, sessions, workspace/knowledge,
  routines) and their palette commands never register, and the server proxy refuses agent-api paths
  with 404 (`src/app/api/proxyMode.ts`), so no agent traffic is possible from this deployment.

Pass it as a Docker build arg (`--build-arg NEXT_PUBLIC_TERMINAL_MODE=meetings`) or via the
commented example on the `terminal` service in `deploy/compose/docker-compose.yml`.

## API tokens (self-serve)

The **API Tokens** left list (`src/surfaces/tokens.tsx`) lets the logged-in user list, mint
(scopes `bot`/`tx`/`browser`, optional name + expiry) and revoke their own tokens. The `/api/tokens`
routes call admin-api with the server's `TINA_ADMIN_API_KEY` (admin tier, like the login flow) and
scope every operation to the user resolved from the httpOnly auth cookies — a `user_id` from the
client is never accepted. The minted token value is returned once, at creation.

Separately, every OAuth **or** email **login** mints its own API token named `terminal-login`
(distinct from the self-serve tokens above). These login tokens are **capped per user** — after each
sign-in the terminal prunes a user's oldest `terminal-login` tokens beyond `TINA_TERMINAL_LOGIN_TOKEN_CAP`
(default `3`), so repeated sign-ins (including an OAuth redirect loop) leave a bounded set of live
tokens rather than one new token per sign-in. The prune only ever touches `terminal-login`-named
tokens; **self-serve tokens you created above are never pruned by login.**

## Isolated evaluation

No test suite yet (`tests/` absent). Standalone build + typecheck:

```bash
pnpm install && pnpm build      # next build = typecheck + lint (L1/L2)
pnpm dev                        # next dev -p 3000 — drive surfaces against a live agent-api (L4)
```

## Status

- ✅ delivered — dockview workbench + surfaces registry (chat / meeting / workspace / routines / sessions / tasks)
- ✅ delivered — `/api/chat` SSE proxy + resumable chat sessions (`/api/sessions`)
- ✅ delivered — routines board over `/api/routines` CRUD
- ✅ delivered — workspace files + docs viewer + git source-control panel (5s poll)
- ✅ delivered — live meeting surface: `/meetings` + `/ws` status (no poll) + `/api/meeting/stream` SSE + bot start/stop via `/bots`
- ✅ delivered — generic event ingress proxy (`/api/events` → `event.v1`)
- 🟡 partial — hardcoded `subject` per surface (`u_jane` / `u_live`), no real identity
- ⬜ planned — login (Google + dev type-any-email) → replace the hardcoded `subject` with the authenticated user
- ⬜ planned — real meetings list (live + past) with a recorded view
- ⬜ planned — routines type-toggle (agent | meeting)
- ⬜ planned — meeting ↔ doc cross-links
- ⬜ planned — a single gateway WS client replacing the polls

## Switching the ChatGPT plan account

Open **Settings → Models → Agent model** and select the ChatGPT plan connection.
Use **Disconnect ChatGPT**, then **Continue with ChatGPT** to connect a different account.
Continue/Reconnect also displays an **Open ChatGPT sign-in link**, a **Copy sign-in link** button,
and a selectable URL if the popup is blocked. In another browser/profile, the callback page offers
**Copy callback URL**. Paste it into **Callback URL from the other browser** in the original TINA
Settings tab and click **Finish connection**. Only the initiating TINA user can finish the connection;
an unauthenticated callback does not consume the request. The link is
kept only in component memory, cleared on successful connection/disconnect, and hidden after
10 minutes; use Continue/Reconnect to generate a fresh one.
Disconnect clears only the current TINA user's saved ChatGPT credentials and invalidates pending
sign-in callbacks. It does not sign out of TINA or the browser's ChatGPT session. Running jobs may
retain an already issued token until they finish. Complete account selection and consent yourself
in the authentication window; reconnecting does not change your transcription backend.

The meeting header labels **Meeting AI**, **chat**, and **ASR** separately. These show selected
configuration, not evidence of a successful model request. Personal model preferences take effect
on new worker dispatches; explicit workspace meeting model pins still take precedence.

Compose defaults `NEXTAUTH_URL` to the terminal's published loopback origin when it is empty.
Set it explicitly to the public HTTPS origin when deploying behind a reverse proxy.
