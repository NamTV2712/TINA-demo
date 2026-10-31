# Desktop word alignment — 2026-10-27

Implemented and enabled in the running local Desktop service. HTTP Window ASR,
FSMN-VAD, ring retention, source capture and AEC defaults are unchanged. No native
Capture binary replacement or additional macOS permission grant was required.

## Accepted text and timing

Saved transcripts → Transcript review → **Align words** submits current accepted
verbatim text and verified source PCM16 to the existing authenticated MFA worker
on loopback port 18015. Desktop jobs explicitly declare `text_kind: accepted`;
Meeting API retains its existing raw-ASR alignment behavior. Alignment supplies
timing for the given text, not proof that an edited word was spoken correctly.

Input must be finalized speech with one continuous sample-clocked capture source,
at most 30 seconds per segment. Missing samples, clock discontinuities, overlapping
capture sessions, raw mic 1002, drafts and unsupported lengths are excluded.
Admission is bounded to 2,000 segments and 20,000 tokens. Worker requests use
batches of at most 20 clips (up to 10 minutes); progress yields between batches
to live capture, and alignment is serialized with refinement and speaker analysis.

Worker output must preserve every input token/index exactly, match audio/text
SHA-256 and duration, provide bounded monotonic intervals and retain null timing
for unaligned words. The entire batch is validated before its results publish.
Each segment then checks expected text revision and source capture reference.
Accepted timing and a metadata-only notification commit atomically in SQLite.

Text edits, refinement Apply and Restore invalidate accepted timing in the same
transaction as the text change. A delayed worker cannot revive stale timing.
`transcript_sequences` separates notification sequence from text-history length,
so alignment cannot cause clients to ignore the next text edit. Speaker changes
reproject current word names/assignments without rerunning MFA. Acoustic word
attribution uses applied diarization only; overlap or absent identity stays unknown.

Canonical words/phrases carry source-absolute milliseconds and provenance. Job
word intervals stay relative to the capture clip. Memory retains exact accepted
quotes and text revisions, with the current canonical revision; it does not infer
assignees from speaker names. A clickable word requests an owner/origin-scoped
PCM16 clip that rechecks job, text revision and source WAV hash. Unaligned words
are plain text. Stale preview audio is stopped/removed after a revision change.
Background refreshes preserve unsaved text and speaker input.

## Verification

| Check | Result |
|---|---|
| Full Desktop suite and TypeScript build | PASS, including recovery/SIGKILL and existing speaker/canonical tests |
| Alignment integration | PASS: seven isolated batch calls; PCM16, exact tokens, OOV, invalid hashes/times, gaps, ambiguous sources, late text edits, Restore, rename, clip bytes, ACL, cancellation, restart, batch pause/resume and outbox rollback |
| Meeting API alignment/canonical/revision/speaker/memory tests | 33 passed; existing Starlette/httpx deprecation warning |
| Extension suite | PASS, including alignment invalidation notices and canonical refresh/reconnect handling |
| Schema gate | PASS: 32 validated contracts, including Bot and Desktop alignment goldens |
| Contract seal gate | PASS: 39 schema contracts sealed |
| Dataflow gate | PASS: 120 nodes, 95 edges, 11 carriers |
| Browser with real MFA | Align words, click word audio, rename, edit, Restore and reload verified on an isolated local fixture; unsaved input survived completion and stale preview was removed |

Gateway schema gate is fixed by correcting the frozen contract's `info.title`
from `Vexa API Gateway` to the expected `TINA API Gateway`. No runtime Gateway
route or API version was changed. Contract seals and generated CALM views were
updated. The pre-existing review favicon request returns 404; no JavaScript
exception was observed in the tested UI flow.

## Real-worker functional check

macOS Linh generated “Tôi sẽ gửi báo cáo vào thứ Sáu.”, converted to mono 16 kHz
source PCM. The existing MFA 3.3.4 / Vietnamese MFA 3.0.0 worker returned **6 aligned
tokens out of 8**; the remaining two stayed untimed. The last invocation took
**15.826 seconds** including worker setup/processing. Clicking “gửi” played a
roughly 280 ms verified snippet. These are functional observations on one short
synthetic utterance, not a timing-error benchmark, WER/CER improvement, latency
distribution, English validation or 60-minute meeting acceptance. No A/B was run.

## Local deployment and integrity

Desktop was restarted only after checking there was no live capture. Its existing
private alignment token file is consumed server-side by the local launcher. The
running `/alignment` endpoint reports available; `/canonical` and `/memory` return
their expected contracts. No job was started against the user's historical data.

Backup and before/after reports:
`/Users/jky/Library/Application Support/TINA/app-backups/20261027-173957-desktop-alignment`.
Counts remain **79 meetings, 305 transcript records and 258,981 PCM chunks**. Raw
ASR/revision SHA-256 and all stored PCM bytes match before/after. SQLite
`quick_check` returns `ok`. Migration only adds `alignment_jobs`, `alignment_results`
and `transcript_sequences`; Desktop and Bot retain their own database authority.

Remaining limits: Vietnamese MFA can leave Vietnamese or code-switched words
unaligned; unsupported spans retain segment fallback. Long individual segments
over 30 seconds need future validated splitting. Cancellation stops publication
and remaining batches; the shared worker may finish its current invocation.
Word-level boundary accuracy still needs independently labeled meeting audio.
