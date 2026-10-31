"""Authenticated HTTP-window ASR: FunASR FSMN-VAD + Sherpa-ONNX Gipformer 1.5."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import UUID, uuid4

import soundfile as sf
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse
from starlette.datastructures import MutableHeaders

from engine import AudioInputError, GipformerEngine, MODEL
from telemetry import AsrMetrics, duration

PORT = int(os.getenv('TINA_GIPFORMER_PORT', '18002'))
HOST = os.getenv('TINA_GIPFORMER_HOST', '127.0.0.1')
MAX_BYTES = 25 * 1024 * 1024
CAPACITY = 4
WAIT_SECONDS = 10.0
logger = logging.getLogger('tina.gipformer')


@asynccontextmanager
async def lifespan(app):
    token = os.getenv('TINA_GIPFORMER_TOKEN', '')
    if len(token) < 32:
        raise RuntimeError('Set a private TINA_GIPFORMER_TOKEN of at least 32 characters')
    app.state.token = token
    directory = Path(os.getenv('TINA_GIPFORMER_MODEL_DIR', str(Path(__file__).resolve().parent.parent / 'models/gipformer-fsmn')))
    app.state.engine = await asyncio.to_thread(GipformerEngine.load, directory)
    app.state.lock = asyncio.Semaphore(1)
    app.state.requests = 0
    app.state.metrics = AsrMetrics()
    logger.info('Gipformer INT8 + FSMN ready on CPU')
    yield
    app.state.engine = None


app = FastAPI(title='TINA Gipformer + FSMN', lifespan=lifespan)


class RequestBoundary:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope['path'] != '/v1/audio/transcriptions':
            return await self.app(scope, receive, send)
        headers = MutableHeaders(scope=scope)
        token = getattr(app.state, 'token', '')
        if not token or not secrets.compare_digest(headers.get('authorization', '').encode('utf-8'), ('Bearer ' + token).encode('utf-8')):
            return await JSONResponse({'detail': 'Unauthorized'}, status_code=401)(scope, receive, send)
        try:
            if int(headers.get('content-length', '0')) > MAX_BYTES + 1024 * 1024:
                return await JSONResponse({'detail': 'Recording too large'}, status_code=413)(scope, receive, send)
        except ValueError:
            return await JSONResponse({'detail': 'Invalid content length'}, status_code=400)(scope, receive, send)
        try:
            request_id = str(UUID(headers.get('x-asr-request-id', '')))
        except ValueError:
            request_id = str(uuid4())
        sample = {'request_id': request_id, 'at_ms': int(time.time() * 1000),
                  'source': headers.get('x-asr-source', 'unknown'), 'capture_ms': duration(headers.get('x-asr-capture-ms'))}
        scope.setdefault('state', {})['asr_timing'] = sample
        started, status = time.perf_counter(), 500
        received_bytes = 0

        async def bounded_receive():
            nonlocal received_bytes
            message = await receive()
            if message['type'] == 'http.request':
                received_bytes += len(message.get('body', b''))
                if received_bytes > MAX_BYTES + 1024 * 1024:
                    raise HTTPException(413, 'Recording too large')
            return message

        async def timed_send(message):
            nonlocal status
            if message['type'] == 'http.response.start':
                status = message['status']
                sample['total_ms'] = (time.perf_counter() - started) * 1000
                result = MutableHeaders(scope=message)
                result['X-ASR-Request-ID'] = request_id
                result['Server-Timing'] = ', '.join(f'asr_{k[:-3]};dur={sample[k]:.3f}' for k in ('queue_ms', 'inference_ms', 'total_ms') if sample.get(k) is not None)
            await send(message)

        try:
            await self.app(scope, bounded_receive, timed_send)
        except asyncio.CancelledError:
            status = 499
            raise
        finally:
            sample['http_status'], sample['total_ms'] = status, (time.perf_counter() - started) * 1000
            app.state.metrics.record(sample)
            logger.info(json.dumps({'event': 'asr_request', **app.state.metrics.recent[-1]}))


app.add_middleware(RequestBoundary)


def model_status():
    return {'asr_model': MODEL, 'alias': 'custom', 'vad_model': 'fsmn-vad', 'device': 'cpu', 'requested_device': 'cpu'}


@app.get('/health')
async def health():
    return {'status': 'ok', 'device': 'cpu', 'models_loaded': [MODEL], 'vad_model': 'fsmn-vad'}


@app.get('/status')
async def status():
    active = int(app.state.lock.locked())
    return {'version': 'asr-status.v1', 'model': model_status(),
            'queue': {'active': active, 'waiting': max(0, app.state.requests - active), 'capacity': CAPACITY, 'wait_limit_ms': WAIT_SECONDS * 1000},
            **app.state.metrics.snapshot()}


@app.get('/capabilities')
async def capabilities():
    return {'model': MODEL, 'runtime': 'sherpa-onnx', 'vad_runtime': 'funasr', 'languages': ['vi'],
            'language_detection': False, 'prompt': False, 'word_timestamps': False, 'streaming': False,
            'timestamp_kind': 'vad-speech-interval', 'max_audio_seconds': 90}


@app.get('/v1/models')
async def models():
    return {'object': 'list', 'data': [{'id': 'custom', 'object': 'model'}, {'id': MODEL, 'object': 'model'}]}


async def infer(request, content, silence_ms):
    state = app.state
    if state.requests >= CAPACITY:
        raise HTTPException(429, 'ASR queue is full', headers={'Retry-After': '1'})
    state.requests += 1
    worker, acquired, inference_start = None, False, None
    queued_at = time.perf_counter()
    timing = request.state.asr_timing
    try:
        while not acquired:
            if await request.is_disconnected():
                raise HTTPException(499, 'Client disconnected before inference')
            remaining = WAIT_SECONDS - (time.perf_counter() - queued_at)
            if remaining <= 0:
                raise HTTPException(503, 'ASR queue wait expired', headers={'Retry-After': '1'})
            try:
                await asyncio.wait_for(state.lock.acquire(), timeout=min(remaining, .1))
                acquired = True
            except asyncio.TimeoutError:
                pass
        if await request.is_disconnected():
            raise HTTPException(499, 'Client disconnected before inference')
        timing['queue_ms'] = (time.perf_counter() - queued_at) * 1000
        inference_start = time.perf_counter()
        worker = asyncio.create_task(asyncio.to_thread(state.engine.transcribe, content, silence_ms))
        result = await asyncio.shield(worker)
        timing['audio_ms'] = result['duration'] * 1000
        return result
    except asyncio.CancelledError:
        if worker is not None:
            # Native model threads must finish before another request uses their state.
            try:
                await asyncio.shield(worker)
            except Exception:
                logger.error('Inference failed after request cancellation')
        raise
    finally:
        if inference_start is not None:
            timing['inference_ms'] = (time.perf_counter() - inference_start) * 1000
        elif 'queue_ms' not in timing:
            timing['queue_ms'] = (time.perf_counter() - queued_at) * 1000
        if acquired:
            state.lock.release()
        state.requests -= 1


@app.post('/v1/audio/transcriptions')
async def transcribe(request: Request, file: UploadFile = File(...), model: str = Form('custom'),
                     language: str | None = Form(None), prompt: str | None = Form(None),
                     response_format: str = Form('json'), min_silence_duration_ms: int = Form(800, ge=100, le=2000)):
    # Legacy Custom endpoint callers send whisper-1; this is only a compatibility alias.
    if model not in ('custom', 'whisper-1', MODEL):
        raise HTTPException(400, 'This endpoint serves Gipformer 1.5')
    if language and language.strip().lower() not in ('vi', 'vietnamese', 'auto'):
        raise HTTPException(422, 'Gipformer is a Vietnamese model; forced language is unsupported')
    if response_format not in ('json', 'verbose_json', 'text'):
        raise HTTPException(422, 'Unsupported response format')
    try:
        content = await file.read(MAX_BYTES + 1)
    finally:
        await file.close()
    if not content:
        raise HTTPException(400, 'Empty recording')
    if len(content) > MAX_BYTES:
        raise HTTPException(413, 'Recording too large')
    try:
        result = await infer(request, content, min_silence_duration_ms)
    except (AudioInputError, sf.LibsndfileError):
        raise HTTPException(400, 'Unsupported or malformed audio')
    except HTTPException:
        raise
    except Exception:
        logger.error('Gipformer/FSMN inference failed')
        raise HTTPException(502, 'Gipformer/FSMN inference failed')
    if response_format == 'text':
        return PlainTextResponse(result['text'])
    if response_format == 'verbose_json':
        # "vi" is an explicit caller hint, never a fabricated language detection result.
        return {'task': 'transcribe', 'language': 'vi' if language and language.lower() in ('vi', 'vietnamese') else 'unknown', **result}
    return {'text': result['text']}


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host=HOST, port=PORT, access_log=False)
