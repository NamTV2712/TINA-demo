# MIGRATION-0008 — canonical transcript text and revision

Additive columns on the existing raw-ASR `transcriptions` table:

- `canonical_text TEXT NULL`: the latest accepted correction; NULL uses the current ASR text.
- `canonical_revision INTEGER NOT NULL DEFAULT 0`: counts accepted manual/refinement/restore revisions.

The identity service owns schema convergence; deploy its additive schema before the new Meeting API.
No raw text or audio is rewritten or deleted. Both model mirrors and schema.seal.json carry the change.
Meeting API startup backfills existing correction histories into these columns before serving traffic.
New corrections update JSONB history, canonical text/revision and JSONB outbox in one transaction.

Meeting API's existing background index builder creates `ix_transcription_canonical_fts` CONCURRENTLY
on `to_tsvector('english',COALESCE(canonical_text,text))`. The previous raw-text index is left in place
for rollback. Query and index expressions remain identical. Index absence affects speed, not results.

Rolling back application code is non-destructive: leave both additive columns in place. Preserve the
JSONB correction history/outbox for a later rollout; do not drop fields or rewrite original ASR rows.
