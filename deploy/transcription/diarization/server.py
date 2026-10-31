"""Local, bounded post-meeting diarization. Models are released after each request."""
import asyncio
import hashlib
import io
import os
from pathlib import Path
import secrets
import time
import wave

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
import numpy as np
import sherpa_onnx

app = FastAPI()
lock = asyncio.Lock()
MAX_SECONDS = 1800


def model_paths():
    directory = Path(os.environ['TINA_DIARIZATION_MODELS'])
    return directory / 'segmentation.onnx', directory / 'embedding.onnx'


def infer(content, num_speakers):
    with wave.open(io.BytesIO(content), 'rb') as wav:
        if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (16000, 1, 2) or not 0 < wav.getnframes() <= MAX_SECONDS * 16000:
            raise ValueError('Expected mono 16 kHz PCM16 WAV, at most 30 minutes')
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32) / 32768
    segmentation, embedding = model_paths()
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(segmentation), window_shift_ratio=0.1),
            num_threads=2, provider='cpu'),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(embedding), num_threads=2, provider='cpu'),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=num_speakers, threshold=0.7),
        min_duration_on=0.3, min_duration_off=0.5)
    if not config.validate():
        raise ValueError('Diarization models are unavailable')
    started = time.monotonic()
    diarizer = sherpa_onnx.OfflineSpeakerDiarization(config)
    result = diarizer.process(samples).sort_by_start_time()
    fingerprint = hashlib.sha256()
    for path in (segmentation, embedding):
        with path.open('rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                fingerprint.update(chunk)
    return {'model': 'sherpa-onnx-1.13.8-pyannote3-eres2net-cluster0.7:' + fingerprint.hexdigest(),
            'audio_sha256': hashlib.sha256(content).hexdigest(),
            'duration_ms': len(samples) / 16, 'processing_ms': (time.monotonic() - started) * 1000,
            'turns': [{'start_ms': r.start * 1000, 'end_ms': r.end * 1000, 'speaker': int(r.speaker)} for r in result]}


@app.get('/health')
def health():
    ready = bool(os.getenv('TINA_DIARIZATION_TOKEN')) and all(p.is_file() for p in model_paths())
    if not ready:
        raise HTTPException(503, 'Configure models and worker token')
    return {'status': 'ok', 'runtime': 'sherpa-onnx', 'busy': lock.locked(), 'max_seconds': MAX_SECONDS}


@app.post('/diarize')
async def diarize(file: UploadFile = File(...), num_speakers: int = Form(-1), authorization: str = Header('')):
    token = os.getenv('TINA_DIARIZATION_TOKEN', '')
    if not token or not secrets.compare_digest(authorization, 'Bearer ' + token):
        raise HTTPException(401, 'Unauthorized')
    if num_speakers != -1 and not 1 <= num_speakers <= 20:
        raise HTTPException(422, 'Use automatic or 1–20 speakers')
    if lock.locked():
        raise HTTPException(409, 'Diarization worker is busy')
    async with lock:
        content = await file.read(MAX_SECONDS * 32000 + 4097)
        await file.close()
        if len(content) > MAX_SECONDS * 32000 + 4096:
            raise HTTPException(413, 'Audio exceeds 30 minutes')
        try:
            return await asyncio.to_thread(infer, content, num_speakers)
        except (ValueError, wave.Error, EOFError) as exc:
            raise HTTPException(422, str(exc)) from exc
