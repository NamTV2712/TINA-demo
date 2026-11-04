# Phase 3: one authorized participant, one shared speech output

This opt-in pilot reuses existing STT and grounded meeting Knowledge APIs. TTS remains Trúc Ly.
`listen`/`file` still perform local-only wake detection. Only `run`/`run-file` dispatch a voice turn.

## Prepare the server

Build/deploy the changed Meeting API, Gateway and browser-bot image from this checkout before
using correlated speech. A newly spawned, admitted, voice-enabled bot is required. Old images
cannot acknowledge speech.v1 commands. Preserve the existing Compose project/override chain.

Copy `room.example.json` to a private file outside Git. Replace all example IDs with actual
operator-owned meeting/user IDs; native meeting URL alone grants no TINA permissions. The
coordinator is locked to that meeting and explicitly approved linked Markdown documents.
The operator's identity must own the active meeting; enrolled participants use their own keys.
For synthetic validation, use a separate test meeting and the fixtures below, never overwrite
real notes or fabricate production bot admission.

Set these secrets in the coordinator process environment from your private configuration:

- `TINA_SPEECH_OPERATOR_KEY`: operator API key, with bot/tx/browser and required agent access.
- `TINA_SPEECH_STT_KEY`: token for the configured self-hosted transcription endpoint.

```powershell
uv sync --project clients/speech --python 3.11 --locked
uv run --project clients/speech tina-speech setup
uv run --project clients/speech tina-speech serve --config C:\private\tina-speech-room.json
```

The server binds loopback port 18005. Startup verifies operator identity, active voice bot and
linked approved Wiki paths. It does not silently enroll users or discover unrelated documents.
No default stack service, user table or agent prompt/retrieval pipeline is replaced.

## Run a participant

In a separate host process, set **only your own** `TINA_SPEECH_USER_KEY`. Shared operator/STT/TTS
keys never go to participants. `TINA_SPEECH_COORDINATOR_URL` defaults to
`http://127.0.0.1:18005`; non-loopback connections require HTTPS. Multi-machine hosting/TLS and
room-wide suppression/arbitration remain later work.

```powershell
uv run --project clients/speech tina-speech devices
uv run --project clients/speech tina-speech run --device 1
```

Speak "Hey TINA" followed by a question, without a long pause. Ctrl+C closes the microphone
and cancels the turn. Question capture is limited to 20 seconds after wake, with a five-second
no-question deadline and Silero VAD silence endpointing. The callback remains nonblocking.

Audio sent to STT includes up to two seconds of pre-roll, preserving an immediately following
question and the wake phrase; it can include brief preceding microphone context. The coordinator
requires ASR to **begin** with the wake phrase before removing that anchored prefix. Earlier
conversation or an empty/unrecognized wake/question fails closed instead of being trimmed into
a different question. The pinned KWS Python result omits the absolute offset after native silence
resets, so relative token timestamps are not used as a precise acoustic crop.

State: ARMED -> CAPTURING -> WAITING -> SPEAKING -> ARMED. Wake dispatch stays disabled throughout
capture/wait/playback. Only validated `claims[].text` with approved current sources is spoken;
empty claims get one fixed insufficient-information reply. Errors never speak raw JSON, tool
output or a personal-chat fallback. No Wiki Apply/document editing action is called.

## Correlation, cancellation and recovery

The core-owned [speech.v1](../../core/meetings/contracts/speech.v1/README.md) protocol adds tracked
commands and actual bot playback receipts. Legacy Speak/Stop remains supported. A successful
Speak HTTP response only means acceptance; paplay exit/PCM/microphone cleanup determine the
terminal receipt. This still does not prove remote-participant audibility.

One room turn is active at a time. Request IDs are stable over retries, changed audio is rejected,
and duplicate Speak is not republished within receipt retention. Stop creates a tombstone to
block late matching Speak. Cancelling STT/LLM discards late results. If playback is ambiguous,
ERROR keeps the room reserved and the client disarmed; do not automatically retry or re-arm.
Retry explicit Stop. If receipts have expired or services cannot recover, the operator must stop
the bot, confirm it has left, then restart/reconfigure the coordinator with a new active bot.
The single-process pilot has volatile state; restart does not resume/replay turns.

## Synthetic fixtures and focused checks

`fixtures/` contains clearly labeled fake source material. It does not itself insert anything
into a live TINA workspace/meeting. The operator must explicitly link the test Wiki into the
test meeting before a live end-to-end run.

```powershell
powershell -NoProfile -File clients/speech/make-fixtures.ps1
uv run --project clients/speech tina-speech run-file output/speech-stage2/fixtures/question.wav
uv run --directory clients/speech pytest -q
```

`run-file` uses the same KWS/VAD/turn controller with paced synthetic WAV input, and does not
open a microphone. It needs the configured participant key and coordinator. Deterministic unit
tests fake upstream HTTP; they do not establish real LLM, Meet admission or remote audibility.
Keep those integration checks separate from unit-test counts and human wake-word accuracy.
