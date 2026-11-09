# agent · shared

Shared agent primitives used by both the control plane and the worker: config/settings loading (`config`, `agent_config`), domain `models`, hexagonal `ports` and `adapters`, and the `core` run wiring.

Translation helpers:

- `translation_groups.py` owns deterministic same-speaker phrase boundaries over finalized canonical
  segments. It preserves source member IDs/text, canonical revisions and timestamps, applies sentence/pause/size limits,
  and computes cache fingerprints. It makes no model calls and never edits transcripts.
- `translation_text.py` extracts visible English text from model output, removing inline reasoning
  blocks and rejecting incomplete, empty or oversized results. Both worker output and cache reads use it.
  It also owns the fixed translation failure-code/HTTP-status mapping shared by worker and control
  plane; provider response text and credentials never enter translation status.

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

Voice planning validates at most two authorized lookup names/queries; current heard history is revalidated against source fingerprints before entering any meeting prompt.

Voice routes include conservative server-owned assistant intents. Numeric/semantic verification can repair one rejected draft against the same sources, reverify it, and return bounded content-free check codes.

Voice-only retrieval splits long approved sources into sentence/word-aware slices of at most 1200 characters with 200-character overlap. Each slice carries parent key/fingerprint and exact character offsets; original segment timestamps remain parent intervals, not inferred chunk timing. Short sources retain their existing identity.

Voice ranking accepts an injected semantic candidate ranking and fuses it with BM25 using reciprocal ranks before selecting anchors and neighboring evidence. Shared code and worker require no embedding dependency; absent/busy/failed semantic retrieval leaves lexical retrieval available.

voice_summary owns conservative whole-meeting recap intent detection, chronological bounded transcript parts and separate map/selection prompts. Local/time-limited recaps retain normal query retrieval.

Supplemental voice context uses opaque key/fingerprint hashes and at most three adjacent original chunks on each side. Multi-query merging shares the existing budget across lookup groups so earlier useful evidence is retained.
