# asr-recovery.v1

`GET /transcripts/{platform}/{native_meeting_id}/asr-recovery` returns the Desktop's durable
ASR recovery status. The same owner and origin checks as source audio apply. No provider URL,
token, capture API key or PCM appears in the response.

- `sessions`: archive session id, `pending | blocked | completed`, optional error.
- `windows`: the latest 100 recovery windows, each keyed deterministically by session, source,
  inclusive start/exclusive end sample; state, attempt count and safe error. Each window covers
  at most 240000 samples (15 seconds at 16 kHz). Gaps and captured speaker-name changes split it.
- `checkpoints`: processed sample intervals scoped to session/source. A gap in captured PCM is
  never filled with silence and never sent to ASR as if captured audio existed there.

PCM ACK remains an archive receipt, not an ASR completion receipt. Live confirmed text and its
coverage are committed together. Recovery result text, search index, coverage and completed
window commit together; a process death before commit leaves the same job retryable. A live
confirmation racing recovery supersedes the affected job so its remaining range can be replanned.

The worker pauses for live input/flush, uses the pinned ASR configuration digest, and retries
HTTP failures with bounded exponential backoff (1–60 seconds). Missing original credentials or
changed settings leave a session blocked until the same configuration is registered again.
Raw ASR, audio and accepted manual/Restore revisions are preserved.

Stop/reconnect does not checkpoint the captured min/max range. It plans uncovered source ranges
for recovery; only confirmed transcript ranges or successfully committed recovery/energy-gate
results advance coverage. Failed attempts remain retryable. Captured gaps stay gaps. Mixed
teardown rejects new PCM, drains in-flight segmentation callbacks, then flushes the final turn.
A late accepted frame atomically reopens a completed session together with its PCM insert;
failure rolls back both before ACK.
Existing historical checkpoints are not automatically rewritten; old completion state alone
cannot establish that every source range reached ASR.

This applies to captures registered after recovery support was installed. Historical audio without
the original ASR routing metadata is not automatically interpreted. Recovery preserves known
per-channel names and local mic identity; a mixed source without reliable identity remains unknown.

Validation: Desktop `src/asr-recovery.test.ts` covers SQLite rollback, checkpoints, retries,
settings isolation and real child-process SIGKILL during live and recovery ASR requests.
`asr-checkpoint.test.ts` guards missing/quiet ranges, repeated Stop/retry and revision preservation;
mixed `dispose-drain.test.ts` guards late boundaries and shared concurrent-close completion.
`asr-short-recovery.test.ts` checks that batch recovery retains short replies with the existing
mixed media/repetition policy while preserving RMS/confidence guards, source PCM and timestamps.
This policy change adds no fields to the recovery status contract and does not re-decode completed jobs.
