# TINA alignment and speaker pilot — 2026-10-23

## Decision

Keep forced alignment optional and self-hosted. MFA's Vietnamese acoustic model aligns the sample,
but the pilot cannot measure true Vietnamese word-boundary error because ViMedCSS publishes
utterance boundaries rather than word timestamps. Three English/medical tokens fell back to MFA's
unknown phone (`spn`), so TINA leaves those tokens unclickable. Do not claim that the current result
is production-accurate.

Keep Sherpa-ONNX diarization as a provisional speaker branch. The pilot is a 3-speaker AMI excerpt
with an estimated no-collar DER of 25.77%; it needs a native mixed-room recording before claiming
meeting-quality attribution.

## ViMedCSS alignment

- Sample: `Med_CS-1006-7`, 6-second Vietnamese medical utterance with English terms `hormone` and
  `estrogen`; audio and raw text came from the public test split.
- Aligner: Montreal Forced Aligner 3.3.4 with the `vietnamese_mfa` 3.0.0 acoustic model and
  pronunciation dictionary.
- Output: 24/24 tokens preserved in order, 21 tokens have acoustic timestamps, 3 tokens mapped to
  `spn` and were returned without timestamps. Token intervals are monotonic and clip-bounded.
- Cold one-segment run: about 14.3 seconds for 6 seconds of audio. A 10-segment batch with the same
  6-second sample took 14.8 seconds for 60 seconds of audio (0.25 RTF); duplicated audio makes this
  a batching/runtime smoke, not an independent accuracy benchmark.
- Word timestamp MAE: **not measurable from this dataset**. ViMedCSS has no word-level reference
  boundaries. No alignment-error number is inferred from the model's own output.

## AMI speaker baseline

- Sample: `EN2002a`, AMI test split, 120 seconds, three speakers (`MEE073`, `FEO070`, `MEE071`),
  94 annotated utterance clips.
- Audio construction: placed the three IHM speaker-headset clips on a shared 16 kHz mono timeline
  at their annotated source times. This is a reproducible three-voice reconstruction, not an
  original room-mix waveform. It has overlapping reference intervals and no fourth speaker track.
- Runtime: Sherpa-ONNX 1.13.8, Pyannote segmentation 3.0 + 3D-Speaker ERes2Net, CPU, two threads,
  fixed three clusters; 9.11 seconds for 120 seconds (0.076 RTF).
- Estimated framewise DER, 10 ms grid, speaker labels mapped by maximum overlap, no collar: 25.77%
  (29.2 s miss, 3.9 s false alarm, 4.5 s speaker confusion over 145.6 reference speaker-seconds).
  This is a small pilot estimate, not the AMI corpus benchmark protocol.

## Coverage limits

The selected corpora cover two different questions: ViMedCSS tests Vietnamese/code-switched
alignment; AMI tests multi-speaker attribution in English. They do **not** provide one
Vietnamese-English, multi-speaker reference recording. The next accuracy gate is a manually
timestamped ViMedCSS subset plus an original 2–3-speaker Vietnamese-English mix. Until then, MFA
timestamps remain optional, OOV words stay plain text, and overlap stays `unknown`.

## Sources and licenses

- [ViMedCSS dataset card](https://huggingface.co/datasets/tensorxt/ViMedCSS) and
  [paper](https://aclanthology.org/2026.lrec-1.445.pdf): CC BY 4.0 dataset card; its underlying
  source recordings still need to be treated according to their source terms.
- [AMI Hugging Face dataset](https://huggingface.co/datasets/edinburghcstr/ami) and
  [official AMI license/download page](https://groups.inf.ed.ac.uk/ami/download/): manual
  annotations and corpus released under CC BY 4.0.
- [MFA Vietnamese model](https://huggingface.co/MontrealCorpusTools/vietnamese_mfa): model card
  declares CC BY 4.0.
