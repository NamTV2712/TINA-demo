# Wake-word + TTS implementation plan

Status: proposed implementation checklist; no speech runtime is deployed by this document.
Branch: `feat/tina-speech`. Source baseline: `6dfbbbf`.

## Agreed outcome

Each participant runs microphone capture and wake-word detection on their own machine. After
"Hey TINA", that participant asks a question. One meeting-level dispatcher obtains an answer
from the meeting's approved transcript/Wiki sources. One TTS output speaks that answer into
the meeting. Ordinary meeting transcription continues throughout.

Use `lean-build`: reuse published boundaries, complete one narrow path, and stop when its
observable acceptance conditions pass. The objective is minimal coupling, not an arbitrary
one-file implementation.

The first supported room has one platform, one voice-enabled browser bot, one designated
operator/owner, and explicitly enrolled participants. Start with question answering; automatic
document edits, tool execution, personal agents, interruption while speaking, and additional
meeting platforms are later work. Wake detection is activation, not authentication or consent
to execute an action.

### Proposed model baseline (not installed or quality-validated yet)

- Wake-word: `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`, INT8,
  with the English keyword `HEY TINA` tokenized using that model's BPE files. Run on each
  participant's CPU. Evaluate Vietnamese-accented pronunciation before accepting it.
- TTS: Piper/VITS `vi_VN-vais1000-medium`, using its Sherpa-ONNX-compatible export
  `vits-piper-vi_VN-vais1000-medium` in one shared CPU service. The original voice card
  specifies Vietnamese, one speaker and 22,050 Hz; the service adapter must resample to
  the bot's 24,000 Hz PCM contract. This is a Vietnamese baseline, not a bilingual-voice claim.
- Both baselines can be evaluated without a paid cloud speech API. Exact assets, revisions,
  hashes, model/export terms and dependency versions are fixed during steps 0-2, after checking
  the chosen artifacts. No voice cloning or model training is part of this baseline.
