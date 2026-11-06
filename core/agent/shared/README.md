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
