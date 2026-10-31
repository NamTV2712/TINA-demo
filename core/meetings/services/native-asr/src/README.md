# native-asr source

`main.rs` is the axum service (`GET /status`, `POST /v1/audio/transcriptions`); `model.rs` loads the
model and runs VAD plus inference.
