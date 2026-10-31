# T1.7 — Caption latency investigation, 2026-10-24

## What the original six-sample observation establishes

The foundation pilot measured ASR HTTP p50/p95 479.83/1022.21 ms and legacy caption_lag_ms
3802/6712 ms. These are different clocks, different populations and not request-paired samples.
No subtraction of these percentiles can attribute a delay to FSMN, Qwen or VAD.
`capture_to_request_ms` is specifically the age of the submitted window's **newest** source sample.
A value near zero does not mean there was no initial audio-collection wait: the pipeline can collect
three seconds of audio, then submit immediately after the latest frame. That initial collection span
must be read from source window start/end and the decision trace, separately from last-sample age.

There is also a measurement-definition issue: the original Desktop metric recorded every draft
and final in caption_lag_ms. Gmeet drafts use start=end until confirmed. Those draft samples
therefore record time since the window started, not delay after speech ended. The historical
numbers remain in the foundation report with a correction notice. They are not a confirmed-only
caption latency distribution.

Instrumentation now adds confirmed_caption_lag_ms for finalized segment source-end→broadcast,
and draft_age_ms for draft source-start→broadcast. caption_lag_ms remains a legacy combined series
for compatibility. Foreground UI durations remain separate. ASR/model settings are unchanged.
Even the new confirmed series uses the pipeline's emitted endpoint; product latency still needs
independent utterance-end references and exact segment/text correspondence.

## Reproduced scheduling and confirmation behavior

`caption_latency.ts` drives the production Gmeet pipeline under a virtual clock with a constant
synthetic ASR oracle. It varies only controlled HTTP delay, speech length and whether the caller
explicitly closes the stream. It is not a recognition or model benchmark.

The current host defaults are unchanged: 2 s minimum audio, 1.5 s submit interval, three full-text
matches, 15 s idle timeout, 30 s retention/window bound. First submits occur on a periodic timer,
not at the instant the two-second minimum is reached. The growing-word-prefix path may confirm
complete earlier segments independently; the three-pass result below concerns the full-text path.

| Synthetic speech | Oracle HTTP delay | Caller control | First submit | First draft | First final |
|---|---:|---|---:|---:|---:|
| 0.6 s | 0 s | Continue silence | 16.5 s | None | 16.5 s |
| 0.6 s | 0.15 s | Continue silence | 16.5 s | None | 16.65 s |
| 0.6 s | 0.15 s | Explicit Stop after trailing pad | 1.0 s | None | 1.15 s |
| 4.0 s | 0.15 s | Continue silence | 3.0 s | 3.15 s | 6.15 s |
| 4.0 s | 0.15 s | Explicit Stop after trailing pad | 3.0 s | 3.15 s | 4.55 s |
| 4.0 s | 1.0 s | Continue silence | 3.0 s | 4.0 s | 7.0 s |

Times are from synthetic speech onset, not from the end of speech. No p50/p95 is inferred from
these deterministic cases. All 12 cases and their decision events are in the external policy run.

The causal mechanisms are visible in source and in the trace:

1. A turn's first timer tick at 1.5 s sees less than the 2 s minimum. The first ordinary request
   waits for the 3.0 s tick. A shorter submit interval might reduce this quantization delay, but
   could increase requests/queue pressure and must be evaluated before changing host defaults.
2. Short speech plus the current small trailing pad may never reach 2 s. Gmeet stops feeding quiet
   audio after the trailing pad; it does not close the active turn immediately at that silence.
   With no later voiced onset/name rotation or explicit Stop, the manager reaches its 15 s idle
   branch before submitting the short turn. The zero-latency oracle still shows the delay, so a
   slow decoder is not required to produce it.
3. For a stable whole-string result, successive submissions still satisfy the configured full-text
   agreement policy before final publication. Faster HTTP does not eliminate the waiting between
   those requests. A final Stop can submit a covering window and settle earlier.

An optional content-free onDiagnostic callback records submit/result request IDs, source window
bounds, wait/confirm/flush decisions and counters. Disabled, enabled and throwing observers were
checked to preserve request scheduling and transcript results. It is not a new wire transcript
contract and is disabled by default. Production PCM, raw ASR and canonical revision logic stay in
place. Gmeet and the mixed ChunkedTranscriber path must be investigated separately.

## Findings from the real-recording smoke

A 15-second AMI recording smoke used the actual mixed Desktop ingest and real HTTP ASR. It
revealed two additional integration details:

- Mic and tab ChunkedTranscriber instances restart turn counters at zero, as does a reconnect.
  Desktop previously used the bare turn suffix as segment_id. New mixed IDs include connection
  and channel, so separate sources/connections cannot overwrite one another. Rename/repaint
  retains the same ID inside its original connection; persisted historical IDs are untouched.
- A recovery fragment of 370 samples (about 23 ms) received HTTP 502 from FunASR. The retained backend traceback identifies a `ZeroDivisionError`
  in `funasr/auto/auto_model.py:835` when RTF divides by `batch_data_time`. PCM remained
  retained and its job retryable. A second recovery window was still pending when the smoke
  Desktop closed. This is a failed recovery condition, not an acceptance Pass. Handling short
  uncovered windows requires its own source-preserving fix; do not erase the receipt, hide a
  worker failure or call an empty hypothesis a recovered transcript merely to pass the test.

