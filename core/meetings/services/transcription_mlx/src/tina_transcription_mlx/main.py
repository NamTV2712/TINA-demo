"""OpenAI-compatible ASR endpoint backed by mlx-whisper on Apple Silicon."""
from __future__ import annotations

import hmac
import logging
import os
import tempfile
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import mlx_whisper
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse, Response

log = logging.getLogger("tina_transcription_mlx")
MODEL_ID = os.environ.get("TINA_MLX_MODEL", "mlx-community/whisper-large-v3-turbo")
API_TOKEN = os.environ.get("API_TOKEN", "").strip()
MAX_AUDIO_BYTES = 25 * 1024 * 1024
_MODEL_LOCK = threading.Lock()
_READY = False

if not API_TOKEN:
    raise RuntimeError("API_TOKEN is required for the Apple STT endpoint")


def _check_token(request: Request) -> None:
    supplied = request.headers.get("authorization", "")
    if not supplied.startswith("Bearer ") or not hmac.compare_digest(supplied[7:], API_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid or missing API token")


def _warm_model() -> None:
    global _READY
    # Download/load the checkpoint before health goes green, not during a meeting's first chunk.
    with _MODEL_LOCK:
        mlx_whisper.transcribe(
            np.zeros(16_000, dtype=np.float32),
            path_or_hf_repo=MODEL_ID,
            verbose=False,
            condition_on_previous_text=False,
        )
    _READY = True
    log.info("Loaded %s with MLX/Metal", MODEL_ID)


@asynccontextmanager
async def lifespan(_: FastAPI):
    _warm_model()
    yield


app = FastAPI(title="TINA Apple MLX Transcription Service", lifespan=lifespan)


@app.get("/")
def info() -> dict:
    return {"service": "TINA Apple MLX Transcription Service", "model": MODEL_ID,
            "device": "metal", "status": "ready" if _READY else "loading",
            "endpoints": {"transcribe": "/v1/audio/transcriptions", "health": "/health"}}


@app.get("/health")
def health() -> JSONResponse:
    body = {"status": "healthy" if _READY else "loading", "model": MODEL_ID,
            "device": "metal", "gpu_available": True}
    return JSONResponse(body, status_code=200 if _READY else 503)


@app.post("/v1/audio/transcriptions")
def transcribe_audio(
    request: Request,
    file: UploadFile = File(...),
    requested_model: str = Form(..., alias="model"),
    language: Optional[str] = Form(None),
    prompt: Optional[str] = Form(None),
    response_format: str = Form("verbose_json"),
    timestamp_granularities: str = Form("segment"),
    temperature: str = Form("0"),
) -> Response:
    _check_token(request)
    audio = file.file.read(MAX_AUDIO_BYTES + 1)
    if len(audio) < 100:
        raise HTTPException(status_code=400, detail="Empty recording")
    if len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Recording too long")

    path: Optional[str] = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp:
            temp.write(audio)
            path = temp.name
        options: dict = {
            "path_or_hf_repo": MODEL_ID,
            "verbose": False,
            "word_timestamps": "word" in timestamp_granularities.lower(),
            "condition_on_previous_text": False,
            "temperature": float(temperature or "0"),
        }
        if language and language != "auto":
            options["language"] = language
        if prompt:
            options["initial_prompt"] = prompt[:800]
        # MLX Whisper shares one model on one Apple GPU. Fail fast instead of letting concurrent
        # meeting windows occupy request threads while they wait for that device.
        if not _MODEL_LOCK.acquire(blocking=False):
            raise HTTPException(status_code=503, detail="Apple MLX transcription service is busy")
        try:
            result = mlx_whisper.transcribe(path, **options)
        finally:
            _MODEL_LOCK.release()
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Apple MLX transcription failed")
        raise HTTPException(status_code=502, detail="Apple MLX transcription failed") from exc
    finally:
        if path:
            Path(path).unlink(missing_ok=True)

    text = str(result.get("text", "")).strip()
    if response_format == "text":
        return PlainTextResponse(text)
    if response_format not in ("json", "verbose_json"):
        raise HTTPException(status_code=400, detail=f"Unsupported response_format: {response_format}")
    segments = []
    for index, segment in enumerate(result.get("segments", [])):
        out = {"id": index, "start": segment.get("start", 0), "end": segment.get("end", 0),
               "text": segment.get("text", "")}
        if "word" in timestamp_granularities.lower():
            out["words"] = [
                {key: word[key] for key in ("word", "start", "end", "probability") if key in word}
                for word in segment.get("words", [])
            ]
        segments.append(out)
    body = {"text": text, "segments": segments}
    if result.get("language"):
        body["language"] = result["language"]
    return JSONResponse(body)
