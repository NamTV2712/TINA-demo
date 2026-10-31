# Native audio preprocessing — 2026-10-28

## Delivered

Installed and reopened `/Applications/TINA Capture.app`. New capture sessions with
both microphone and system audio use Speex AEC, residual suppression, stateful
70 Hz high-pass on both aligned inputs, and mild denoising limited to **-3 dB**.
AGC and Speex VAD remain off. Capture uses 10 ms DSP blocks and HTTP Window ASR
remains the Desktop/Bot default; no 120 ms transport framing or codec was added.

Track 1002 remains unprocessed **resampled** microphone audio, track 999 remains
the original resampled system mix, and derived mic track 1000 goes to ASR.
DSP retains each block's sample count, source sample index and timestamp. Missing
reference blocks pass through unchanged. Capture Diagnostics distinguishes AEC
initialization from actual processed blocks, shows bypass/sample-clipping counts
and setup fallback reasons. Pause/resume resets pending audio and DSP state while
retaining counters.

## Correctness issue found and fixed

Native Capture used Sherpa only for resampling. Sherpa exported floating-point
`kiss_fft` symbols while SpeexDSP used fixed-point KissFFT with the same names.
The combined binary reproduced invalid preprocessor output and native crashes;
standalone Speex probes did not. Removing Sherpa from the native Capture dependency
and reusing existing SpeexDSP for resampling removed the conflicting implementation.
This does not remove or reconfigure Sherpa/Qwen/Gipformer ASR backends in Desktop/Bot.

The Speex resampler float API expects PCM16 units. The wrapper scales normalized
Float32 input/output explicitly; quiet audio gain and chunk invariance are tested.
The no-default-features build disables AEC but still links Speex for resampling.

The initial -10 dB denoise setting failed the synthetic double-talk retention
check. -6 dB also fell just below that unchanged check. The delivered -3 dB setting
passes the same retention threshold; these were deterministic DSP checks, not a
restarted recording A/B campaign or a new ASR accuracy benchmark.

## Validation

- Release Rust tests: **38 passed**, including real loopback WebSocket delivery.
- No-default-features Rust tests: **27 passed**.
- Native UI tests: **20 passed**.
- Capture codec golden/timeline/recording checks: passed.
- Signed macOS app bundle: built and `codesign --verify --deep --strict` passed.
- Installed binary SHA-256 equals the built bundle: `24395a34bc6d8766683d0074a43a0e889b389521beb27566400730600d97b1bd`.
- Dataflow gate: **123 nodes, 101 edges, 14 carriers**, complete and sealed.
- Contract-version gate: **39 sealed contracts**, passed.
- Whole-repo graph / arch-report: **not green**. Dependency cruiser reports a cycle
  between Desktop `alignment.ts` and `transcript-journal.ts`, plus the same cycle
  in their compiled `dist` files. Those modules were not changed in this task.

DSP checks cover 20 Hz rumble attenuation (<0.3 amplitude ratio), 250 Hz quiet
signal retention (>0.94 high-pass amplitude ratio), stationary noise reduction
(<0.8 output/input energy), quiet voiced output (>0.25 input energy), delayed
synthetic echo (<0.5 RMS residual ratio), and a near-end 440 Hz signal during
synthetic double-talk (>0.01 retained amplitude for 0.02 input). Tone/noise proxies
do not prove preservation of Vietnamese phonemes or real conversation accuracy.
Resampling at 16/24/44.1/48 kHz retains identical output across packet boundaries
and a 0.01-amplitude signal retains RMS in [0.006, 0.008]. WebSocket assertions
verify exact system/raw bytes and processed-mic header, length and changed payload.

## Runtime scope and rollback

The installed app was idle (no Desktop ingest connection) before replacement.
No recording was started by this change. Audio archives, transcripts, meeting
settings and database contents were not modified. Actual acoustic AEC efficacy,
clock drift, real-device clipping and VI/EN WER/CER remain unmeasured for this build.
The app's new counters make reference fallback observable on the next capture;
processed block counts alone do not demonstrate echo attenuation.

- `TINA_MIC_CLEANUP=0`: AEC plus residual-only settings (no new HPF/denoise).
- `TINA_SPEEX_RESIDUAL_SUPPRESSION=0`: linear AEC only.
- `TINA_SPEEX_AEC=0`: original microphone path.

Apply rollback variables when launching a new Capture process/session. The previous
signed app is preserved at `/Users/jky/Library/Application Support/TINA Capture/backups/20261028-132928-before-mic-cleanup.app` with binary SHA-256
`bc703e13a22133b9684a7223a4f7ddd524636d3caab170d2c2056513a3990df2`. As before, rebuilding an ad-hoc-signed macOS app can
require macOS to authorize the new binary again; permissions were not reset.

## Architecture gate follow-up

The Desktop alignment/journal dependency cycle reported above was subsequently
removed. Source and compiled graph, sealed dataflow, Desktop tests/build and the
complete architecture report are now green. See
[the follow-up report](architecture-alignment-cycle-20261028.md).

## Bounded capture/replay acceptance follow-up

The installed binary was subsequently exercised with real recorded VI/EN speech,
native capture on the existing headset/mic, and simulated-echo DSP replay.
Backend identity, accuracy, publication-lag and processed-mic tail issues remain;
see [acceptance results](native-preprocess-acceptance-20261028.md).
