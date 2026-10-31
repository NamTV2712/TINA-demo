# desktop — the meetings all-in-one capture host (Node/TS)

`@tina/desktop` (`startDesktop()`) is the meetings data plane composed into **one local process** —
no Docker / Postgres / Redis. It accepts the browser extension's `capture.v1` audio over an ingest
WebSocket, routes it dual-lane (`gmeet-pipeline` per-channel for Google Meet, `mixed-pipeline` for
zoom/teams/youtube), drives **real STT**, and serves transcripts + assembled recordings over an HTTP
gateway. TypeScript because it runs the same browser-adjacent bricks the cloud splits across
meeting-api + collector + gateway, here as a single deployable "modular monolith."

All local listeners bind to `127.0.0.1` so meeting audio and transcripts are not exposed on the LAN.
For a host Desktop connected to this compose instance, build `@tina/desktop` and run from the repo:

```bash
node deploy/compose/bin/desktop-local.mjs
```

The launcher reads the identity port and internal secret from `deploy/compose/.env` (server-side
only). New ingest sessions resolve the same **personal → platform → environment** selection as
Terminal and meeting bots. Extension API keys select that account's preferences; native capture
uses Global defaults unless `TINA_DESKTOP_API_KEY` binds Desktop to an account. A bad key or a
settings outage refuses capture; it never silently selects another service. Existing sessions
keep their backend until stopped. Saving settings selects a service; it does not start that service.
For native TINA Capture, the launcher binds Desktop's ingest server to an ephemeral loopback port
and exposes the public `127.0.0.1:9099` endpoint through an authenticated proxy. The launcher
creates a random per-run secret in `~/Library/Application Support/local.tina.capture/desktop-ingest-token`
with owner-only permissions. TINA Capture sends a fresh challenge and verifies the proxy's HMAC
proof before requesting capture permission or sending audio. This local transport secret is
separate from `TINA_DESKTOP_API_KEY`; the Gateway credential stays in Desktop. The proof does not
isolate processes running as the same macOS user, which can read that user's application data.
The launcher also starts the loopback-only transcript text proxy on `127.0.0.1:8057`. It supports
`/dictation/polish` for final dictation and `/dictation/translate` for confirmed live caption text.
Both use the bound server-side API key to call the Agent CompletionPort; the proxy never forwards
audio, persists translations, or exposes the key to TINA Capture. If translation is unavailable,
the app keeps showing the original ASR transcript.

`GET /transcription/config` reports the safe selection for the next session. Ingest's `ready`
frame and each meeting's `transcription` field report its pinned backend, model alias, label and
source. These responses contain no STT URL or credential. The launcher translates
`host.docker.internal` service URLs to host loopback. Standalone Desktop without identity variables
retains the environment-only configuration below.

Confirmed transcripts, manual/restore revisions and delivered source PCM now persist automatically
in `transcripts.sqlite` under `TINA_RECORDINGS_DIR` (default: `.recordings` in the working directory).
Desktop recovers saved meetings on startup; a capture interrupted by a process exit is labelled
`interrupted`. `TINA_DESKTOP_RESTORE_FILE=/absolute/path/to/export.json` remains an optional bootstrap
for legacy completed meetings; existing journal rows win over an older export. Audio that was never
recorded cannot be recovered retroactively.

## ASR recovery from archived PCM

New captures also register an opaque digest of their selected ASR configuration and credentials,
language policy and captured speaker names. PCM ACK still means **audio saved**, not text ready.
After capture/flush stops, or after process restart, one worker plans the remaining source/sample
ranges from SQLite into windows of at most 15 seconds. It reuses the existing ASR client and Gmeet
confirmation engine with the existing mixed lane's media/repetition hallucination policy. Batch
recovery does not reject speech solely because it is a short single word; the live Gmeet default
is unchanged. RMS, ASR confidence and language-review checks still apply. It does not read the 30-second live ring for recovery and does
not fabricate samples across missing ranges. Known channel names and the local `You` mic survive;
mixed tab audio without reliable speaker identity remains unknown.

Live confirmed text and source coverage commit in one transaction. Recovery text, FTS index,
checkpoint and job completion also commit in one transaction. A job interrupted before commit
reuses its deterministic session/source/range id; committed jobs do not run again. Transient ASR
errors retry with 1–60 second backoff. A live confirmation that arrives during recovery supersedes
that recovery window, leaving its uncovered part available for replanning.

Stop/reconnect only plans missing source ranges; it does not checkpoint the entire captured
min/max span. A newly accepted late frame reopens a completed session atomically with its PCM
insert, before ACK. Quiet ranges can complete via the existing energy gate without fabricated
text. Old checkpoints are preserved, rather than silently reinterpreted as proven ASR requests.

