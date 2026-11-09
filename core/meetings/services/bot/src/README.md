# @tina/bot — src

The bot worker's source. Hexagonal: the orchestrator core depends only on ports + contract
types; transports are adapters wired at the composition root.

**Status: 2b adapters wired (L1/L2/L3 green); the browser-resident legs are L4-pending → O6 (VM).**

Voice turn handling uses `voice-trigger.ts` for bounded lexical pause waits and source-clock
assembly; `voice-interruption.ts` verifies explicit same-caller commands and rejects echo text,
backchannels and stale ASR. `meeting-voice.ts` owns cancellation, correction continuation and
completed-sentence playback progress. Canonical ASR text and backend choice remain unchanged.

| File | Role |
|---|---|
| `index.ts` | **composition root** — validates config, launches the browser, wires the REAL adapters, runs the orchestrator, exits. Speak acts are tee'd to a voice handler (orchestrator core untouched). The container entrypoint (`main`). |
| `config.ts` | `invocation.v1` boot config — parse + ajv-validate `TINA_BOT_CONFIG`, fail-fast (P14). Exports the typed `Invocation`. |
| `ports.ts` | the port interfaces the core depends on: `JoinDriver · Pipeline · TranscriptSink · LifecycleSink · ActsSource · RecordingSink`. Pure (no transport types). |
| `test-doubles.ts` | shared L2 port doubles (`noopAloneness`, `noopActs`, `noopPipeline`, …) — one export site for every orchestrator construction in tests. |
| `orchestrator.ts` | the `lifecycle.v1` state machine (`createOrchestrator`) — joining → awaiting_admission → active → (completed \| failed). Depends only on ports. |
| `contracts.ts` | TS mirrors of the published `lifecycle.v1 · acts.v1 · transcript.v1` schemas + the executable `canTransition` machine. |
| `join-driver.ts` | **JoinDriver** — wraps `@tina/join` `joinMeeting`/leave/removal (guest + authenticated); maps `JoinState`→`BotStatus`. |
| `pipeline.ts` | **Pipeline** — `google_meet`→`@tina/gmeet-pipeline` (per-channel, glow-named) · `zoom`/`teams`→`@tina/mixed-pipeline`; STT via `@tina/transcribe-whisper`; lane sink → bot `TranscriptSink.publish`. Exposes `feedAudio`. |
| `recording.ts` | **RecordingSink** — `@tina/recording` assembler (`buildRecordingMaster` on `is_final`/`close`) → upload (`RecordingService`). |
| `capture-bridge.ts` | **L4-pending (O6)** — browser launch (+ S3 auth profile), page-side capture inject + PCM pump → `pipeline.feedAudio`, and the speak controller. Browser-resident; not unit-provable — validated on the VM. |
| `*.test.ts` | L1/L2/L3 — config (ajv goldens) · orchestrator (lifecycle.v1 sequence, fake ports) · lifecycle-http/transcript-redis/acts-redis (transports) · **pipeline (L3: capture→lane→stt→publish, overlap no cross-mislabel)** · **recording (L3: webm/wav/seq)**. |

Tests run via `tsx` (no build step): `npx tsx src/<file>.test.ts`; all chained in `npm test`.

Voice cancellation fences every asynchronous stop/receipt boundary so a superseded interruption
cannot revive a continuation. Brief missing Meet participant metadata is retained only on a continuous
channel clock for at most 1.5 seconds; resets, contradictions and expiry drop the binding. Explicit
interruption echo checks compare the current spoken phrase, not any keyword in cumulative answers.
`voice-regression.test.mjs` reproduces the stop/receipt race and metadata loss; interruption tests
cover a real stop command when the answer merely mentions that keyword.

Google Meet microphone control accepts only self-microphone action labels and, when present, reads
`data-is-muted`. Remote participant mute/presentation controls cannot establish the bot's mic state.
The serialized browser helper lives in `meeting-microphone.ts`; tests include the remote-control
labels observed in the live Meet UI. Playback and Stop still require a verified self-mic state.

Voice caller continuation expires after five seconds following acknowledgment, completed reply or
resumable interruption; a later question requires a fresh acoustic wake.

Optional delayed acknowledgment failures are logged without discarding a verified main answer. A failed, unplayed TTS lookahead is cancelled and prepared once more at its actual playback turn, after current generation/policy checks; a failed primary attempt or any started playback is never retried. Existing turn deadlines, Stop fences, and two-handle limits remain unchanged.

PreparedSpeech.failedBeforePlayback reports current unplayed stream failure even after its ready Promise resolved. The voice controller retries a failed prefetched sentence at most once, including failures during mic setup, cancels later speculative audio before replacement, and never retries started playback. Optional and name-only acknowledgments carry a three-second per-call TTS deadline through SpeakController; answer synthesis keeps its existing deadline.
