# gmeet-pipeline/src

Front door [`index.ts`](index.ts). [`gmeet-pipeline.ts`](gmeet-pipeline.ts) is the
channel router + turn/glow binding; [`speaker-streams.ts`](speaker-streams.ts) is the
per-stream sliding-window buffer + LocalAgreement confirm;
[`hallucination-filter.ts`](hallucination-filter.ts) drops junk (phrase lists in
[`hallucinations/`](hallucinations/)); [`log.ts`](log.ts) is the injectable logger;
[`contracts/`](contracts/) is the TS view of the sealed `transcript.v1`.

`*.test.ts` are the offline goldens (`gate:node` runs them) — the hallucination filter
and the **replay conformance** gate.

`prefix-echo-timeline.test.ts` guards the live prefix-confirm path and shared Teams buffer:
an ASR segment copying the immediately previous confirmed prompt is discarded and its draft
cleared, including when both use the same start ID. Repetitions within the current ASR result
remain. Prefix trims advance from the original audio window; the shared buffer's retained tail
uses capture/sample time instead of response-arrival time. This does not add word alignment or
fuzzy transcript deduplication.

Optional `onDiagnostic` emits content-free scheduling/confirmation decisions with source bounds
and request IDs. `latency-diagnostic.test.ts` checks that enabling or throwing from the observer
preserves transcripts and request timing; it is disabled by default.

`context-short.test.ts` covers forced short-window flushes: inherited confirmed text is omitted
below two seconds, while two-second/longer windows keep it. Audio, confirmation policy and sample
timestamps are unchanged; the same shared selector is used by the mixed/Teams pipelines.
