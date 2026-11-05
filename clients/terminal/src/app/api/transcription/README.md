# Transcription control

The authenticated Terminal boundary for account-scoped ASR lifecycle settings.
`runtime/` proxies safe status and start/stop requests to the deployment's host controller.
Audio transcription remains at `/api/stt`; inference testing uses the existing
`/api/transcription/test` gateway route.

The browser never receives worker tokens, the internal Identity secret, Docker access,
or a caller-selectable account identity. See [runtime](runtime/README.md).
