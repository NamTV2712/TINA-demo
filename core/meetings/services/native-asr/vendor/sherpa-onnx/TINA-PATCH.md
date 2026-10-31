# Local wrapper patch / Bản vá wrapper

Source: crates.io `sherpa-onnx` 1.13.8, Apache-2.0. Original copyright/license
and source are preserved; `UPSTREAM-SHA256.json` records the original file hashes.
The C runtime remains the unmodified registry `sherpa-onnx-sys =1.13.8`.

Changed files: `src/offline_asr.rs` calls new `src/result_json.rs`; `src/lib.rs`
declares that private module. No public Rust API is changed.

Native offline-result JSON can contain literal ASCII controls in decoded text/token
strings. Strict serde parsing rejects these results and the safe wrapper returns None,
which the service reports as HTTP 502. Escape only those controls inside strings
before the existing serde deserialization. Valid escape sequences, Unicode, JSON
layout and field validation retain their meaning; other malformed results still fail.
No raw result text is logged or written to disk by the patched wrapper.

Regression evidence: FLEURS `vi_vn-11595830277981788585`, waveform SHA-256 in the
existing dataset manifest. The native result had literal newlines in text and a token.
Unit tests use synthetic strings, so no dataset audio/transcript is bundled here.

Run tests from the TINA repository root:

```sh
cargo test --manifest-path core/meetings/services/native-asr/vendor/sherpa-onnx/Cargo.toml --lib result_json
```

shortcut: local compatibility repair for the pinned 1.13.8 native JSON serializer;
remove this vendored wrapper after upgrading to an upstream release that passes
these parser cases and the real regression clip without the patch.

## Tiếng Việt

Bản vá chỉ escape ký tự điều khiển chưa được escape bên trong chuỗi JSON đầu ra.
Không đổi model, ngưỡng VAD hoặc thư viện C/C++; dữ liệu sai cấu trúc khác vẫn báo lỗi.
