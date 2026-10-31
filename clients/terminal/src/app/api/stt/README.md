# api/stt (composer dictation STT proxy)

`POST /api/stt[?prompt=…]` with an `audio/wav` body (16 kHz mono PCM from
`ui-kit/micDictation`). Forwards to the signed-in user's selected transcription
backend (FunASR Qwen3-ASR-0.6B, Apple MLX, NVIDIA CUDA, or custom); the deployment endpoint is the
fallback. All endpoints use the OpenAI-compatible contract in
`@tina/transcribe-whisper`; the bearer token stays server-side. Returns
`{ text, words }` — word timestamps drive the client's LocalAgreement
confirm/trim loop when available. Backends without word timestamps such as FunASR update the live draft per
audio window and commit at a bounded 25-second window or when dictation stops. `prompt` carries already-confirmed
text for Whisper context continuity. An unconfigured selected backend answers 503 with
a human-readable error instead of failing silently.

The proxy forwards bounded capture-lag metadata, supplies the `dictation` source and a request UUID,
and returns `X-ASR-Request-ID` / `Server-Timing` for correlation. Diagnostics never contain audio or text.

After dictation stops, Terminal may send the final transcript text to the authenticated agent-api
`POST /api/dictation/polish` route, which dispatches a tool-less CompletionPort worker. It sends no
audio and creates no chat history. The composer keeps the raw transcript and restores it if the polish
request fails or the user chooses undo.