## Completed 49-minute real-time baseline

AMI EN2002c was replayed once at source speed through scratch Desktop and the real Qwen/FSMN
HTTP worker: **2972.256 s source / 2976.144 s wall time**. Three annotated human speakers share
one mixed input; annotation identities were used only for scoring. The recording and manual
references come from the [official AMI corpus](https://groups.inf.ed.ac.uk/ami/download/), CC BY 4.0.

| Check | Observed result |
|---|---|
| Source receipt/archive | 29,723/29,723 exact-range ACKs; every Float32 source sample byte-matched |
| Mid-meeting reconnect | At minute 24:46; all 621 previously finalized IDs remained, with no ID-bound changes |
| Transcript at process close | 1,301 segments; 33 already-planned recovery windows unfinished |
| Mixed-stream recognition | WER **39.43%**, CER **31.22%**; provisional mixed gate 25%/15% failed |
| First readable text | 0.740 s after first reference speech onset (one observation) |
| Emitted-source-end → confirmed publication | P50 **0.839 s**, P95 **4.356 s**, maximum **1386.671 s**, 1,301 samples |
| Independent utterance latency | Only 82/634 utterances measurable (12.93%); five negative results, insufficient for acceptance |
| Worker after minute 10 | 2,050 samples; queue P95 0.480 ms; inference P50/P95 212.821/766.737 ms; 33 failed requests |
| RSS growth after minute 10 | Desktop/replay +31.26 MiB; ASR worker +51.24 MiB; not total Metal memory |
| User revision checks | Post-stop Edit, stale CAS 409 and Restore passed; active-capture PATCH correctly returned 409 |

The publication series includes delayed recovery results: its low median does not imply all
speech was delivered promptly. Its source end is emitted by the pipeline, and cannot substitute
for independent utterance-end timing. The utterance subset is selective and its negative results
are retained, so neither series establishes a latency Pass. WER is descriptive chronological
mixed-reference scoring, not official AMI ASR/cpWER. Physical mic/meeting transport, VI/EN speech,
physical drift, word-level timing accuracy and browser paint remain unmeasured.

The Stop response took 0.274 s, but recovery was not settled. The original baseline remains
**failed-software-checks / Phase 1 Pending**. It is retained unchanged under
`~/tina-test-rig/stt-acceptance-20261024/real-time/` with hashes, raw events and SQLite.

## Source-preserving short-fragment fix and recovery-only rerun

The smallest actual retry fragment, 243 samples (15.1875 ms), reproduced HTTP 502 on the original
worker. Adding trailing zeroes to a temporary 200 ms inference input returned HTTP 200 with no
detected speech. The adapter now does this only below 200 ms. Captured audio is never padded;
response duration, sentence bounds and audio metrics remain within the original source duration.
Empty inputs remain invalid, and inference exceptions still fail/retry instead of being swallowed.
Thirteen model-free adapter/queue tests cover the fix, sample preservation, bounds and failures.

After an idle-checked worker restart, a **SQLite backup** of the baseline resumed recovery using
the same pinned Qwen/FSMN route. It settled in **42.157 s**, with **571 requests / zero errors**,
**639 total completed windows / zero unfinished windows**. In addition to the initial 33 pending
jobs, the planner discovered further uncovered ranges; 33 was not the total backlog. All 29,723
archive rows and their PCM bytes were unchanged; all 1,301 original raw transcript/history rows
were retained. Recovery added 38 segments (1,339 total).

Scoring that post-recovery copy against the same frozen reference gives **WER 38.99% / CER 30.68%**.
It still fails the provisional quality gate. Empty VAD decodes close an attempted range; they do
not prove that every word was recognized. This recovery-only run is not a second real-time
acceptance run, and does not rewrite the baseline or its latency measurements.
Artifacts: `recovery-after-short-fix/result.json`, `quality.json`, copied journal and worker log
under the same external artifact root.

The local Desktop was gracefully restarted only while idle to load the ID/metric fixes. Its
41 meetings, 216 transcript records and 103,125 PCM chunks were backed up and retained; raw
transcript/history and complete PCM-table hashes matched before/after. HTTP windows and current
model/scheduling defaults remain unchanged. Contract/architecture seals and focused suites pass;
whole-repo dataflow still fails on the pre-existing unregistered Discord service.

## Next controlled experiments

1. Compare direct bounded-window recognition with live mixed-pipeline output on frozen excerpts
   of the failed baseline to separate acoustic overlap/model errors from window/confirmation loss
   and duplicated text. Keep the reference and normalization fixed; do not tune on the final score.
2. For per-channel Gmeet, compare safe silence-triggered turn close and/or timer scheduling on
   the same frozen short/long VI/EN speech with negative/noise/quiet-speech controls. Retain the
   current policy until quality, loss/duplication, source boundaries and revision safety are checked.
3. Repeat the full real-time acceptance after quality/latency fixes. Short-fragment recovery is
   verified separately above; a recovery-only rerun cannot certify improved live caption quality.
4. Test revision invalidation through background alignment, speaker mapping and evidence after
   the physical/replay acceptance findings are addressed. Desktop currently refuses in-capture
   manual edits; do not silently change that product rule inside a latency measurement.

No switch to token/stateful streaming, no pgvector and no Phase 2 AI integration is included here.
See [roadmap and proposed thresholds](stt-roadmap-20261024.md).
