# agent · shared

Shared agent primitives used by both the control plane and the worker: config/settings loading (`config`, `agent_config`), domain `models`, hexagonal `ports` and `adapters`, and the `core` run wiring.

Translation helpers:

- `translation_groups.py` owns deterministic same-speaker phrase boundaries over finalized canonical
  segments. It preserves source member IDs/text and timestamps, applies sentence/pause/size limits,
  and computes cache fingerprints. It makes no model calls and never edits transcripts.
- `translation_text.py` extracts visible English text from model output, removing inline reasoning
  blocks and rejecting incomplete, empty or oversized results. Both worker output and cache reads use it.

The control plane supplies observed tail stability and meeting completion state; renderers consume
the resulting [meeting-translation.v2](../contracts/meeting-translation.v2/README.md) groups without
re-deriving boundaries. Grouping tests live in `../tests/test_translation_groups.py`; cache, model
selection and reasoning-output regressions live in `../tests/test_meeting_translation.py`.

`voice_knowledge.py` selects bounded voice evidence using BM25, recent transcript and neighboring
segments. It validates short voice responses and source-backed conversation context without changing
the chat Knowledge prompt. Voice history is context, never a new factual source.

Voice replies also pass a digit/source guard and separate constrained LLM review before output.
Failed or unavailable review releases an empty claim set, never the unchecked draft.

Voice answers can request one bounded round of read-only transcript/shared-document lookups.
`voice_knowledge` owns query routing, tool-argument validation, bounded snapshot retrieval and
allowlisted failure explanations. Explicit public queries and general definitions are isolated from
meeting history/evidence. `eval/voice` contains 30 synthetic regression questions, not a real ASR or
meeting-quality benchmark.
