# Voice answer regression

30 synthetic questions cover meeting owners/deadlines, corrected decisions, proposals, negation,
amounts, document retrieval, unanswerable questions, public definitions and explicit web queries.
These are regression fixtures, not recordings or a Vietnamese meeting benchmark.

From `core/agent`, run with its Python environment and `PYTHONPATH=.`:

```sh
python eval/voice/run.py --output /tmp/tina-voice-routing.json
python eval/voice/run.py --live --output /tmp/tina-voice-live.json
```

The first command checks routing without a provider call. `--live` uses the configured completion
provider and may incur its normal charges. Supply credentials through the normal environment,
never command arguments. It runs the real voice control-plane and worker over temporary synthetic
meeting/documents; it does not access a real meeting or modify a workspace. Output includes per-case
reason, lookup counts, public citations and duration. Expected term checks are only a smoke signal;
human review is required for paraphrases, semantic correctness and whether a clarification helps.
Web availability is reported separately and must not inflate meeting-answer accuracy.

Conversational cases 31–36 cover concise answers, short heard-history follow-ups, a corrected
premise and a partially answerable request. The runner reconstructs history source fingerprints
from the synthetic fixture instead of treating prior assistant text as evidence. Use `--cases`
to select cases and `--label` to identify a run. For a controlled before/after comparison, save the
previous VOICE_SYSTEM prompt to a private text file and pass `--prompt-file` for the baseline:

```sh
python eval/voice/run.py --live --cases 31,32,33,34,35,36 --label baseline --prompt-file /tmp/voice-baseline.txt --output /tmp/voice-baseline.json
python eval/voice/run.py --live --cases 31,32,33,34,35,36 --label candidate --output /tmp/voice-candidate.json
```

Use the same provider, model and source fixtures for both runs. The prompt override changes voice
generation and its repair wording; reviewer rules and source permissions stay fixed. Per-case output
includes verification codes, source count, total answer-service time and empty human-rating fields.
Rate naturalness and factual correctness separately from 1 (poor) to 5 (good). Listen for a direct
answer, ordinary phrasing, no repeated acknowledgment, a concise follow-up and accurate names,
numbers and uncertainty. Leave ratings blank until a person reviews them. A term match or approved
verifier result is not a naturalness score. Timing excludes live ASR, microphone playback and user
perception. This runner does not synthesize audio or measure speech-end-to-first-audio latency;
those require the existing bot timing events and a separate listening trial.

Cases 34 (owner known, phone unknown) and 36 (approval versus testing) also exercise partial-answer
review and strict JSON recovery. Include both when checking generation changes; a 200 HTTP response
with a refusal or llm_unavailable is not a successful answer. Inspect reason, verification and source
count alongside wording. Format regeneration can add one completion call, bounded by the existing
worker budget; it does not allow a new tool round or bypass numeric/semantic verification.

The runner exits nonzero on wrong routing, HTTP failures, missing expected meeting terms/evidence
or an unsupported answer in a negative case. Public/general answers still require manual quality
review. A saved JSON report is retained even when these smoke criteria fail.