Recovery yields to live capture and its final flush. Credentials stay in process memory; only a
digest is persisted. After restart Desktop resolves its configured host identity again. Personal
captures with unavailable/different settings wait for the original client to reconnect with the
same credentials/settings; the worker never silently picks another ASR service. Captures from
before this feature have no pinned recovery metadata and are not automatically decoded.

Owner-only `GET /transcripts/{platform}/{native_meeting_id}/asr-recovery` reports sessions,
the latest 100 windows/attempts and source/sample checkpoints under `asr-recovery.v1`.
The existing `/ws` health channel reports waiting/retry faults; recovered confirmed segments
use the ordinary transcript feed. Manual edits and Restore history remain authoritative.

`asr-recovery.test.ts` uses scratch journals and real child processes, kills Desktop during live
and recovery HTTP requests, then checks VI/EN mock-ASR results, source names, original timestamps,
atomic rollback, retry, pinned settings, access checks and duplicate-free restart. It builds the
Desktop first; it does not contact a real meeting or modify the user's recordings.
`asr-short-recovery.test.ts` covers short VI/EN speech, media/repetition/no-speech rejection,
source PCM and original timestamps through the real recovery worker with a local mock ASR.

Open `http://127.0.0.1:8056/` to review saved transcripts. The editor preserves original ASR text,
checks `expected_revision` before a correction, and supports Restore original. Available source
clips retain their capture session/channel/timestamp and silence gaps. Corrections require capture
to have stopped; this does not add LLM rewriting, word alignment or diarization.

Live confirmed messages also project the current accepted text from the journal. A late raw ASR
confirmation or speaker repaint cannot overwrite an owner edit or Restore in the live feed; raw
drafts for edited ids are suppressed. Original ASR/history remain in SQLite. The `transcript.v1`
shape is unchanged: text revisions are carried by canonical HTTP snapshots and metadata-only
`transcript.revised` notifications. The extension refreshes those snapshots without clearing its
unrelated pending drafts or resetting the reader's scroll position.

Set `TRANSCRIPTION_SERVICE_URL`, optional `TRANSCRIPTION_SERVICE_TOKEN`, and
`TRANSCRIPTION_MODEL` to select any OpenAI-compatible STT backend. The model defaults to
`whisper-1`; FunASR deployments must set it to the model alias exposed by their server.

For the local FunASR profile:

```bash
TRANSCRIPTION_SERVICE_URL=http://127.0.0.1:18000 \
TRANSCRIPTION_MODEL=custom \
pnpm start
```

## Seams

| Direction | Neighbour | Via | What crosses |
|---|---|---|---|
| consumes | browser extension | ingest `WS :9099` (`capture.v1` frames, codec-discriminated) | audio frames (ch999 mix / ch1000 mic / per-channel gmeet) + active-speaker event hints |
| consumes | browser extension | `POST /extension/sessions`, `POST /extension/sessions/end`, `POST /telemetry` | session mint / finalize-now (Stop contract) / diagnostics ring buffer |
| consumes | extension | ingest WS (`recording.v1` chunks, same socket, `REC1`-magic discriminated) | recording chunks → `RecordingSink` |
| calls | `@tina/transcribe-whisper` | `TranscriptionClient` over `TRANSCRIPTION_SERVICE_URL` | PCM → `stt.v1` segments |
| calls | identity admin-api | internal-secret `POST /internal/transcription/resolve` | account-bound or global STT selection; credentials stay server-side |
| produces | transcript readers / live UI | gateway `GET /transcripts/{p}/{n}`, `WS /ws` | `transcript.v1`-shaped confirmed/pending segments + `health` frames |
| produces | recording readers | gateway `GET /recordings/{p}/{n}` (+ `/player`), `GET /bots`, `GET /health` | assembled `recording.v1` master, meeting list, liveness |

## Contracts

**Owns:** none — the gateway shapes are local HTTP, not a sealed `*.v1` it defines.
**Produces:** meetings-owned `transcript-document.v1` review documents, local `transcript-refinement.v1` jobs/proposals and `asr-recovery.v1` status.
**Consumes:** [`core/meetings/contracts/transcript.v1`](../../contracts/transcript.v1) (the transcript
envelope it emits over `/ws` + `/transcripts`); `capture.v1` / `recording.v1` / `stt.v1` are owned by
the `@tina/capture-codec`, `@tina/recording`, and `@tina/transcribe-whisper` packages it composes, not
by the meetings `contracts/` registry. Access is mediated through one `canAccess` seam (`access.ts`,
P20 / ADR-0012; default `ownerOnly` = allow-all on single-user localhost).

## Isolated evaluation

Tests live alongside the source in `src/*.test.ts`. Run with `pnpm test` (the package's `test` script
runs each via `tsx`):

