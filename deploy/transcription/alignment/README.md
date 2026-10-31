# Optional Vietnamese forced alignment

## Desktop

Desktop also uses this worker through **Saved transcripts → Transcript review →
Align words**. Its input is the current accepted verbatim text, explicitly marked
`text_kind: accepted`, and verified saved capture PCM16. Bot alignment below keeps
its existing raw-ASR policy. Neither path rewrites transcript text or source audio.

The local launcher reads `TINA_ALIGNMENT_TOKEN` from the private
`~/.config/tina/alignment.env`; alternatively configure `ALIGNMENT_SERVICE_URL` and
`ALIGNMENT_SERVICE_TOKEN`. Credentials stay in the Desktop process. Default local
worker port is 18015. Desktop serializes alignment with refinement and diarization,
and yields between batches when live capture starts.

Each selected finalized segment needs one continuous sample-clocked source,
no overlapping capture sessions or gaps, and at most 30 seconds of audio. Raw mic
1002 and drafts are excluded. A job permits up to 2,000 segments / 20,000 tokens,
in batches of at most 20 clips. Invalid or missing sources are omitted; unsuccessful
segments retain segment fallback. Cancellation prevents further publication and
remaining batches; the shared worker may finish its current MFA invocation.

Results publish derived timing automatically after per-segment revision, text
hash, audio hash and capture-reference checks. Text edits and Restore invalidate
accepted timing in the same SQLite transaction; a late result cannot restore it.
Rename/assignment reprojects word identities without rerunning MFA. Word overlap
uses conservative applied-diarization attribution; unsupported identities remain
unknown. Unaligned/OOV words stay plain text. Every clickable word goes through an
owner/origin-checked audio endpoint that revalidates job, revision and WAV hash.

Desktop endpoints under `/transcripts/{platform}/{native}`:

- `GET /alignment`, `POST /alignment/start`, `POST /alignment/cancel` (empty JSON object).
- `GET /canonical` includes source-absolute word/phrase times and alignment provenance.
- `GET /segments/{id}/aligned-audio?job_id=...&expected_revision=...&word_index=...` returns verified word PCM16 only.

SQLite `alignment_jobs` and `alignment_results` remain local authority state.
`transcript_sequences` makes metadata notifications monotonic independently from
text-history revisions. Memory keeps exact accepted quotes and the current
canonical revision; alignment does not infer facts or assignees.

## Meeting API

This owner-triggered worker runs Montreal Forced Aligner (MFA) against saved bot-recording
segments. It returns the original whitespace tokens with segment-local times and audio/text hashes.
Words that MFA maps to an unknown phone (`spn`), or cannot map one-to-one, stay unaligned and are
not clickable. It never rewrites ASR text or audio. Meeting API joins aligned words to already
applied diarization turns; ambiguous and overlapping words remain unknown.
Renaming a voice changes its identity label without overriding word-level attribution. Voices
present only inside mixed segments are retained in the registry; opening the registry repairs
missing voice entries from previously applied speaker-analysis jobs.

The worker accepts one mono 16 kHz PCM16 WAV segment of at most 30 seconds. It is single-process
and loopback-only at `127.0.0.1:18015`; the Meeting API calls it through Docker's
`host.docker.internal` route. It requires the owner-supplied worker token on every request.

## Install

Install MFA in a dedicated Conda environment and download the Vietnamese acoustic and dictionary
models into a private data directory (keep both outside Git):

```sh
mamba create -y -p "$HOME/.local/share/tina/mfa" -c conda-forge -c bioconda python=3.11 montreal-forced-aligner=3.3.4
MFA_ROOT_DIR="$HOME/.local/share/tina/mfa-data" conda run --no-capture-output --prefix "$HOME/.local/share/tina/mfa" mfa model download acoustic vietnamese_mfa --version 3.0.0
MFA_ROOT_DIR="$HOME/.local/share/tina/mfa-data" conda run --no-capture-output --prefix "$HOME/.local/share/tina/mfa" mfa model download dictionary vietnamese_mfa --version 3.0.0
python3 -m venv .venv/alignment
.venv/alignment/bin/pip install -r deploy/transcription/alignment/requirements.txt
```

Create `~/.config/tina/alignment.env` with mode `0600`. Use absolute local paths and a random
worker token; copy the same token into `ALIGNMENT_SERVICE_TOKEN` in the Compose environment:

```sh
MFA_CONDA_PREFIX=/Users/you/.local/share/tina/mfa
MFA_CONDA_EXE=/Users/you/miniforge3/bin/conda
MFA_ROOT_DIR=/Users/you/.local/share/tina/mfa-data
MFA_DICTIONARY=/Users/you/.local/share/tina/mfa-data/pretrained_models/dictionary/vietnamese_mfa.dict
MFA_ACOUSTIC_MODEL=/Users/you/.local/share/tina/mfa-data/pretrained_models/acoustic/vietnamese_mfa.zip
MFA_VERSION=3.3.4
MFA_MODEL_VERSION=vietnamese_mfa-3.0.0
TINA_ALIGNMENT_TOKEN=replace-with-a-random-local-secret
```

The API submits up to 20 segments per MFA invocation (at most 10 minutes of source audio) to avoid
reinitializing the aligner for every sentence. Each segment remains independently hashed and
revision-bound.
The worker terminates the entire Conda/MFA process group on timeout before removing its scratch
files. A job with no successful segments is reported as failed; partial results include an error
message identifying how many segments need a retry.

Start with `deploy/transcription/alignment/start.sh`, set
`ALIGNMENT_SERVICE_URL=http://host.docker.internal:18015` for Meeting API, then recreate only
Meeting API after confirming no bot is active. Health is `GET /health`.

## Use

After a meeting ends, open **Review transcript** in Terminal or Dashboard and choose **Align words**.
The job is owner-only, serialized with refinement and speaker analysis, and uses the immutable raw
ASR transcript plus the exact saved audio span. Alignment results and provenance live in the
meeting JSONB carrier and use the transcript revision outbox to refresh both clients. The existing
`transcript-document.v1` and raw transcript remain unchanged.

The MFA Vietnamese model and dictionary are CC BY 4.0. They do not provide a verified English
pronunciation model: code-switched English tokens with `spn` are retained as plain text but have no
timestamp. ViMedCSS supplies utterance-level, not word-level, timing labels, so its pilot checks
coverage, monotonicity, OOV behavior and runtime; exact Vietnamese word-boundary error needs a
human-annotated subset. AMI is used separately for the multi-speaker baseline and does not validate
Vietnamese alignment.
