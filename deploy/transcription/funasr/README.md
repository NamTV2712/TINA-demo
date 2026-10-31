# FunASR backend for TINA

This local backend exposes FunASR's OpenAI-compatible
`POST /v1/audio/transcriptions` API to TINA Desktop, Terminal, and meeting bots. It binds to
`127.0.0.1` because the packaged FunASR server does not authenticate requests. The repo wrapper loads
Qwen3-ASR with FSMN-VAD through FunASR's `AutoModel` API. Both load on the configured device;
check startup logs for accelerator fallback before relying on GPU execution.

## ASR status

`GET /status` implements `core/meetings/contracts/asr-status.v1`. It reports the requested
checkpoint, actual resolved device, active/waiting requests, errors and p50/p95 over the latest
100 transcription requests. Status reads do not run inference. Queue/model/service durations use
a monotonic clock; capture-to-submit is a client estimate and audio window size is not latency.
Missing measurements are `null`. Counters reset when this service restarts.

In Terminal, an administrator opens **Settings → ASR status**. The authenticated server resolves
the selected backend and proxies diagnostics; endpoint tokens stay server-side. Meeting-bot and
updated Desktop clients add a source and capture-window lag. Terminal dictation also records its
response-to-next-frame time locally; the meeting view measures render-to-next-frame time locally.
HTTP measurements are stored immediately. Frame measurements require a focused, visible page and
include browser/compositor scheduling; they are not isolated React CPU time.
Browser samples reset on reload. Hardware capture and relay/network latency are not separately
instrumented, and stage percentiles must not be added to claim an end-to-end percentile.

Each transcription response includes `X-ASR-Request-ID` and `Server-Timing` headers. Structured
`asr_request` logs and diagnostics contain only allowlisted IDs, status codes and timings; never
audio, recognized text, names, or credentials.

The default checkpoint is `Qwen/Qwen3-ASR-0.6B`: it supports Vietnamese and is small enough to test
on this Apple Silicon host. FunASR's faster SenseVoice and Paraformer aliases do not cover
Vietnamese in their documented language sets.

Official references:

- https://github.com/modelscope/FunASR/blob/main/examples/openai_api/OPENAPI.md
- https://github.com/modelscope/FunASR/blob/main/funasr/bin/server.py
- https://github.com/modelscope/FunASR/blob/main/funasr/models/qwen3_asr/model.py
- https://github.com/modelscope/FunASR/blob/main/docs/tutorial/README.md
- https://github.com/modelscope/FunASR/blob/main/examples/batch_asr_improved.py

## Install

From the TINA repository root:

```bash
uv venv .venv/funasr --python 3.11
uv pip install --python .venv/funasr/bin/python \
  'funasr==1.4.15' 'qwen-asr==0.0.6' 'transformers==4.57.6' \
  accelerate fastapi 'uvicorn[standard]' python-multipart torch torchaudio
```

The environment is ignored by Git. The first start downloads the selected checkpoint into the
Hugging Face model cache. Later starts reuse the verified local snapshot.

## Start

```bash
deploy/transcription/funasr/start.sh
curl http://127.0.0.1:18000/health
```

Optional variables: `FUNASR_PORT`, `FUNASR_DEVICE`, `FUNASR_MODEL`, and `FUNASR_HUB`.

## FSMN-VAD

The server loads `fsmn-vad` from ModelScope and Qwen3-ASR from the configured hub. VAD segments
speech before recognition and removes silence from each request. It is not a translation model and
does not guarantee that mixed English/Vietnamese words will be recognized correctly. It adds a
separate model to memory; monitor startup and inference latency on the target Mac.

Each request asks FunASR for VAD sentence timestamps, which are returned as segment offsets in
`verbose_json`. The OpenAI-compatible `prompt` field passes the most recent 800 characters to
Qwen's `context`; language hints remain optional. This does not add word-level alignment.
The adapter normalizes `vi` and `en` to Qwen's canonical `Vietnamese` and `English` names.
Recovery can submit sub-frame fragments (for example 243 samples / 15.1875 ms). The adapter
zero-pads only temporary inference inputs shorter than 200 ms so FSMN has analysis frames;
the captured samples are unchanged. Response duration, sentence bounds and `audio_ms` stay
within the original source duration. Empty input is rejected and model errors still return 502.
An empty VAD result completes a decode attempt; it does not prove all spoken words were recognized.
Desktop's optional `vi-en` policy lives in the shared transcription client: the first pass is automatic;
unexpected language/script is held separately with source audio and one forced-language suggestion.
The policy is never forwarded as a model language name. Review suggestions are not canonical evidence.

