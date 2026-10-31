# Canonical readable notes: implementation and deployment

Date: 2026-10-28. Scope: Meeting API/Bot canonical transcript → derived readable notes and
grounded entity cards. Local Desktop SQLite authority and its explicit replication contract remain
separate. No ASR endpoint, audio capture, ring buffer or durable-audio format was changed.

## Delivered behavior

- Meeting Memory supplies the existing canonical conversation windows (normally 60 seconds /
  6,000 characters at segment boundaries). Each job binds a complete canonical-window fingerprint,
  exact segment revisions, timestamps, resolved speakers and source quotes.
- Meeting API owns durable window state in `meeting.data.canonical_notes`. A meeting-row lock
  serializes claim, edit/restore/rename invalidation, result comparison and publication state.
  LLM calls run in isolated agent workers, outside that transaction, through the existing tool-less
  `CompletionPort` / meeting prompt. They do not edit canonical text or workspace documents.
- The existing per-user model selection applies using the meeting's actual owner. Signed requests
  use the existing shared internal secret. Agent API verifies the signature and validates the live
  lease with Meeting API before dispatch, so canceled or superseded queued work is not admitted.
- Source edits, Restore and speaker rename revoke affected leases in the same mutation transaction.
  Only affected windows become pending. An unrelated new window does not invalidate a valid result.
  Superseded in-flight work is coalesced instead of continuously launching parallel requests.
- Results are candidates. Only current fingerprint + generation + lease + enabled state can commit.
  Speaker names and evidence come from canonical data, not model guesses. Replay of a committed
  result is idempotent. Raw ASR and audio remain the original source.
- Each approved note carries source metadata, exact evidence, publication revision, requested
  model/provider, prompt version and prompt SHA-256. Entity cards require a literal title mention
  in the source and keep at most three matching evidence quotes.
- Meeting API publishes approved notes/cards and sanitized failures through `proc:meeting:{id}`.
  The revision outbox sends metadata notifications with changed IDs. Only changed rows are normally
  appended; a complete final snapshot precedes its terminal marker atomically. Historical public
  stream replay cannot overwrite the already-authorized durable view.
- REST/SSE merges compare publication revisions. Notes whose source changed show **Out of date**;
  **Source** reveals the original canonical quote in the default transcript renderer. Removed source
  segments emit withdrawn tombstones. A failed processing state exposes **Retry processing**,
  including for completed meetings. Absolute source timestamps render with the normal clock path.
- Jobs recover through durable 180-second leases and at most three attempts per unchanged source.
  Queue ACK follows dispatch or DB commit, acknowledged payloads are deleted, and meeting artifact
  deletion also purges queued source/results. Shared transcript viewers do not receive stale
  processed notes/cards; internal job state is omitted from normal response/webhook projections.

## Control and API

Existing live **Processing on/off** delegates owner-scoped configuration to Meeting API.
Completed recordings expose **Generate AI notes** and **Disable AI updates** as explicit actions.
Pre-existing active opt-in flags can migrate once; an explicit OFF is durable. Completed
Raw/Processed remains a view switch, while **Retry processing** explicitly starts failed work again.
Already admitted requests may finish after OFF, but their result cannot commit after revocation.

- `GET /transcripts/by-id/{meeting_id}/processed-notes`: owner-only state/view.
- `POST /transcripts/by-id/{meeting_id}/processed-notes`: `{enabled: boolean}`.
- `POST /transcripts/by-id/{meeting_id}/processed-notes/validate`: owner-scoped lease admission check.
- `canonical_notes_requests`: Meeting API → Agent API dispatch watcher.
- `canonical_notes_results`: isolated worker → Meeting API candidate consumer.
- `meeting.notes.updated`: metadata-only revision notification; Source text stays in the canonical
  snapshot and authorized processed view.

The `processed-notes.v1` contract, goldens, API declarations, architecture model and seals were
updated. Existing canonical/memory/alignment route declarations were reconciled with their shipped
routes while extending the API contract; this closed the pre-existing surface-conformance failures.

## Verification

- Meeting API: 1,509 tests passed, 7 skipped in the final full suite; run result is recorded in `/tmp/tina-canonical-notes-meeting-tests-final.log`.
- Agent: 139 focused worker/API/watcher/postprocess tests passed; final run is recorded in
  `/tmp/tina-canonical-notes-agent-tests-final.log`.
- Terminal: 28 tests passed across hydration, revisions, evidence UI, default view and transcript
  engine; TypeScript and production build passed.
- Eight processed-notes contract goldens conform. Dataflow gate passed: 123 nodes, 101 edges,
  14 carriers, complete and sealed. Existing unrelated shared-writer advisory remains on tc-mutable.
- Actual PostgreSQL + disposable Redis test passed: serialized concurrent claims, delayed result
  rejection, exact source evidence, replay, Restore revision, speaker rename, approved publication,
  legacy-stream fencing, unchanged raw ASR and artifact queue purge. It called the real worker
  function with a deterministic injected CompletionPort in an isolated verification environment.
  Temporary databases/Redis instances and private env files were cleaned up.
- Packaged worker source hashes match the checkout. Running Meeting API, Agent API and Terminal
  source checks also matched their tested sources.
- A real completion from the worker image succeeded with the current selected `gpt-6-luna`
  configuration through `openai-responses`, using fixture text only.
- A temporary completed-meeting fixture then passed the actual running stack end to end:
  durable claim → signed request → live admission → real runtime-spawned worker → selected provider
  inference → source-CAS commit → approved stream publication. Its source evidence/revision was
  checked. The owned temporary meeting, transcription, queues and runtime workload were cleaned up.
- Live processed-notes GET returned 200 for the owner and 404 for another user. Terminal meeting
  page returned 200; updated containers are healthy.

## Deployment and limits

Deployed to local Compose project `tina-verify-20261015`: Meeting API, Agent API, Terminal and the
worker image used by subsequent runtime spawns. Runtime already resolves its worker image correctly;
no image-routing configuration change was needed. The prior unrelated Discord runtime setting was
preserved with a private override at `/tmp/tina-canonical-notes-runtime-override.json`.

This is a source-freshness/durability change, not evidence of improved ASR WER/CER or LLM semantic
accuracy. Real-provider verification used short fixture text, not a 45–60-minute audio acceptance run.
Browser behavior was covered by component tests and deployed HTTP checks; no interactive screenshot
inspection was performed.

Canonical mode updates the server-backed readable view and cards; it does not automatically rewrite
the user's editable KG/workspace meeting document. Dedicated source-aware post-meeting document
regeneration and cursor/app context capture remain separate work. Existing workspace files, local
Desktop transcript authority and raw-ASR correction/proposal/Apply behavior are preserved.
