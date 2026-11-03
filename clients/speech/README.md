# Local wake-word pilot (speech phase 2)

This optional host client detects **Hey TINA** with Sherpa-ONNX on CPU. It emits local JSON
diagnostics only. It does not contact STT, the agent, Gateway or a meeting, play audio, or save
microphone recordings. TINA's shared TTS default remains **Trúc Ly**, speaking TINA as "ti na".

Run on each participant's actual host, not in the meeting bot or a Docker container. Windows,
Linux and macOS use PortAudio through sounddevice. Windows wheels include PortAudio; Linux
needs `libportaudio2` (for example `sudo apt install libportaudio2`), and macOS may need
`brew install portaudio`. Microphone permission is granted through the host OS.

## Install and download once

From the repository root, with [uv](https://docs.astral.sh/uv/) installed:

```sh
uv sync --project clients/speech --python 3.11 --locked
uv run --project clients/speech tina-speech setup
uv run --project clients/speech tina-speech devices
```

`setup` is the only network/download operation. It fetches the upstream English GigaSpeech
3.3M KWS archive (~17.6 MB), verifies its pinned SHA-256 and size, and installs only the INT8
encoder/decoder/joiner, tokenizer, token table and original model card (~5.5 MB).
[`model-assets.json`](tina_speech/model-assets.json) pins archive and file hashes. The archive
hash is recorded from the HTTPS download, not represented as an upstream signed checksum.
SentencePiece encodes `HEY TINA` using that exact model's BPE as:

```text
▁HE Y ▁T IN A @HEY_TINA
```

The default model cache is `%LOCALAPPDATA%/tina/speech/<model>` on Windows and
`${XDG_CACHE_HOME:-~/.cache}/tina/speech/<model>` elsewhere. `setup`, `listen` and `file`
each accept `--model-dir PATH`. Detection verifies all pinned files and the keyword file
offline and fails if they are missing/modified; it never silently downloads a model.

## Start and stop on your machine

Pick an **input** index from `devices`; indices are machine-specific. For example, on the
development Windows machine index 1 is the EDIFIER X5 Pro headset under MME:

```sh
uv run --project clients/speech tina-speech listen --device 1 --seconds 20
```

Speak "Hey TINA", pause at least three seconds, then try again. A `wake` JSON line means
local detection, not a meeting action. `--seconds 0` (the default) listens until **Ctrl+C**.
Closing/stopping releases the input stream and clears the detector's audio buffer. There is
no background service, auto-start, credential or enrollment requirement in this phase.

Input must support **16 kHz mono float32**. PortAudio requests that format once; the client
does not repeatedly resample blocks. If the selected host API rejects it, choose another
input/API from `devices` (MME/DirectSound/WASAPI on Windows). There is no silent device switch
or system-audio/loopback fallback.

## Replay the synthetic pilot

On Windows, create an English synthetic fixture with the installed Microsoft Zira Desktop
SAPI voice. This fixture generator does not select or change the shared TTS voice:

```powershell
powershell -NoProfile -File clients/speech/make-fixtures.ps1
uv run --project clients/speech tina-speech file output/speech-stage2/fixtures/hey-tina.wav
uv run --project clients/speech tina-speech file output/speech-stage2/fixtures/negative.wav
```

The positive fixture has three calls separated by silence; the negative has near-match
names and ordinary conversation. Expected counts in the initial synthetic smoke: **3 / 0**.
The separate Trúc Ly Vietnamese synthetic wake fixture was missed **0/3**; the English KWS
baseline is provisional until real/accented speech is tested. The ordinary Trúc Ly reply
without "Hey" caused zero triggers. Neither result proves general resistance to TTS feedback.
Other platforms can replay those same WAVs. Bring your own fixtures as uncompressed mono
PCM16 WAV at 16 kHz; unsupported formats fail explicitly. If conversion is needed, convert
once before replay, for example `ffmpeg -i input.wav -ar 16000 -ac 1 -c:a pcm_s16le output.wav`.
WAV replay adds 0.4 seconds of zero lookahead at EOF, identified in the summary.

The summary reports processing wall/CPU time separately. `cpu_percent` is process CPU/wall
time while decoding; fast offline replay may use one full core. `cpu_realtime_percent`
divides process CPU by audio duration, an offline estimate rather than a live microphone
measurement. Neither includes model-loading time. Wake timestamps mark detection, not the
exact spoken keyword's end; these are not measured human wake-latency percentiles.

## Bounds and behavior

- The audio callback only copies/enqueues up to 20 ms; inference runs outside it. The queue
  holds at most one second. Input overflow or a full queue stops/disarms capture explicitly.
- A rolling RAM buffer holds at most two seconds. A wake retains a bounded copy including
  audio up to the detection boundary, so a later turn controller can preserve an immediately
  following question. This phase does not cut a question at the detection timestamp, trim a
  text prefix, or implement question endpointing/upload.
- One event per utterance: re-arm needs both 1.5 seconds since the last wake and 0.8 seconds
  continuous quiet (RMS <0.01). The energy gate only controls re-arming, not wake recognition.
- Every input has independent native and cooldown state. Diagnostics contain only the fixed
  keyword and sample counters; they omit audio, recognized free text and credentials.
- Local diagnostics are not a published core event/API contract. The later authorized room
  coordinator, VAD question capture, playback status and shared TTS suppression are phase 3+.
  Do not point this pilot at loudspeakers expecting it to arbitrate a meeting.

## Tests and remaining acceptance

```sh
uv run --directory clients/speech pytest -q
```

The existing Python gate discovers this package/tests; no new CI job is required. Tests cover
no-wake behavior, per-utterance gating, state isolation, Stop cleanup, bounded buffers/queue,
offline replay and tampered models. The synthetic smoke exercises the real native KWS model.

Human/accented speech, noisy rooms, real-time microphone CPU/latency, held-out misses and
long negative corpora remain to be measured. Synthetic detections are a functional proof,
not a release-level accuracy or false-activation claim. In particular "TINA ơi" is not a
supported synonym for the English wake phrase.

To remove the pilot, stop it with Ctrl+C and delete its local environment/model cache if
desired. No main-stack services, schemas, capture paths or model-provider settings change.