Inference is serialized to protect FunASR's mutable model state. At most four requests may be
running or waiting; additional requests receive HTTP 429. A waiting request is discarded when
its client disconnects or after ten seconds (HTTP 503). Inference already executing cannot be
interrupted safely; its model lock remains held until that call finishes.

## Connect TINA Desktop

Build Desktop, stop its existing local process after any active capture finishes, then start it with:

```bash
TRANSCRIPTION_SERVICE_URL=http://127.0.0.1:18000 \
TRANSCRIPTION_MODEL=custom \
TINA_RECORDINGS_DIR="$HOME/Library/Application Support/TINA/recordings" \
pnpm --dir core/meetings/services/desktop start
```

`custom` is the model alias exposed by this wrapper; the checkpoint path belongs in `FUNASR_MODEL`.

Keep the extension on `ws://127.0.0.1:9099/ingest` and `http://127.0.0.1:8056`.

This profile connects the native Desktop capture host. For the Docker Terminal and meeting-bot
stack, set the admin's Global defaults → Transcription URL to
`http://host.docker.internal:18000` and select FunASR. Docker Desktop routes that internal hostname
to the Mac's loopback listener; the FunASR process remains bound to `127.0.0.1` and no host port is
published. The model alias sent to FunASR is `custom`.

Desktop transcripts and delivered source PCM are persisted to `transcripts.sqlite` in `TINA_RECORDINGS_DIR`. Existing durable rows are restored automatically; legacy exported `/bots` snapshots can bootstrap the first startup.

## Capture smoke check

After building Desktop, supply a synthetic Vietnamese WAV (16 kHz mono PCM16, at least 2 seconds):

```bash
pnpm --filter '@tina/desktop...' build
node deploy/transcription/funasr/smoke.mjs /path/to/synthetic-vi.wav
```

The check starts Desktop on temporary loopback ports, replays `capture.v1`, and asserts that
FunASR returns a completed transcript with the source speaker attached. It prints the sample
transcript and does not touch the running Desktop host or real meeting data.

Model-free adapter/queue regression checks (using the environment's installed HTTPX):

```bash
.venv/funasr/bin/python -m unittest discover -s deploy/transcription/funasr -p 'test_*.py'
```

## Limits

This uses HTTP audio windows through TINA's existing pipeline, not token streaming. The model
does not supply word timestamps in this configuration; segment offsets follow VAD speech regions.
Terminal dictation confirms whole windows of at most 25 seconds when word offsets are unavailable,
and retains audio captured while a request is in flight. Test real meetings before relying on
subtitle timing or multi-speaker performance.
The processes must be started again after a reboot.

## Phase 1 live profile

Use platform default `funasr` with `funasr_url=http://host.docker.internal:18000` for Docker clients; native Desktop translates that hostname to `127.0.0.1`. Keep `FUNASR_DEVICE=mps` on Apple Silicon and only one resident ASR backend. The selected endpoint is pinned until capture stops; start a new session after changing settings. Explicit personal backend overrides still take precedence.

The existing per-channel scheduler retains at least 2 seconds of audio and one in-flight request per speaker (Desktop: 1.5 seconds between checks; shared default: 2 seconds). A 1-second candidate reduced first-text latency but worsened Vietnamese WER in the regression replay, so it was not retained. Browser microphone, participant and mixed-tab capture use a conservative RMS `0.0001` floor; mixed ASR windows use the same floor. These gates reject near-zero residue, not background noise. These scheduler/energy defaults are separate from stable endpointing below. Rebuild/reload the extension and rebuild the bot image after changing browser capture modules.

## Stable endpointing

The OpenAI-compatible form field `min_silence_duration_ms` is forwarded to FSMN-VAD's runtime
`max_end_silence_time` (100–2000 ms; default **800 ms**). Previously the adapter ignored this client
control and VAD used its implicit dynamic ending policy. The explicit threshold gives stable
utterance splits; 300/500 ms trials were rejected because the small human-speech control worsened. Sentence timestamps still come from VAD; words
without alignment do not acquire invented timestamps. The request queue and model weights are unchanged.

The mixed lane also avoids provisional closes at voiced live edges using its shared conservative
silence-cut helper. A continuous utterance can wait longer for a final while pending captions continue;
the existing hard cap remains. Validate quiet/noisy speech and natural code switching separately.
