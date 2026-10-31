# Local post-meeting speaker analysis

This optional worker runs Sherpa-ONNX 1.13.8 on CPU with Pyannote segmentation 3.0
and a 3D-Speaker ERes2Net embedding model. It does not replace Qwen/FunASR or the live ASR path.
Sherpa performs overlapping sliding-window segmentation (`window_shift_ratio=0.1`) followed
by clustering over the submitted recording. This release is offline, not live diarization.

## Install and start

From the repository root:

```sh
python3 -m venv .venv/diarization
.venv/diarization/bin/pip install -r deploy/transcription/diarization/requirements.txt
```

Download the upstream models outside Git:

- [Segmentation archive](https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2): extract `model.onnx` as `segmentation.onnx`.
- [Embedding model](https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx): save as `embedding.onnx`.

Keep upstream model notices alongside the weights. The runtime is Apache-2.0; the segmentation
archive includes its model license. 3D-Speaker source uses Apache-2.0; review the upstream model
release terms before redistributing weights. No weights are included in this repository.

Create `~/.config/tina/diarization.env` (permissions 0600) with an absolute model directory and
a randomly generated private token:

```sh
TINA_DIARIZATION_MODELS=/absolute/path/to/models
TINA_DIARIZATION_TOKEN=YOUR_RANDOM_WORKER_TOKEN
```

Start manually after a reboot:

```sh
deploy/transcription/diarization/start.sh
```

The script binds only `127.0.0.1:18014` and uses one worker. Models load for a request and are
released afterward. CPU inference uses two threads. Health: `GET /health`.
`POST /diarize` requires `Authorization: Bearer <token>`, a mono 16 kHz PCM16 WAV `file`, and
optional `num_speakers` (`-1` automatic, otherwise 1–20). No browser CORS is enabled.

Add to the Compose environment, using the same token, then recreate Meeting API:

```sh
DIARIZATION_SERVICE_URL=http://host.docker.internal:18014
DIARIZATION_SERVICE_TOKEN=YOUR_RANDOM_WORKER_TOKEN
```

`host.docker.internal` is the internal Docker-to-host route; host service bindings remain loopback.

## Use

Open a completed bot meeting in Terminal or Dashboard → **Speaker identities** →
**Analyze recording speakers** → inspect the counts → **Apply speaker groups**.
You may specify the number of voices when known; automatic counting is provisional.
Voice groups are anonymous: select a group and confirm a name yourself.

Owner-only API:

- `GET /transcripts/by-id/{meeting_id}/diarization`
- `POST /transcripts/by-id/{meeting_id}/diarization/start` with `{"num_speakers": -1}`
- `POST /transcripts/by-id/{meeting_id}/diarization/cancel`
- `POST /transcripts/by-id/{meeting_id}/diarization/apply` with `{"job_id": "..."}`

Analysis and Apply are separate. Results persist privately in `meeting.data.transcript_diarization`.
Apply uses the meeting row lock and existing speaker revision outbox; repeated Apply is idempotent.
It verifies audio hashes again, keeps raw text/audio/timestamps unchanged, and never replaces
Meet participant identities or explicit manual assignments (including manual unknown).
Artifact deletion removes the analysis and refuses late worker writes.

All clocked recording sessions are joined, with 0.5 seconds of silence between them, for one
clustering pass; original offsets map back to their own recording. A segment is assigned only if
one voice exclusively covers at least 75% and 0.5 seconds, and a second voice covers at most 15%.
Other segments remain unknown; text is not split at speaker boundaries without forced alignment.
No embeddings or voiceprints persist in the registry. Speaker IDs are meeting-local and remain
stable when rerunning the same audio/model/count configuration; changed analysis may create new IDs.
Confirmed identities always take priority.

## Limits and calibration

- One API process/one worker; use one Meeting API replica with this local configuration.
- Up to 2000 transcript segments, 10 recordings, 256 MiB per source, and 30 minutes of decoded
  audio total (including inserted silence). Older/unclocked/ambiguous recording spans are not guessed.
- No automatic job at meeting end. New analysis/refinement waits while a meeting is live; an already
  running inference is not preempted. Cancel discards the result after the current inference returns.
- In-flight jobs become `interrupted` after API restart; start them again. No automatic recovery queue.
- The clustering threshold is 0.7, chosen from a small AMI pilot. It still overclusters; this is not
  a production Vietnamese diarization benchmark. Speaker count selection is also not proof of correctness.
- Desktop-native/extension SQLite audio now uses a separate owner-scoped Desktop adapter described below; it does not pass through the bot-recording API or change capture authority.
- Forced alignment, acoustic-to-real-name identity inference, and live rolling diarization are separate work.

Upstream implementation reference: [Sherpa Python example](https://github.com/k2-fsa/sherpa-onnx/blob/master/python-api-examples/offline-speaker-diarization.py).

## Desktop speaker mapping

Desktop Saved transcripts → Transcript review → **Speaker identities** reuses this
worker for the archived system mix (channel 999). Choose **Analyze system-audio
speakers**, inspect the anonymous groups, then **Apply speaker groups** and confirm
names. Microphone 1000 has one stable local identity per meeting; raw-AEC sidecar
1002 never creates a speaker or memory evidence. Verified Meet participant IDs bind
to separate identities even when two people use the same display name.

`desktop-local.mjs` reads the worker token from the existing private
`~/.config/tina/diarization.env` and uses loopback port 18014. Alternatively configure
`DIARIZATION_SERVICE_URL` and `DIARIZATION_SERVICE_TOKEN` on Desktop. Tokens remain
server-side. Without a worker, manual identity confirmation/assignment still works.

The adapter joins up to 256 verified contiguous sample ranges with 0.5-second
silence between them, with a 30-minute total limit. Missing/legacy clocks and a
segment spanning a source gap are not guessed. Results verify the WAV hash,
duration, model and bounded turns. Apply rechecks source audio, text revisions and
the registry revision; local identities, trusted participant metadata and manual
assignments (including manual unknown) take priority. Changed audio/model/count or
turn topology creates new anonymous IDs. Speaker edits never rewrite raw ASR,
accepted text, timestamps or PCM.

Desktop APIs under `/transcripts/{platform}/{native}`:

- `GET /speakers`, `PATCH /speakers/{speaker_id}` with `expected_revision` and `name` (null means unknown).
- `POST /speakers/assign` with registry `expected_revision`, `segment_id`, `speaker_id` (or null).
- `GET /diarization`, `POST /diarization/start|cancel|apply` using the same options/job-id pattern above.
- `GET /canonical` and `GET /memory` expose speaker-aware accepted transcript and exact-quote extraction candidates.

Speaker changes use the existing metadata-only `speaker-revision.v1` outbox.
Caption snapshots are republished without replacing drafts, and reconnecting
subscribers receive the current names. Canonical audio uses `capture-span`; words
remain `segment_fallback` until a separate forced-alignment job supplies evidence.
