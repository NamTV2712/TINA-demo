# transcription_mlx — Apple Silicon ASR endpoint

`mlx-whisper` behind an OpenAI-compatible FastAPI surface, so the same STT client that talks to a
remote backend can run on-device on an M-series Mac. The app is `src/tina_transcription_mlx/`;
`uv.lock` pins the environment.
