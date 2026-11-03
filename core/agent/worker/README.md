# agent · worker

The agent worker: runs a single agent workload to completion. Owns the generic turn engine
(`engine`), the per-meeting loop (`meeting`, `meeting_transcript_mcp`), and its container image
(`Dockerfile`). Model/harness access goes through the provider-agnostic [`llm`](../llm) ports —
card beats via `CompletionPort` (a direct HTTP completion), workspace turns via `HarnessPort` (the
`TINA_RUNNER`-selected CLI agent); no vendor name lives in this package. Spawned by the control
plane; liveness = workload lifecycle.

Terminal dictation polish is a one-shot, read-only `CompletionPort` job in the worker. It has no
harness tools and does not write chat history or workspace files.

TINA Capture live translation is also a one-shot, tool-less `CompletionPort` job. It receives one
confirmed transcript segment and a fixed target-language code; the source is treated as untrusted
text, and the translated result is returned to the loopback client without writing transcript or
workspace history.

Meeting transcript translation reuses this same entrypoint with one backend-grouped phrase as
its source text. `engine.py` passes the saved `TINA_MEETING_MODEL` override to CompletionPort
(falling back to its configured completion model when absent). The shared `translation_text`
helper removes inline reasoning and rejects unusable output before emitting a message delta.
Failures emit no translated text and do not log the transcript or provider response body.
The control plane owns phrase grouping, persistence, leases and retry; this worker performs
only the tool-less translation and leaves original/canonical transcripts unchanged.

# Canonical notes jobs

`processed_notes.py` handles the private canonical-window entrypoint before the legacy live loop.
It calls the existing tool-less meeting CompletionPort using canonical text and resolved speaker
names, then emits a candidate result. It does not publish live notes, edit canonical text or
overwrite workspace documents. Meeting API owns source/lease validation and final publication.
