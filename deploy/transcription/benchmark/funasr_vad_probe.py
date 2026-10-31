"""Scratch-only Qwen worker: identical AutoModel weights with request-scoped FSMN on/off."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from contextvars import ContextVar
import importlib.util
import json
import os
from pathlib import Path
import sys
from typing import Any
from uuid import UUID

from starlette.responses import JSONResponse
from vad_range_parser import ranges as vad_ranges

SERVER = Path(__file__).resolve().parents[1] / 'funasr' / 'server.py'
QWEN_CACHE = Path.home() / '.cache/huggingface/hub/models--Qwen--Qwen3-ASR-0.6B'
QWEN_REVISION = (QWEN_CACHE / 'refs/main').read_text().strip()
assert QWEN_REVISION == os.environ.get('FUNASR_MODEL_REVISION'), 'Qwen cache revision changed after the paired plan was frozen'
QWEN_SNAPSHOT = QWEN_CACHE / 'snapshots' / QWEN_REVISION
VAD_SNAPSHOT = Path.home() / '.cache/modelscope/models/iic--speech_fsmn_vad_zh-cn-16k-common-pytorch/snapshots/master'
assert (QWEN_SNAPSHOT / 'config.json').is_file() and (QWEN_SNAPSHOT / 'model.safetensors').is_file()
assert (VAD_SNAPSHOT / 'configuration.json').is_file() and (VAD_SNAPSHOT / 'model.pt').is_file()
sys.path.insert(0, str(SERVER.parent))
spec = importlib.util.spec_from_file_location('tina_scratch_funasr', SERVER)
assert spec and spec.loader
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
contexts: dict[str, dict[str, Any]] = {}
current_probe: ContextVar[str | None] = ContextVar('current_vad_probe', default=None)
original_generate_route = server._generate
original_lifespan = server.app.router.lifespan_context
original_model_status = server._model_status


def probe_model_status():
    status = original_model_status()
    status.update(asr_model='Qwen/Qwen3-ASR-0.6B', vad_model='fsmn-vad', qwen_hf_snapshot=QWEN_REVISION, fsmn_modelscope_snapshot='master')
    return status


server.MODEL = 'Qwen/Qwen3-ASR-0.6B'
server.VAD_MODEL = str(VAD_SNAPSHOT)
server.HUB = 'hf'
server._model_status = probe_model_status


async def probe_generate(request, options):
    source = request.headers.get('x-asr-source', '')
    try:
        prefix, mode, request_id = source.split(':', 2)
    except ValueError:
        return JSONResponse({'detail': 'Scratch probe source must be vad-probe:<fsmn|off>:<request-id>'}, status_code=400)
    try:
        if str(UUID(request_id)) != request_id.lower():
            raise ValueError('Noncanonical request id')
    except ValueError:
        return JSONResponse({'detail': 'Invalid scratch VAD request id'}, status_code=400)
    if prefix != 'vad-probe' or mode not in ('fsmn', 'off'):
        return JSONResponse({'detail': 'Invalid scratch VAD mode or request id'}, status_code=400)
    context = {'mode': mode, 'vad_ranges': []}
    contexts[request_id] = context
    copied = dict(options)
    copied['_tina_vad_probe_mode'] = mode
    token = current_probe.set(request_id)
    try:
        return await original_generate_route(request, copied)
    finally:
        current_probe.reset(token)


server._generate = probe_generate


def instrument_model(asr):
    generate = asr.generate
    inference = asr.inference
    vad = asr.vad_model
    assert vad is not None, 'The paired worker must be initialized with FSMN-VAD'

    def inference_with_ranges(*args, **kwargs):
        model = kwargs.get('model')
        result = inference(*args, **kwargs)
        request_id = current_probe.get()
        context = contexts.get(request_id)
        if context is not None:
            context.setdefault('inference_calls', []).append({
                'model_class': type(model).__name__, 'vad_class': type(vad).__name__, 'is_fsmn': model is vad,
                'result_class': type(result).__name__,
                'row_keys': list(result[0]) if isinstance(result, (list, tuple)) and result and isinstance(result[0], dict) else [],
                'row_value_class': type(result[0].get('value')).__name__ if isinstance(result, (list, tuple)) and result and isinstance(result[0], dict) else None,
                'row_value_count': len(result[0].get('value', [])) if isinstance(result, (list, tuple)) and result and isinstance(result[0], dict) and hasattr(result[0].get('value'), '__len__') else None,
            })
        if model is vad:
            source_results = result if isinstance(result, (list, tuple)) else [result]
            if context is not None:
                context['vad_ranges'] = vad_ranges(source_results)
        return result

    asr.inference = inference_with_ranges

    def generate_with_vad_mode(*args, **kwargs):
        mode = kwargs.pop('_tina_vad_probe_mode')
        previous = asr.vad_model
        try:
            asr.vad_model = vad if mode == 'fsmn' else None
            return generate(*args, **kwargs)
        finally:
            asr.vad_model = previous

    asr.generate = generate_with_vad_mode


@asynccontextmanager
async def probe_lifespan(app):
    async with original_lifespan(app):
        instrument_model(app.state.asr)
        yield


server.app.router.lifespan_context = probe_lifespan


class ProbeResponseMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope.get('path') != '/v1/audio/transcriptions':
            return await self.app(scope, receive, send)
        request_id = dict(scope.get('headers', [])).get(b'x-asr-source', b'').decode().split(':')[-1]
        messages = []
        async def collect(message):
            messages.append(message)
        await self.app(scope, receive, collect)
        start = next(m for m in messages if m['type'] == 'http.response.start')
        chunks = [m.get('body', b'') for m in messages if m['type'] == 'http.response.body']
        body = b''.join(chunks)
        if start['status'] == 200 and request_id in contexts:
            try:
                payload = json.loads(body)
                payload['_vad_probe'] = contexts[request_id]
                body = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
            finally:
                contexts.pop(request_id, None)
        headers = list(start.get('headers', []))
        if start['status'] == 200:
            headers = [(k, v) for k, v in headers if k.lower() != b'content-length']
            start = {**start, 'headers': headers}
        await send(start)
        for message in messages:
            if message['type'] in ('http.response.start', 'http.response.body'):
                continue
            await send(message)
        await send({'type': 'http.response.body', 'body': body, 'more_body': False})


server.app.add_middleware(ProbeResponseMiddleware)


class ModePathMiddleware:
    """Select one mode per local HTTP path and reject mismatched source tags."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get('path', '')
        if scope['type'] == 'http' and path.startswith(('/fsmn/', '/off/')):
            mode, rest = path[1:].split('/', 1)
            headers = dict(scope.get('headers', []))
            source = headers.get(b'x-asr-source', b'').decode().split(':')
            if len(source) != 3 or source[:2] != ['vad-probe', mode]:
                response = JSONResponse({'detail': 'Probe mode path/source mismatch'}, status_code=400)
                await response(scope, receive, send); return
            routed = dict(scope); routed['path'] = '/' + rest; routed['raw_path'] = routed['path'].encode()
            routed['headers'] = [(k, v) for k, v in scope.get('headers', []) if k.lower() != b'x-asr-request-id'] + [(b'x-asr-request-id', source[2].encode())]
            await self.app(routed, receive, send); return
        await self.app(scope, receive, send)


server.app.add_middleware(ModePathMiddleware)

if __name__ == '__main__':
    assert int(os.environ.get('FUNASR_PORT', '18000')) != 18000, 'Refusing the production ASR port'
    server.uvicorn.run(server.app, host='127.0.0.1', port=int(os.environ['FUNASR_PORT']))
