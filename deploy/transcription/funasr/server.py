"""Loopback OpenAI-compatible endpoint for Qwen3-ASR with FSMN-VAD."""
from __future__ import annotations

import asyncio
import logging
import json
import os
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from starlette.datastructures import MutableHeaders
from telemetry import AsrMetrics, duration

HOST = "127.0.0.1"
PORT = int(os.getenv("FUNASR_PORT", "18000"))
DEVICE = os.getenv("FUNASR_DEVICE", "mps").strip().lower()
MODEL = os.getenv("FUNASR_MODEL", "Qwen/Qwen3-ASR-0.6B").strip()
HUB = os.getenv("FUNASR_HUB", "hf").strip()
VAD_MODEL = "fsmn-vad"
MAX_AUDIO_BYTES = 25 * 1024 * 1024
MAX_INFERENCE_REQUESTS = 4  # One running request and at most three waiting.
QUEUE_TIMEOUT_SECONDS = 10.0
logger = logging.getLogger("tina.funasr")


def _load_model():
    from funasr import AutoModel

    return AutoModel(
        model=MODEL,
        hub=HUB,
        device=DEVICE,
        vad_model=VAD_MODEL,
        vad_kwargs={"hub": "ms", "max_single_segment_time": 30_000},
        disable_update=True,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Loading ASR model %s with %s on %s", MODEL, VAD_MODEL, DEVICE)
    app.state.asr = await asyncio.to_thread(_load_model)
    app.state.inference_lock = asyncio.Semaphore(1)
    app.state.inference_requests = 0
    app.state.metrics = AsrMetrics()
    logger.info("ASR and VAD models are ready")
    yield
    app.state.asr = None


app = FastAPI(title="TINA FunASR", lifespan=lifespan)


class AsrTimingMiddleware:
    """Observe ASGI send only; wrapping receive can swallow queued clients' disconnects."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] != "/v1/audio/transcriptions":
            return await self.app(scope, receive, send)
        request = Request(scope)
        try:
            request_id = str(UUID(request.headers.get("X-ASR-Request-ID", "")))
        except ValueError:
            request_id = str(uuid4())
        sample = {
            "request_id": request_id, "at_ms": int(time.time() * 1000),
            "source": request.headers.get("X-ASR-Source", "unknown"),
            "capture_ms": duration(request.headers.get("X-ASR-Capture-Ms")),
        }
        request.state.asr_timing = sample
        started = time.perf_counter()
        status_code = 500

        async def timed_send(message):
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
                sample["total_ms"] = (time.perf_counter() - started) * 1000
                headers = MutableHeaders(scope=message)
                headers["X-ASR-Request-ID"] = request_id
                headers["Server-Timing"] = ", ".join(
                    f"asr_{key[:-3]};dur={sample[key]:.3f}"
                    for key in ("queue_ms", "inference_ms", "total_ms") if sample.get(key) is not None
                )
            await send(message)

        try:
            await self.app(scope, receive, timed_send)
        except asyncio.CancelledError:
            status_code = 499
            raise
        finally:
            sample["http_status"] = status_code
            sample["total_ms"] = (time.perf_counter() - started) * 1000
            app.state.metrics.record(sample)
            logger.info(json.dumps({"event": "asr_request", **app.state.metrics.recent[-1]}))


app.add_middleware(AsrTimingMiddleware)


async def _generate(request: Request, options: dict[str, Any]):
    state = app.state
    if state.inference_requests >= MAX_INFERENCE_REQUESTS:
        raise HTTPException(status_code=429, detail="ASR queue is full", headers={"Retry-After": "1"})
    state.inference_requests += 1
    acquired = False
    worker = None
    timing = request.state.asr_timing
    queued_at = time.perf_counter()
    inference_started = None
    deadline = asyncio.get_running_loop().time() + QUEUE_TIMEOUT_SECONDS
    try:
        while not acquired:
            if await request.is_disconnected():
                raise HTTPException(status_code=499, detail="Client disconnected before inference")
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise HTTPException(status_code=503, detail="ASR queue wait expired", headers={"Retry-After": "1"})
            try:
                await asyncio.wait_for(state.inference_lock.acquire(), timeout=min(remaining, 0.1))
                acquired = True
            except asyncio.TimeoutError:
                continue
        if await request.is_disconnected():
            raise HTTPException(status_code=499, detail="Client disconnected before inference")
        timing["queue_ms"] = (time.perf_counter() - queued_at) * 1000
        inference_started = time.perf_counter()
        worker = asyncio.create_task(asyncio.to_thread(state.asr.generate, **options))
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        if worker is not None:
            # A running model thread cannot be cancelled; keep its lock and input file until it exits.
            try:
                await asyncio.shield(worker)
            except Exception:
                logger.exception("ASR inference failed after its request was cancelled")
        raise
    finally:
        if inference_started is not None:
            timing["inference_ms"] = (time.perf_counter() - inference_started) * 1000
        elif "queue_ms" not in timing:
            timing["queue_ms"] = (time.perf_counter() - queued_at) * 1000
        if acquired:
            state.inference_lock.release()
        state.inference_requests -= 1


def _segments(result: dict[str, Any], text: str, duration: float) -> list[dict[str, Any]]:
    """Keep VAD sentence times when supplied; otherwise expose a coarse window span."""
    sentences = result.get("sentence_info") or []
    segments = [
        {
            "start": min(max(float(item.get("start", 0)) / 1000, 0), duration),
            "end": min(max(float(item.get("end", 0)) / 1000, 0), duration),
            "text": str(item.get("text") or item.get("sentence") or "").strip(),
        }
        for item in sentences
        if str(item.get("text") or item.get("sentence") or "").strip()
    ]
    segments = [segment for segment in segments if segment["end"] > segment["start"]]
    return segments or ([{"start": 0.0, "end": duration, "text": text}] if text else [])


@app.get("/health")
async def health():
    return {"status": "ok", "device": _model_status()["device"], "models_loaded": ["custom"], "vad_model": VAD_MODEL}


def _model_status():
    return {
        "asr_model": MODEL, "alias": "custom", "vad_model": VAD_MODEL,
        "device": str(getattr(app.state.asr, "kwargs", {}).get("device", "unknown")),
        "requested_device": DEVICE,
    }


@app.get("/status")
async def status():
    active = int(app.state.inference_lock.locked())
    return {
        "version": "asr-status.v1", "model": _model_status(),
        "queue": {"active": active, "waiting": max(0, app.state.inference_requests - active),
                  "capacity": MAX_INFERENCE_REQUESTS, "wait_limit_ms": QUEUE_TIMEOUT_SECONDS * 1000},
        **app.state.metrics.snapshot(),
    }


@app.get("/v1/models")
async def models():
    return {"object": "list", "data": [{"id": "custom", "object": "model"}]}


@app.post("/v1/audio/transcriptions")
async def transcribe(
    request: Request,
    file: UploadFile = File(...),
    model: str = Form(default="custom"),
    language: str | None = Form(default=None),
    prompt: str | None = Form(default=None),
    response_format: str | None = Form(default="json"),
    min_silence_duration_ms: int = Form(default=800, ge=100, le=2000),
):
    if model not in ("custom", MODEL):
        raise HTTPException(status_code=400, detail="This endpoint serves the configured Qwen3-ASR model")
    if app.state.asr is None:
        raise HTTPException(status_code=503, detail="ASR model is not ready")

    content = await file.read(MAX_AUDIO_BYTES + 1)
    if len(content) < 100:
        raise HTTPException(status_code=400, detail="Empty recording")
    if len(content) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Recording too large")

    suffix = Path(file.filename or "").suffix.lower()
    if not suffix or len(suffix) > 10 or not suffix[1:].isalnum():
        suffix = ".wav"
    path = ""
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as audio_file:
            audio_file.write(content)
            path = audio_file.name
        info = sf.info(path)
        duration = float(info.duration)
        if info.frames == 0:
            raise HTTPException(status_code=400, detail="Empty recording")
        request.state.asr_timing["audio_ms"] = duration * 1000
        if duration < 0.2:
            # FSMN has no complete analysis frame for tiny recovery tails; pad only its temporary input.
            pcm, sample_rate = sf.read(path, dtype="float32", always_2d=True)
            pcm = np.pad(pcm, ((0, int(np.ceil(sample_rate * 0.2)) - len(pcm)), (0, 0)))
            sf.write(path, pcm, sample_rate, format="WAV", subtype="FLOAT")
        options: dict[str, Any] = {"input": path, "batch_size": 1, "sentence_timestamp": True,
                                   "max_end_silence_time": min_silence_duration_ms}
        if language and language.strip():
            # qwen-asr requires full names; keep the API's ISO hints portable across FunASR versions.
            hint = language.strip()
            options["language"] = {"vi": "Vietnamese", "en": "English", "auto": None}.get(hint.lower(), hint)
        if prompt and prompt.strip():
            options["context"] = prompt.strip()[-800:]
        result = await _generate(request, options)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("FunASR inference failed")
        raise HTTPException(status_code=502, detail="FunASR inference failed") from exc
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:
                logger.warning("Could not remove temporary audio file")

    item = result[0] if isinstance(result, list) and result else {}
    text = str(item.get("text") or "").strip()
    if response_format == "text":
        return JSONResponse(text)
    if response_format == "verbose_json":
        return JSONResponse({
            "task": "transcribe",
            "language": item.get("language") or language or "unknown",
            "duration": duration,
            "text": text,
            "segments": _segments(item, text, duration),
        })
    return JSONResponse({"text": text})


if __name__ == "__main__":
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
    uvicorn.run(app, host=HOST, port=PORT)
