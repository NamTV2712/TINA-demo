# mixed-pipeline/src

Front door [`index.ts`](index.ts).

The Teams production front door is
[`teams-csrc-gmeet-pipeline.ts`](teams-csrc-gmeet-pipeline.ts): raw CSRC ownership edges drive
[`teams-csrc-channelizer.ts`](teams-csrc-channelizer.ts), and each virtual channel feeds the shared
faithful Google Meet buffer. It performs no Pyannote inference, diarization, clustering, embedding,
or voiceprint work.

The legacy Zoom/Jitsi front door is [`chunked-transcriber.ts`](chunked-transcriber.ts),
the single-channel core: a passive audio ring, segmentation-cut turns, the
serialized submit queue, and continuous LocalAgreement confirmation over the shared
[`buffer`](../../buffer/)/[`whisper`](../../whisper/) engine.
[`pyannote-segmenter.ts`](pyannote-segmenter.ts) is that legacy cut source — a streaming
wrapper around `onnx-community/pyannote-segmentation-3.0` (the only ONNX; cut-only, no
clustering). [`cluster-name-binder.ts`](cluster-name-binder.ts) is the hints-only
namer: it converges time-windowed platform hints onto each turn's segmentation id, no
diarization.

`*.test.ts` are the offline, model-free goldens (`gate:node` runs them via the `test`
script): the confirm-loop characterization plus the naming / claim / priority /
concurrency / flicker smokes. Each injects its own segmenter and a stub Whisper, so
the ONNX model never loads and there is no network.

ASR submission rejects only near-zero windows below RMS `0.0001`, matching the per-channel ASR floor. Higher energy thresholds used to establish transport liveness or speaker identity are separate evidence checks, not ASR audio filters. Segmentation may still miss quiet speech; passing the energy gate is not a VAD guarantee.

`dispose-drain.test.ts` holds a segmentation boundary in flight through Stop/reconnect. Closing
blocks new PCM, waits for already-fed segmentation callbacks, and flushes the resulting final
turn. Concurrent callers await the same close task; draft confirmation policy stays unchanged.

Mixed and Teams CSRC live windows omit inherited decoder context below two seconds of actual PCM.
`context-short.test.ts` retains real VI/EN repeated words, long-window context and source duration.
The continuous-buffer evaluation uses the same rule and includes the prompt digest in cache keys.
