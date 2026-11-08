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