- Sources: [Sherpa KWS models](https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html),
  [original Vietnamese voice card](https://huggingface.co/rhasspy/piper-voices/blob/main/vi/vi_VN/vais1000/medium/MODEL_CARD),
  [Sherpa-compatible voice export](https://huggingface.co/csukuangfj/vits-piper-vi_VN-vais1000-medium).

## Verified starting points

| Capability | Existing implementation | Consequence |
| --- | --- | --- |
| Per-machine capture | `clients/desktop-native` is macOS-specific; no cross-platform wake-word client exists | Add a small separate local client; do not make the macOS application a Windows prerequisite |
| Sherpa KWS | `core/meetings/services/native-asr/vendor/sherpa-onnx/src/kws.rs` exports `KeywordSpotter` | This is a library capability, not a configured detector; keep vendored code untouched |
| STT | `deploy/transcription/docker-compose.cpu.yml`, existing OpenAI-compatible transcription API | Reuse Faster-Whisper; do not replace the meeting buffers or confirmation engine |
| Gateway-only client | `clients/slim/tina_slim/client.py` and `sse.py` | Reuse these boundary conventions, not domain internals; its chat helper is not a complete voice-turn controller |
| Grounded Wiki Q&A | `core/agent/control_plane/meeting_knowledge.py`, `shared/meeting_knowledge.py` | Reuse source selection, citations, ownership and stale-source checks; do not create a competing RAG index |
| Common speech output | `lifecycle/speak_router.py`, `bot_spawn/service.py`, bot `tts-playback.ts` | Use existing `POST`/`DELETE /bots/{platform}/{native}/speak`; do not publish directly to Redis |
| Playback cancellation | `createSpeakController`, `TtsPlayback.stop()` | Reuse; protect each turn from late synthesis/results |
| Playback completion | Speak returns `accepted`, and bot playback errors are currently best-effort logs | HTTP acceptance does not prove synthesis or audible playback; automated room sequencing needs completion/error evidence |

Operational snapshot when preparing this plan:

- Windows checkout: branch `feat/tina-speech`, revision `6dfbbbf`.
- WSL checkout used to build the stack: `a4eed12`. Updating Windows does not update WSL or built images.
- `tina-local` has no configured `TTS_SERVICE_URL`/`TTS_API_TOKEN`.
- Earlier synthetic agent checks succeeded for independent questions but failed two memory-recall
  checks. Use source-grounded questions for this MVP; do not depend on conversational memory.
- Earlier STT `/health` checks passed; CLI `asr verify` expects `/status`, which this Faster-Whisper
  server does not implement. Do not treat that check alone as an inference verdict.

## Minimal architecture

```text
Participant's machine (explicit Start/Stop)
  microphone -> normalized PCM -> Sherpa KWS
                                  |
                              wake event
                                  v
                       bounded question capture + VAD
                                  |
                     authenticated request + short WAV
                                  v
Meeting-level coordinator (one instance for the pilot)
  participant authentication + explicit room enrollment
    -> one active turn per room
    -> existing STT endpoint
    -> Gateway: existing meeting Knowledge /ask
    -> validate source policy and freshness
    -> Gateway: existing bot /speak
    -> playback outcome -> release turn -> re-arm clients
                                  |
Existing meeting bot: TTS service -> PulseAudio -> meeting microphone
```

Capture/detection must run on the participant's host. WSL runs the current backend, but microphone
availability inside WSL is not assumed. Test the host client on its actual operating system.
No new bot capture hooks or changes to Google Meet/Teams segmentation are needed for this topology.

The coordinator is a small application above the domains, initially planned under `clients/speech/`.
It consumes Gateway APIs; it must not import meetings/agent internals or hold a Redis URL.
Its externally consumed request/event schemas remain core-owned, as required by `AGENTS.md`.
It holds the operator's server credentials privately. Local clients receive no bot-owner, LLM,
shared STT or TTS service secret.

Important access constraint: the current Q&A and Speak endpoints are owner-scoped. A common session
string does not create shared access. For the pilot, an operator explicitly enrolls authenticated
TINA users into one room and approves the transcript and linked Wiki documents that may be spoken
to that room. Validate participant identity through Gateway `/auth/me`; never trust a caller's
`user_id` field. The coordinator's operator identity must own the configured meeting/bot.
Reject unenrolled users and meeting/document substitutions. This explicit pilot delegation does
not change core meeting ownership or imply arbitrary shared-workspace support.

## Ordered work and exit gates

### 0. Establish one development source and test fixtures

- [ ] Preserve `note.txt`, existing output artifacts, local WSL changes and private env files.
- [ ] Bring the WSL development checkout to the intended `feat/tina-speech` revision through an
      explicit Git operation after checking both working trees. Do not blindly mirror directories.
- [ ] Keep the running `tina-local` stack and the private Terminal development overlay; use a
      dedicated speech test room/config. Do not use `docker compose down -v` or rotate existing keys.
- [ ] Prepare consented positive and negative audio: several speakers saying "Hey TINA", near-match
      names/phrases, normal conversation, noise, silence, and TINA's own synthesized speech.
- [ ] Keep model files/audio outside source control. Record model URL, revision, SHA-256, language
      coverage and redistribution terms in an asset manifest before deployment.

Exit: one identified source revision, recoverable local config, and reproducible audio fixtures.

### 1. Prove text -> TTS -> meeting before adding wake-word

- [ ] Select one self-hosted TTS backend and voice that passes Vietnamese/English listening checks
      on the actual CPU hardware. Do not add several providers or train a voice for the MVP.
- [ ] Implement an adapter only if the selected backend cannot expose the existing bot contract:
      `POST {TTS_SERVICE_URL}/v1/audio/speech`, JSON
      `{model:"tts-1", input:text, voice:"auto", response_format:"pcm"}`,
      `X-API-Key: <TTS_API_TOKEN>` when configured.
- [ ] Verify headerless PCM16 little-endian, mono, **24 kHz**; resample exactly once if needed.
      A WAV header, a different sample rate, or Bearer-only auth cannot silently pass as compatible.
- [ ] Use a private env file and optional deployment overlay. Configure the endpoint/token for
      Meeting API, then spawn a **new** voice-enabled bot; old bot environments are not updated.
- [ ] Send a bounded text through the Gateway Speak endpoint, then test DELETE Speak cancellation.
      Current text limit is 4,000 characters; reject or deliberately shorten oversized answers.
- [ ] Verify actual received audio from a second participant/test recording. HTTP 200/`accepted`
      and generated PCM alone are insufficient proof.

Exit: audible, intelligible speech and working Stop on one platform. The ordinary transcript path
continues to work. No changes to the LLM worker, transcript schema, or meeting capture modules.

### 2. Prove local wake detection without agent/network actions

- [ ] Add the isolated `clients/speech/` package with one CLI entry point and an explicit microphone
      device selector. Start with Python 3.11, Sherpa-ONNX Python bindings and a host audio adapter;
      pin the versions proven by the fixture run. Do not extend the native-ASR HTTP server for
      frame-by-frame detection or modify its vendored Rust bindings.
- [ ] Select one English-capable KWS model and configure "HEY TINA" with that model's tokenizer.
      Test Vietnamese-accented speakers. A supported model language is not proof of this phrase's
      accuracy; "TINA oi" is not silently accepted as equivalent language support.
- [ ] Normalize incoming audio once to the selected model format, typically 16 kHz mono PCM.
      Use a dedicated capture/inference queue so native audio callbacks never block on HTTP.
- [ ] Keep a short bounded ring buffer. Record the wake boundary so the immediate following question
      is not clipped; only remove the wake prefix at that boundary, never arbitrary words in text.
- [ ] Emit one local wake event per utterance; add cooldown/reset and isolate detector state per
      microphone. VAD ends the question; it must not replace wake detection.
- [ ] Measure detection misses, false triggers, wake latency and CPU on held-out human audio.
      Do not count TTS-generated fixtures alone as human wake-word validation.

Exit: repeatable local wake events without sending audio to STT/LLM or playing speech.

### 3. Connect one authorized participant end to end

- [ ] Implement the coordinator and its narrow request/status contract. Proposed local state:
      `OFF -> ARMED -> CAPTURING -> WAITING -> SPEAKING -> ARMED`, with explicit error/cancel paths.
      Apply a bounded no-speech timeout, question duration and audio/text size limit.
- [ ] Authenticate/enroll the participant and accept one bounded WAV with a stable request ID.
      The coordinator uses the already-running STT service with server-held credentials. Do not
      distribute the shared transcription token or use Terminal's cookie-based `/api/stt` as if it
      were a machine API accepting arbitrary `X-API-Key` headers.
- [ ] Call `POST /agent/workspace/meeting-knowledge/{meeting_id}/ask` through Gateway using the
      configured operator identity and approved linked document paths. Reuse its existing
      `{question, documents, meeting_ids}` body. Restrict the pilot to one meeting.
- [ ] Check the returned answer/source IDs, approved source paths and `stale` state. Speak the
      validated `claims[].text` only. Empty claims produce a fixed "not enough information" reply.
      A network/model/source error never falls through to raw JSON, logs, tool output or an
      unrelated personal-chat answer. A read-only question may store an answer snapshot as the
      existing API does; it never calls Wiki Apply or document-edit endpoints automatically.
- [ ] Tie the request lifecycle to real synthesis/playback outcome. The current bot Speak path
      has no completion acknowledgement. Add the smallest correlated started/completed/failed/
      stopped status seam under meetings ownership, with existing Gateway authorization and
      optional command correlation for legacy callers. Define exact wire shape in the contract
      change, then update affected callers/goldens/seals. Do not infer playback completion from
      HTTP acceptance, a log string, or a character-count sleep.
- [ ] Ignore a late result after cancellation and return to ARMED on bounded failure.

Exit: one real microphone -> wake -> STT -> grounded answer -> audible shared TTS, including
cancel/error recovery. No requirement for multi-turn LLM memory or automatic business actions.

### 4. Add the remaining enrolled participants

- [ ] Maintain one active turn per room centrally, from question capture through playback completion.
      Use a bounded busy response first, rather than an unbounded queue of stale spoken questions.
- [ ] Deduplicate a participant retry by authenticated identity + request ID; preserve the same ID
      on retry. Do not automatically repeat an ambiguously accepted Speak command.
- [ ] Pause wake-triggered dispatch on **every enrolled client** during a shared reply. A missing
      coordinator/status connection disarms dispatch; microphone recording permission remains a
      local explicit choice. Re-arm only after terminal playback status or operator recovery.
- [ ] Test one spoken call heard by two nearby microphones. Request IDs alone do not deduplicate
      physical cross-talk; the central capture grant must allow only one winning client.
- [ ] Handle disconnect/restart explicitly. The first single-process coordinator may keep volatile
      state, but restart invalidates grants and requires re-arming; do not claim durable exactly-once
      playback or silently replay requests. Add persistent delivery state only if acceptance needs it.
- [ ] Test with headphones and loudspeakers, simultaneous callers, a muted/disconnected bot and
      STT/LLM/TTS failures. No automatic retry may produce a second shared answer.

Exit: two separate host clients can ask in turn, only one answer plays, and room audio cannot
cause repeated wake -> answer loops.

## Change budget and ownership

| Area | Planned change |
| --- | --- |
| `clients/speech/` (new) | Local audio/KWS adapter, bounded turn controller, coordinator, Gateway/TTS clients, focused tests and README; split by responsibility only as needed |
| `deploy/speech/` (new, only if needed) | One optional TTS deployment and private configuration example; no new default startup services |
| Core contracts | New speech-turn/status boundary owned by the appropriate core domain; additive correlation for the existing Speak path only when implementing playback status |
| Meeting API + bot | Minimal playback lifecycle/status bridge, preserving existing Speak/Stop behavior; no direct agent imports |
| Agent/Knowledge | Reuse the current published endpoint; no second prompt/retrieval pipeline |
| Architecture/config | Update `architecture.calm.json`, declarations/examples and matching seals in the same implementation change |

Do not edit `transcribe-buffer`, LocalAgreement, speaker attribution, transcript storage, the
Dispatcher, model-provider adapters, identity policies or existing user tables for this feature.
If a genuine owner/access restriction prevents the intended room policy, stop treating it as a
client bug: document the exact missing authorization contract before expanding core behavior.

The plan itself changes documentation only, so the architecture model continues to describe the
implemented runtime. Add proposed nodes/flows when code actually introduces them, not in advance.

## Focused acceptance and stop condition

- Deterministic tests: no wake -> no request; one wake -> one capture; VAD timeout; cooldown;
  cancellation; empty STT; malformed/stale/unauthorized Wiki answers; TTS failure; no re-entrance
  while speaking; late responses discarded; stable retry identity; two-client capture arbitration.
- Contract/seam tests: existing Speak/Stop compatibility, correct PCM/auth, status correlation,
  current-user authentication and room enrollment, zero private-document fallthrough.
- Human pilot: at least 100 held-out wake attempts across at least five speakers and an eight-hour
  negative/cross-talk corpus. Proposed release gate: >=95/100 detections and zero observed false
  dispatches in that negative run. These are sample gates, not a statistical reliability guarantee.
- Measure p50/p95 wake-to-capture and question-end-to-first-audio latency plus idle/active CPU on
  the target host. Set the latency budget from the first real run; publish the results rather than
  promise model/vendor benchmark numbers on unrelated hardware.
- After implementation, run relevant existing bot/Meeting API tests, new speech tests, and affected
  config/contract/architecture/isolation gates. Existing STT fixture results must not regress.

Stop after two-client, one-room, grounded question answering with one common TTS output passes
these checks. Deferred work: barge-in, arbitrary shared/personal agents, new platforms, wake model
training, voice cloning, semantic search replacement, and automatic external actions.

## Source references

- [Sherpa KWS mechanism and supported model families](https://k2-fsa.github.io/sherpa/onnx/kws/index.html).
- [Existing Speak route](../core/meetings/services/meeting-api/src/meeting_api/lifecycle/speak_router.py).
- [Existing TTS playback adapter](../core/meetings/services/bot/src/tts-playback.ts).
- [Knowledge Q&A and ownership](../core/agent/control_plane/meeting_knowledge.py).
- [Gateway-only client](../clients/slim/tina_slim/client.py).
- [Current STT CPU deployment](../deploy/transcription/docker-compose.cpu.yml).
