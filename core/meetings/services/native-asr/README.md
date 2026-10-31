# TINA native ASR

Rust service: Silero VAD → Qwen3-ASR-0.6B INT8 via sherpa-onnx 1.13.8, CPU only,
two inference threads. Implements the existing OpenAI transcription boundary and
`meetings/contracts/asr-status.v1`; no Python/PyTorch is loaded in this process.

## Build and run

From the repository root:

```sh
python3 deploy/transcription/sherpa/install-models.py
cargo build --release --manifest-path core/meetings/services/native-asr/Cargo.toml -j 2
sh deploy/transcription/sherpa/start.sh
```

Model assets are checksum-pinned to the upstream `asr-models` release and cached under
ignored `deploy/transcription/models/sherpa`. `Cargo.lock` pins the native runtime crate.
Builds download sherpa's matching upstream native libraries. The model cache is ~1 GB;
file size is not a claim about resident RAM.

The Rust wrapper is pinned locally under `vendor/sherpa-onnx` with one offline-result
JSON compatibility patch: literal control characters in native text/token strings
are escaped before strict deserialization. The native library stays at unmodified
`sherpa-onnx-sys` 1.13.8. See `vendor/sherpa-onnx/TINA-PATCH.md` for provenance and tests.
Malformed results still fail; this does not convert inference errors into empty success.

Endpoints bind **127.0.0.1:18001**: `/health`, `/status`, `/v1/models`, and
`POST /v1/audio/transcriptions`. Override port with `TINA_SHERPA_PORT`, model directory
with `TINA_SHERPA_MODEL_DIR`, or Silero file with `TINA_SILERO_MODEL`.

The model alias is `custom`. Input is WAV (integer PCM or float32), 0–90 seconds,
up to 25 MiB, 1–8 channels, 8–192 kHz. It is downmixed and resampled to 16 kHz.
Unsupported encodings fail explicitly. Supports `json`, `verbose_json`, `text` and
optional `language` (`vi`/`en` are mapped to Qwen's language names). Auto language is
the default. The OpenAI `prompt` field is accepted but not used: prior transcript
context is not equivalent to sherpa's hotword list.

## Timing and resource limits

One resident model, one running inference and at most three waiting requests. A
waiting job expires after 10 seconds; closed response receivers are skipped before
inference. Running inference cannot safely be interrupted. HTTP IDs, source and
capture-lag headers match the existing FunASR service. Diagnostics keep 100 timing
samples; they contain no audio or transcript text and reset on restart.

Before Silero, quiet input windows above RMS `0.0001` are raised toward RMS `0.01`,
with gain capped at 40x and output peak capped at 0.95. Normal windows at RMS `0.01`
or above, near-zero residue and digital silence retain their original level. Windows
already containing an out-of-range peak are never attenuated by this step. This is
window normalization, not noise suppression; it does not improve signal-to-noise ratio.

Silero detects speech at threshold 0.5, minimum speech 150 ms, minimum silence
350 ms, and splits continuous speech at 8 seconds. Segment start/end are VAD offsets
on the **original input timeline**. They are not forced alignment or word timestamps.
Qwen is an offline recognizer; this is bounded audio-window processing, not token streaming.

Each successful decode logs `asr_audio` with the request UUID, input RMS/peak, applied
gain, and total VAD speech duration/segment count. These diagnostics contain no audio
or transcript text. The `/status` and transcription HTTP contracts are unchanged.

For an opt-in comparison with raw VAD and ASR without VAD, supply a local JSON array
of WAV cases (`id`, `path`, `role`; optional `direct: true`):

```sh
cargo run --release --example diagnose-levels --manifest-path core/meetings/services/native-asr/Cargo.toml -- /path/to/cases.json > /path/to/results.jsonl
```

Stop the serving ASR while running this example to avoid loading a second Qwen model.
The example never opens a microphone. Roles `silence` and `control` assert empty text;
all cases assert bounded gain and unchanged duration. Explicit direct-ASR comparisons
bypass VAD only in the example and can produce text on non-speech; they do not change
the service pipeline. Results can contain transcripts, so keep output local.

Select **Sherpa · Qwen INT8 + Silero** in Terminal Settings → Models → Global defaults,
after setting Sherpa URL to `http://host.docker.internal:18001`. Native Desktop uses
`TRANSCRIPTION_SERVICE_URL=http://127.0.0.1:18001` and `TRANSCRIPTION_MODEL=custom`.
The native capture app uses Desktop's existing `capture.v1` ingest and transcript store.
The selected endpoint governs bot/dictation calls; saving settings does not start/stop
operating-system processes. Stop the unused ASR process to release its model RAM.

## Tiếng Việt

Backend native chạy Silero + Qwen INT8 trên CPU, chỉ mở `127.0.0.1:18001`.
Chọn cấu hình Sherpa trong Global defaults; cấu hình FunASR + FSMN vẫn được giữ để
quay lại. Chỉ nên chạy một backend để tiết kiệm RAM. Timestamp ở cấp đoạn tiếng nói,
không phải từng từ; độ chính xác Anh–Việt và latency cần đo trên audio thực tế.

Wrapper Rust có bản vá cục bộ để đọc JSON chứa xuống dòng do Sherpa xuất ra, tránh
HTTP 502 ở trường hợp này. Giữ nguyên thư viện native và model; lỗi decode thật vẫn
được trả về, không đổi thành transcript rỗng.

Âm thanh nhỏ được tăng âm có giới hạn trước Silero; giữ nguyên ngưỡng VAD 0,5 và
không tăng digital silence hay phần dư gần bằng không. Log `asr_audio` chỉ chứa mức
âm lượng, gain và thống kê VAD, không chứa lời nói. Cách này không lọc tiếng ồn và
cần kiểm tra lại với giọng nhỏ thật trên microphone; clip giảm âm lượng chỉ là đối chứng.

Upstream: https://github.com/k2-fsa/sherpa-onnx/tree/master/rust-api-examples
and https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE .
