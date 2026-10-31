# buffer/src

Front door [`index.ts`](index.ts) exports:

- the pure LocalAgreement-N core in [`local-agreement.ts`](local-agreement.ts);
- the parity-locked reusable Google Meet window in
  [`gmeet-compatible-buffer.ts`](gmeet-compatible-buffer.ts).

[`gmeet-compatible-buffer.parity.test.ts`](../../gmeet-pipeline/src/gmeet-compatible-buffer.parity.test.ts) imports the
Google Meet source as its behavioral oracle and separately pins the Teams-only caller
seams. `gate:node` runs both test files.

The live prefix echo/timeline regression lives beside that parity test:
[`prefix-echo-timeline.test.ts`](../../gmeet-pipeline/src/prefix-echo-timeline.test.ts).
Both implementations suppress a copied prior confirmed prompt and clear its draft, while
retaining repetition within one ASR result. Offset advancement keeps the remaining audio on
its capture timeline; it does not stamp retained speech with the response-arrival clock.

`silence-cut.ts` selects a source-sample boundary within a sustained near-zero (200 ms) gap
in the most recent four seconds. The caller supplies the earliest permitted cut. Quiet speech
is not scaled against a louder voice; no suitable gap returns `null` so the caller retains context.
The returned offset partitions PCM without dropping or duplicating samples. This is a conservative
cut heuristic, not word timing or a replacement for the VAD/transport speaker-boundary source.
