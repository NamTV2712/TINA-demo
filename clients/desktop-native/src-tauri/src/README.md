# Rust source

| Module | Role |
| --- | --- |
| `main.rs` | Tauri builder, window wiring, the IPC commands the webview calls |
| `capture.rs` | microphone capture and the PCM ring buffer |
| `echo_cancel.rs` | Speex AEC on the capture path (macOS, `speex-aec` feature) |
| `resampler.rs` | Stateful SpeexDSP source resampling to 16 kHz, without Sherpa's conflicting FFT symbols |
| `meeting.rs` | detects other apps holding the microphone (CoreAudio process objects) |
| `captions.rs` | live caption subscription over the gateway `WS /ws` |
| `overlay.rs` | the always-on-top, non-focusable meeting overlay |
| `local_ws.rs` | bounded WebSocket connect (a deadline on the upgrade), shared by the caption and ingest streams |
| `ingest_auth.rs` | HMAC signing of the audio ingest request |
| `fn_key.rs` | global Fn hotkey handling |
