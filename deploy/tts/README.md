# Optional Vietnamese TTS sidecar (speech phase 1)

The female **Trúc Ly** preset (Northern Vietnamese, natural style) from **VieNeu-TTS v3 Turbo**,
using the ONNX CPU backend. This implements
the bot's existing speech HTTP interface. STT, agent dispatch, transcripts and bot playback
are unchanged. It is an optional separate Compose project, not part of `make all`.

The Piper proposal is replaced because its eSpeak phonemizer/data introduces GPL, contrary
to ADR-0004. VieNeu, sea-g2p and the chosen model/codec cards declare Apache-2.0.
No reference recording, voice cloning or training is enabled.
The SDK also installs transitive MPL/LGPL packages as separate unmodified dependencies;
their scoped records are in the repository's `license-exceptions.json`.

## Build and start (Ubuntu/WSL)

From this checkout's root, with the main `tina-local` stack already running:

```bash
docker build -t tina/tts:dev deploy/tts
mkdir -p "$HOME/.config/tina" "$HOME/.cache/tina/tts"
python3 - <<'PY'
from pathlib import Path
import os, secrets
config = Path.home() / '.config/tina/tts.env'
if not config.exists():
    fd = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        out.write('TTS_API_TOKEN=' + secrets.token_hex(32) + '\n')
        out.write('TINA_TTS_MODELS=' + str(Path.home() / '.cache/tina/tts') + '\n')
        out.write('TINA_MAIN_NETWORK=tina-local_tina\nTINA_TTS_HOST_PORT=18004\n')
PY
docker run --rm --user "$(id -u):$(id -g)" \
  -e HF_HUB_OFFLINE=0 -e HF_HUB_DISABLE_XET=1 \
  -v "$HOME/.cache/tina/tts:/models" tina/tts:dev python install_models.py
docker compose --env-file "$HOME/.config/tina/tts.env" \
  -f deploy/tts/docker-compose.yml up -d --no-build --wait
curl --fail http://127.0.0.1:18004/health
```

Existing private config is retained. Model/codec files (~566 MB) are downloaded at the revisions
in `model-assets.json`, verified against upstream SHA-256 for LFS objects and Git blob hashes for
small files, and mounted read-only. The installer retains upstream cards. Startup verifies the
same files and cache references; inference uses `HF_HUB_OFFLINE=1`, no remote model code, and
disables ONNX telemetry. Weights stay outside the image and source tree. Dependencies are
hash-locked in `requirements.txt`; regenerate using the command in that file's header.

## Connect the bot

In the main stack's **private** env file (for example `~/.config/tina/.env`), configure:

```dotenv
TTS_SERVICE_URL=http://tts:8000
TTS_API_TOKEN=<same private token as tts.env>
```

Do not put the token in command arguments, Git or browser settings. Preserve the existing
Compose override chain/project. Recreate only Meeting API using its existing image:

```bash
ENV_FILE="$HOME/.config/tina/.env" python3 - <<'PY'
import sys
sys.path.insert(0, 'deploy/compose/bin')
from stack import Stack
stack = Stack('doctor')
stack.preflight()
stack.compose('up', '-d', '--no-deps', '--no-build', '--pull', 'never',
              '--wait', '--wait-timeout', '120', 'meeting-api')
PY
```

Spawn a **new** browser bot with `voice_agent_enabled: true`. Existing bot environments do
not change when Meeting API restarts. The owner-scoped Gateway endpoints already exist:

- `POST /bots/{platform}/{native_meeting_id}/speak`, body `{"text":"Xin chào","voice":"auto"}`.
- `DELETE /bots/{platform}/{native_meeting_id}/speak` to stop.

Only an admitted active bot owned by the authenticated caller can speak. Hold its API key
in a private file/environment, not a URL. `accepted` means command publication, not audible
playback. Discord speaking remains unsupported.

## Protocol and lifecycle

- `POST /v1/audio/speech`, `X-API-Key`, `Content-Type: application/json`.
- Body: `{"model":"tts-1","input":"Xin chào","voice":"auto","response_format":"pcm"}`.
- Output: **headerless little-endian PCM16, mono, 24,000 Hz**, resampled from the model's 48 kHz.
- Only preset `auto` and PCM are supported; unsupported choices return 422.
- `auto` selects Trúc Ly explicitly. Standalone `TINA`/`Tina`/`tina` is spoken as "ti na"
  to prevent acronym spelling; agent/transcript text and other acronyms remain unchanged.
- Limits: 4,000 input characters, 20,000 request bytes, 120 seconds synthesized audio.
- GET `/health` and `/status` expose content-free readiness/format information.
- One native synthesis at a time; a competing request gets 503, with no unbounded queue.
- No CORS, text storage or input/credential logging. Published port is loopback-only; bots use
  the authenticated service on the existing Docker network.
- The response follows synthesis; this is not token/audio streaming. Native inference is not
  preemptible: Stop cancels bot playback/request immediately, but native CPU work may finish
  in the sidecar while its single-flight lock remains held.

## Verification and rollback

```bash
docker run --rm --network none -v "$PWD/deploy/tts:/tests:ro" tina/tts:dev \
  python -m unittest discover -s /tests -p test_server.py
docker compose --env-file "$HOME/.config/tina/tts.env" -f deploy/tts/docker-compose.yml \
  exec -T tts python - --output /tmp/tts-smoke.wav < deploy/tts/smoke.py
```

The smoke checks real synthesis, PCM framing, sample rate and non-silence. Listen to its WAV,
then verify audible speech and Stop from a second participant in a controlled meeting.
HTTP success and a virtual microphone test are not substitutes for the meeting check.

`playback-smoke.mjs` can run as `BOT_WORKER_ENTRY` inside an isolated, existing browser-bot
image. It calls the shipped `tts-playback.js`, captures the real PulseAudio virtual microphone,
and verifies Stop during playback, without joining a meeting. It writes
`/tmp/tts-virtual-mic.wav` and `/tmp/tts-playback-proof.json`. This is a substrate proof only;
it does not assert Google Meet admission, microphone UI state or remote audibility.

Stop this optional service with the same `docker compose ... stop tts`. To roll back, restore
the previous two TTS values in the private main env, recreate Meeting API and replace any
test bot spawned with voice enabled. Preserve all model and main-stack volumes.
