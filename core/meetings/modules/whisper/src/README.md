# whisper/src

Front door [`index.ts`](index.ts). [`transcription-client.ts`](transcription-client.ts)
is the HTTP client to transcription-service; [`confidence.ts`](confidence.ts) is the
pure low-confidence filter (pinned by `confidence.test.ts`); [`log.ts`](log.ts) is the
host-injectable logger.

`continuityPrompt` in the shared client file is the live callers' two-second minimum for inherited
context. `continuity-prompt.test.ts` checks sample-rate/boundary behavior, unchanged PCM/results,
explicit refinement prompts and held unexpected-language output. It does not filter matching text.
