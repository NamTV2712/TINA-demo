# tina_transcription_mlx

`main.py` is the FastAPI app: `GET /` and `GET /health` for liveness, `POST /v1/audio/transcriptions`
for transcription. It loads the model once at startup and enforces the bearer token when one is
configured.
