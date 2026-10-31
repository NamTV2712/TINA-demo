# @tina/transcribe-whisper — the shared stt.v1 egress

_meetings/ · module · the single chokepoint to the hosted Whisper service._

One concern: take a PCM window → call the hosted transcription-service (OpenAI-
compatible `verbose_json`) → return word-level segments, with the **low-confidence /
hallucination STT filter applied at source**. Both lanes drive the shared buffer,
which calls this via an injected `transcribe(pcm, prompt)` fn — so whisper knows
nothing of topology, naming, or confirmation.

- `isLowConfidenceSegment` drops acoustically-junk segments (bad logprob, high
  no-speech, runaway compression) before they reach the confirm loop.
- WAV-encodes Float32 PCM, retries transient failures with backoff, 30s timeout.

## Surface
`TranscriptionClient` · `continuityPrompt` · `isLowConfidenceSegment` · `setLogger` · types
`TranscriptionWord/Segment/Result`, `TranscriptionClientConfig`. Front door:
[`src/index.ts`](src/index.ts).

Live callers use `continuityPrompt(previousText, pcm, sampleRate)` before sending inherited text.
Windows shorter than two seconds omit it; longer windows retain the caller's existing text/cap.
The helper uses actual sample count, never adds/drops audio and never rewrites recognized text.
Explicit prompts passed directly to TranscriptionClient (for example reviewed refinement vocabulary)
are still forwarded, even for short input. `vi-en` language review remains fail-closed; when inherited
context is omitted it cannot provide a diacritic hint for the optional retry, which defaults to English.
That retry stays a review-only suggestion, with original audio/text retained.

Optional `TranscriptionTiming` carries capture-to-submit milliseconds. Clients identify only their
bounded source (`meeting-bot` / `extension` / `unknown`), create a UUID per HTTP attempt and send
`X-ASR-*` diagnostic headers. No names, meeting identifiers, text or audio enter diagnostic metadata.

## Verify
```bash
pnpm --filter @tina/transcribe-whisper build
pnpm --filter @tina/transcribe-whisper test   # the stt.v1 low-confidence filter golden
```
`gate:node` runs the **offline** filter golden here; the HTTP client is exercised
end-to-end by pipeline replay (3.2) and live L4. Covered by `gate:node`,
`gate:isolation`, `gate:exports`, `gate:readme`.