- **L2 unit** — `recording-sink.test.ts`, `transcript-store.test.ts`, `health.test.ts`, `access.test.ts`
- **L3 integration** — `recording-e2e.test.ts` (synthetic `recording.v1` over the real ingest WS → real file on disk → served by the gateway; no live meeting)
- **L4 live** — `desktop-e2e.live.test.ts` (real STT; skips without `TINA_TX_KEY` + `EVAL_CACHE`)

`pnpm check:isolation` enforces the brick-boundary rule.

## Status

- ✅ delivered — dual-lane ingest (gmeet per-channel + mixed pyannote-cut) with real STT
- ✅ delivered — gateway: sessions mint/end, `/transcripts`, `/bots`, `/health`, telemetry ring buffer, live `/ws`
- ✅ delivered — `recording.v1` receiver → assembled master + dependency-free `/player`
- ✅ delivered — `canAccess` mediation seam on every read path (default owner-only)
- ✅ delivered — P18 fault surfacing (engine fault + no-signal watchdog → `/ws health` · `/telemetry` · log)
- ✅ delivered — SQLite meeting/source-audio persistence, revision-safe corrections and restart recovery
- ✅ delivered — explicit post-meeting ASR refinement with saved proposals, progress/cancel and owner Apply in local Review
- 🟡 partial — access grants are the seam only (`ownerOnly`); real owner/visibility grants land additively (ADR-0003)

## Sample-indexed audio

Input audio now passes through the shared source ring (30 s/source, at most 16 sources across
sessions). Channel 1000 is the microphone and 999 is system/tab mixed audio; they never share PCM.
The source stamp and sample index, not WebSocket arrival time, determine the timeline. Captured
silence is archived too; Google Meet live ASR takes up to 200 ms of available onset pre-roll and a
short trailing pad. Stable-text confirmation retains the existing unconfirmed tail/context behavior.

`GET /transcripts/{platform}/{native}/audio-timeline` returns the `audio-timeline.v1` status.
With `session`, `source`, `start_sample`, `end_sample`, it returns up to 30 s as mono 16 kHz Float32 WAV.
RAM is tried first, then the same authorized meeting/session/source in SQLite. A gap returns 409 and
explicit missing intervals. `X-TINA-Audio-Source` is `memory` or `archive`. Every route uses meeting
read authorization and refuses a foreign browser Origin; a session from another meeting cannot
read its RAM via an authorized URL.

SQLite migration only adds nullable `start_sample`, `end_sample`, `source_capture_ms`, `clock_quality`
columns and a bounded event table; it does not backfill or rewrite old audio. Legacy archive audio
remains accessible by timestamp through existing review/playback routes. `clock_quality` distinguishes
source counters from inferred/unknown clocks. Metadata retains the newest 512 timeline events per
capture session; `/telemetry` exposes current bounded diagnostics. Ordinary ring `overflow` is retention
eviction, not proof of loss. A full live ASR working window/source budget produces a separate health
fault. Only audio successfully archived can be recovered; registered captures automatically queue
uncovered ranges using their pinned ASR configuration, as described above.

The ready message advertises `audio_timeline: "sample-index.v1"` and a `capture_session` UUID. New
Capture/Extension senders negotiate indexed headers; legacy senders remain accepted. Close releases
all source rings, and saved sample ranges remain readable after restart. This is the substrate for
future alignment; no forced aligner is introduced here.

## STT foundation and source synchronization

`GET /transcripts/{platform}/{native}/foundation` adds a portable snapshot with stable global
meeting/source/segment IDs, accepted revisions, source sample ranges and authority metadata.
Local IDs, SQLite and the existing transcript/review routes remain in place. Exports require capture
and final flush to have stopped. The authority is the source Desktop; copying its snapshot into a
Meeting API row creates an owner-only read-only replica, never another canonical writer.
See [stt-foundation.v1](../../contracts/stt-foundation.v1/README.md) for the CAS, ID, clock and synchronization contract.

`GET /transcripts/{platform}/{native}/metrics` exposes ASR request/capture lag, PCM/transcript
storage latency and optional foreground extension UI samples, with a bounded 256-sample window.
Use worker `/status` for inference/queue timing. See [stt-metrics.v1](../../contracts/stt-metrics.v1/README.md).

`pnpm test:soak` runs the isolated accelerated 60-minute source-clock test with three channels,
real SQLite and a child-process SIGKILL after an audio receipt. Set `TINA_SOAK_OUTPUT` to a fresh
external directory; allow about 700 MB for PCM plus journal overhead. The test preserves artifacts
and validates all source bytes, deduplication, beginning/middle/end playback, ID continuity and
edit/Restore. It uses deterministic synthetic text, not a one-hour ASR/microphone latency benchmark.
The ordinary package tests separately exercise real ingest WebSocket reconnect/crash recovery.
