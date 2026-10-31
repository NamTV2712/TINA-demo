# Native preprocess acceptance — 2026-10-28

Status: current capture path exercised; quality issues remain. This is a bounded
acceptance probe, not evidence of a production-wide accuracy improvement.

## Scope and fixed conditions

The owner chose **keep External Headphones + External Microphone; capture/replay**.
Default devices were retained. No loudspeaker-room AEC test was performed.
No production DSP setting, backend preference, source code or database schema changed.
The installed Capture binary and production DSP source hashes matched both before
and after the run. There was no recording A/B campaign.

- Installed binary: `24395a34bc6d8766683d0074a43a0e889b389521beb27566400730600d97b1bd`.
- DSP source: `0dad49f217c33a6b4f09ff4a974077a32fbf35bddc2ee6dec2bbeca5b746457d`.
- Current processing: 16 kHz, 10 ms blocks, 70 Hz high-pass, Speex AEC + residual,
  noise suppression -3 dB; AGC/VAD off.
- Human recordings: cached FLEURS VI/EN test rows 20/21/22 per language; source
  hashes checked. The plan and reference were frozen before inference.
- Replay controls: 40/60 ms digitally delayed reference echo, deterministic noise,
  normal/quiet near-end speech and double-talk. These are simulated acoustics,
  not separate microphone tracks captured in a real room.
- Native playback: four sequential human-recorded clips, **52.7 seconds** including
  silence, played at afplay gain 0.35 through the existing headphones.

## Actual ASR backend

The current endpoint is loopback :18002. Its health reports
`g-group-ai-lab/gipformer1.5-68M-rnnt`, CPU, with `fsmn-vad`.
The `whisper-1` API/config label is an alias and is not proof of the loaded model.
These results must not be attributed to Qwen3-ASR. Preferences were not rewritten.

## DSP replay and ASR observations

The harness included the exact production `echo_cancel.rs` and used existing
Speex dependencies, without Sherpa's conflicting FFT. All eight cases preserved
sample counts and sample-index/timestamp fields, produced finite samples, and
had zero simulated-reference bypass. ASR used the existing TranscriptionClient
and the resolved production endpoint, one request at a time, without prompt,
forced language or alternate-model trials. All eight HTTP requests succeeded.

| Case | Reference tokens | S / D / I | WER | CER | HTTP call |
|---|---:|---|---:|---:|---:|
| vi_vn-normal | 26 | 0 / 0 / 0 | 0.00% | 0.00% | 1466 ms |
| vi_vn-quiet | 22 | 0 / 0 / 0 | 0.00% | 0.00% | 839 ms |
| vi_vn-double-talk | 28 | 5 / 0 / 8 | 46.43% | 38.32% | 1526 ms |
| en_us-normal | 22 | 7 / 10 / 0 | 77.27% | 58.49% | 1052 ms |
| en_us-quiet | 23 | 6 / 15 / 0 | 91.30% | 82.65% | 934 ms |
| en_us-double-talk | 12 | 5 / 5 / 2 | 100.00% | 70.00% | 551 ms |
| silence | 0 | 0 / 0 / 0 | n/a | n/a | 9 ms |
| echo-only | 0 | 0 / 0 / 1 | n/a | n/a | 164 ms |

Speech total: **133 reference tokens**, WER
**47.37%**, CER **43.24%**. Whole-clip request P50/P95:
**934/1526 ms**.
These six utterances do not establish a representative language/overlap error rate.
Vietnamese WER is whitespace/syllable-style; CER removes spaces, retains accents.
There was no unprocessed-audio ASR baseline, so these numbers do not isolate a
DSP-caused change in recognition quality.

Silence produced no text. Echo-only output had approximately **27.55 dB** lower
energy than its simulated mic input after the initial two seconds, but still
produced nonempty ASR text: echo attenuation did not eliminate transcript leakage.
Near-end waveform lag measured by cross-correlation was approximately 9.1–10 ms;
returned timestamps preserve source sample identity, not zero algorithmic delay.
The two Vietnamese normal/quiet clips had zero token errors; Vietnamese double-talk
and the three English clips had material errors. No real-phoneme preservation or
speakerphone performance claim follows from these limited samples.

## Native installed application

Completed test meeting: `desktop/tina-native-36a50a25-c01f-491b-b930-412722ec3d3d`. The app was started through its
Meeting UI with both sources selected, then finalized through the
Desktop session-end API for that test-owned session. The UI Stop button itself was not validated in this run.
There are **6 finalized system-source segments**.
Mic text is excluded from WER because there was no independent mic reference.

The saved system signal contains the complete playback interval; alignment to the
reference has correlation **0.9826**.
The offset from capture start includes harness setup; it is not caption latency.
Native system transcript WER: **39.78%**;
CER: **38.04%**, on 93 reference tokens.

| Channel | Role | Saved samples | Interior gaps | Overlap |
|---|---|---:|---:|---:|
| 999 | system | 1,099,200 | 0 | 0 |
| 1002 | raw resampled mic | 1,098,371 | 0 | 0 |
| 1000 | processed mic | 1,097,635 | 0 | 0 |

All three stored streams had zero samples at the PCM clipping threshold and
consistent timestamp/sample-index mapping. This does not measure physical clock
accuracy or independently verify ADC clipping/long-run clock drift.

At API finalization, processed mic ended **736 samples
(46 ms)** before the already archived raw mic.
No interior samples were missing, but complete processed-mic tail coverage was not
achieved. This is consistent with the current bounded-discard capture teardown;
it is not evidence that this tail was recovered for ASR, nor a test of UI Stop.

Server metrics (both sources, 76 ASR requests):

| Metric | P50 | P95 |
|---|---:|---:|
| ASR HTTP | 373 ms | 816 ms |
| Capture to request | 13 ms | 1775 ms |
| Confirmed publication lag | 3251 ms | 55925 ms |

Confirmed lag has only 17 samples and includes mic/system
and session-finalization tails. It measures server publication relative to the
segment end, not pixel presentation. Do not subtract different percentiles to
attribute buffering/VAD time. RSS, real-room ERLE, 45–60 minute stability, and
independent physical timestamp drift were not measured.

## Harness failures and cleanup

The first native attempt (meeting id 99) was interrupted when macOS Accessibility
reads timed out; playback was stopped and its owned session finalized through the
API. It is retained as incomplete and excluded from native WER. A second retry
failed a UI mode assertion before starting capture. The completed third attempt
used API health polling during playback to avoid the failing AX observation path.
Early in the first attempt the real UI reported 216 processed AEC blocks,
72 bypassed samples and zero packet drops; these are initial counters from the
incomplete attempt, not final counters for the completed attempt.

The two created test meetings remain saved for inspection; no previous meeting
was deleted or edited. No capture is left active. Default audio devices remain
External Microphone / External Headphones. UI cleanup observations are retained
in the private artifact directory.

## Follow-up priorities

1. Reconcile/flush the raw-to-processed mic tail at session end while retaining
   the existing pause/session-isolation guarantees; reproduce through UI Stop too.
2. Surface the actual backend identity and investigate the current endpoint's
   English/overlap errors before claiming bilingual acceptance. Do not change the
   owner's selected backend automatically.
3. Investigate confirmed publication/finalization lag separately from HTTP inference.
4. Revisit acoustic AEC acceptance only if the owner chooses speaker/mic routing.

Artifacts, audio, references and per-case hypotheses remain outside Git at
`/Users/jky/tina-test-rig/native-preprocess-acceptance-20261028-01`. Plan, source/audio hashes, DSP runner, ASR results, native SQLite source
exports and latency snapshots are available there. No cloud storage upload occurred.
