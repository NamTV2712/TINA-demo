# ASR status

Admin-gated `GET /api/admin/asr-status` resolves the caller's effective ASR backend through identity,
then reads its `/status` endpoint. Credentials remain server-side; the response strips unknown
fields using the Terminal adapter for `core/meetings/contracts/asr-status.v1`.

No fallback to another backend occurs on lookup or diagnostics failure. An unsupported backend,
an unreachable service, and an empty sample window are different states. Polling does not run ASR.
