"""Owner-triggered post-meeting diarization; attribution never edits audio or spoken text."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import io
import math
import os
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4, uuid5, NAMESPACE_URL
import wave

import httpx
from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator

from .refinement import ACTIVE, TERMINAL
from .speakers import _registry, _record, _event, _now, has_source_assignment
from .transcript_document import CorrectionConflict


class DiarizationOptions(BaseModel):
    num_speakers: StrictInt = Field(default=-1, ge=-1, le=20)
    model_config = ConfigDict(extra='forbid')

    @model_validator(mode='after')
    def valid_count(self):
        if self.num_speakers == 0:
            raise ValueError('Use automatic (-1) or 1–20 speakers')
        return self


class DiarizationApply(BaseModel):
    job_id: str = Field(min_length=1, max_length=128)
    model_config = ConfigDict(extra='forbid')


def validate_result(result, audio):
    if not isinstance(result, dict) or result.get('audio_sha256') != hashlib.sha256(audio).hexdigest():
        raise ValueError('Worker returned a different source hash')
    with wave.open(io.BytesIO(audio)) as wav:
        duration = wav.getnframes() / wav.getframerate() * 1000
    turns = result.get('turns')
    model = result.get('model')
    if not isinstance(model, str) or not 0 < len(model) <= 256 or not isinstance(turns, list) or len(turns) > 30000:
        raise ValueError('Invalid diarization result')
    clean = []
    for turn in turns:
        left, right, speaker = turn.get('start_ms'), turn.get('end_ms'), turn.get('speaker')
        if not all(type(t) in (int, float) and math.isfinite(t) for t in (left, right)) or not (0 <= left < duration and left < right <= duration + 20) or type(speaker) is not int or not 0 <= speaker < 100:
            raise ValueError('Invalid diarization interval')
        clean.append({'start_ms': left, 'end_ms': min(right, duration), 'speaker': speaker})
    return {'model': model, 'audio_sha256': result['audio_sha256'], 'duration_ms': duration, 'turns': clean}


def attribution(start, end, turns):
    """Use exclusive speech only; mixed/short/uncovered spans remain unknown."""
    if end - start < 500:
        return None
    relevant = [t for t in turns if t['start_ms'] < end and t['end_ms'] > start]
    edges = sorted({start, end, *(max(start, t['start_ms']) for t in relevant), *(min(end, t['end_ms']) for t in relevant)})
    owned = {}
    for a, b in zip(edges, edges[1:]):
        speakers = {t['speaker'] for t in relevant if t['start_ms'] < b and t['end_ms'] > a}
        if len(speakers) == 1:
            speaker = next(iter(speakers)); owned[speaker] = owned.get(speaker, 0) + b - a
    ranked = sorted(owned.items(), key=lambda pair: pair[1], reverse=True)
    if not ranked or ranked[0][1] < max(500, .75 * (end - start)) or (len(ranked) > 1 and ranked[1][1] > .15 * (end - start)):
        return None
    return ranked[0][0]


def word_attribution(start, end, turns):
    """Attribute only a mostly exclusive word; overlaps and weak coverage stay unknown."""
    duration = end - start
    if not math.isfinite(start) or not math.isfinite(end) or duration < 0.04:
        return None
    relevant = [t for t in turns if t['start_ms'] < end and t['end_ms'] > start]
    edges = sorted({start, end, *(max(start, t['start_ms']) for t in relevant), *(min(end, t['end_ms']) for t in relevant)})
    owned = {}
    overlap = 0.0
    for a, b in zip(edges, edges[1:]):
        speakers = {t['speaker'] for t in relevant if t['start_ms'] < b and t['end_ms'] > a}
        if len(speakers) == 1:
            speaker = next(iter(speakers))
            owned[speaker] = owned.get(speaker, 0.0) + b - a
        elif len(speakers) > 1:
            overlap += b - a
    ranked = sorted(owned.items(), key=lambda pair: pair[1], reverse=True)
    if (not ranked or overlap > .10 * duration or ranked[0][1] < .75 * duration
            or (len(ranked) > 1 and ranked[1][1] > .15 * duration)):
        return None
    return ranked[0][0]


def apply_assignments(data, meeting, job, actor):
    current = data.get('transcript_diarization')
    if not current or current['id'] != job['id'] or current['status'] != 'completed':
        raise CorrectionConflict('Diarization changed; reload before applying')
    already_applied = bool(current.get('applied_at'))
    registry = _registry(data)
    revision = max((entry['revision'] for entry in registry['speakers'].values()), default=0) + 1
    changed = {}
    applied = 0

    def register(recording_key, cluster, segment_id=None):
        key = recording_key + ':' + (str(cluster) if cluster is not None else 'unknown:' + segment_id)
        speaker_id = str(uuid5(NAMESPACE_URL, f'tina:meeting:{meeting["id"]}:diarization:{key}'))
        entry = registry['speakers'].get(speaker_id)
        if already_applied and entry is not None:
            return speaker_id
        if entry is None:
            entry = {'speaker_id': speaker_id, 'name': None, 'candidate_name': None, 'participant_id': None,
                     'manual': False, 'history': [], 'revision': revision - 1}
            registry['speakers'][speaker_id] = entry
        if speaker_id not in changed:
            entry['revision'] = max(entry.get('revision', 0), revision - 1)
            _record(entry, name=entry.get('name'), status=entry.get('status', 'unknown'), source='diarization', actor=actor)
            entry['history'][-1].update(job_id=job['id'], recording_key=recording_key, cluster=cluster)
            changed[speaker_id] = entry
        return speaker_id

    # A voice can appear only within mixed segments, without owning any whole segment.
    for recording_key in sorted({item['recording_key'] for item in current['items']}):
        for cluster in sorted({turn['speaker'] for turn in current.get('turns', [])}):
            register(recording_key, cluster)
    for item in ([] if already_applied else current['items']):
        segment_id = item['segment_id']
        old = registry['speakers'].get(registry['segments'].get(segment_id))
        # Metadata and explicit user assignments outrank acoustic clustering, including manual unknown.
        if has_source_assignment(old):
            continue
        cluster = item.get('cluster')
        # Unknown gets its own binding, so two uncertain utterances are never asserted to be one voice.
        speaker_id = register(item['recording_key'], cluster, segment_id)
        if registry['segments'].get(segment_id) == speaker_id:
            continue
        registry['segments'][segment_id] = speaker_id
        applied += 1
    data['speaker_registry'] = registry
    for entry in changed.values():
        _event(data, meeting, entry)
    if already_applied:
        return bool(changed)
    updated = copy.deepcopy(current)
    updated.update(applied_at=_now(), applied_segments=applied)
    data['transcript_diarization'] = updated
    return True


def _decode_recording(content):
    with tempfile.TemporaryDirectory(prefix='tina-diarization-') as directory:
        path = Path(directory) / 'recording'; path.write_bytes(content)
        proc = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', str(path), '-t', '1800.1',
                               '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], capture_output=True, check=True, timeout=120)
    if not 0 < len(proc.stdout) <= 1800 * 32000:
        raise ValueError('Recordings must contain audio and be at most 30 minutes')
    out = io.BytesIO()
    with wave.open(out, 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000); wav.writeframes(proc.stdout)
    return out.getvalue()


class BotDiarizer:
    def __init__(self, store, refiner):
        self.store, self.refiner = store, refiner
        self.active = None
        self.task = None
        self.lock = refiner.lock

    async def current(self, user, mid):
        if self.active and self.active[:2] == (user, mid):
            return copy.deepcopy(self.active[2])
        job = await self.store.get_diarization(user, mid)
        if job and job['status'] in ACTIVE:
            job.update(status='interrupted', error='Worker restarted; run speaker analysis again.')
            await self.store.save_diarization(user, mid, job)
        return job

    async def recording(self, user, mid, rid):
        from ..recordings.service import finalize_master
        if await self.refiner.repo.owner_of(mid) != user:
            raise ValueError('Recording is unavailable')
        recordings = await self.refiner.repo.get_recordings(mid)
        recording = next((r for r in recordings if r['id'] == rid and r.get('status') == 'completed'), None)
        if not recording or type(recording.get('audio_start_ms')) not in (float, int) or not math.isfinite(recording['audio_start_ms']):
            raise ValueError('Recording has no verified audio origin')
        media = next((m for m in recording.get('media_files', []) if m.get('type') == 'audio'), {})
        if media.get('chunk_seq') is not None:
            prefix = media.get('storage_path', '').rsplit('/', 1)[0]
            keys = await self.refiner.storage.list(prefix)
            sequences = sorted(int(Path(k).stem) for k in keys if Path(k).stem.isdecimal())
            if sequences != list(range(int(media['chunk_seq']) + 1)):
                raise ValueError('Recording has missing chunks')
        key = await finalize_master(self.refiner.repo, self.refiner.storage, meeting_id=mid, recording_id=rid)
        if not key or await self.refiner.storage.size(key) > 256 * 1024 ** 2:
            raise ValueError('Recording is unavailable or exceeds 256 MiB')
        content = await self.refiner.storage.get(key)
        try:
            return await asyncio.to_thread(_decode_recording, content)
        except (OSError, subprocess.SubprocessError) as exc:
            raise ValueError('Recording cannot be decoded') from exc

    async def start(self, user, mid, options):
        async with self.lock:
            if (self.active or self.refiner.active or getattr(getattr(self.refiner, "aligner", None), "active", None)
                    or await self.store.refinement_live()):
                raise CorrectionConflict('Wait for live meetings and background audio processing to stop')
            doc = await self.store.get_transcript_document(user, mid)
            if not doc or doc['status'] not in TERMINAL:
                raise CorrectionConflict('Stop the meeting before speaker analysis')
            if not doc['segments'] or len(doc['segments']) > 2000:
                raise ValueError('Speaker analysis requires 1–2000 transcript segments')
            if not os.getenv('DIARIZATION_SERVICE_URL') or not os.getenv('DIARIZATION_SERVICE_TOKEN'):
                raise ValueError('Configure the local diarization worker first')
            await self.current(user, mid)
            job = {'id': str(uuid4()), 'status': 'running', 'created_at': _now(), 'num_speakers': options.num_speakers,
                   'recordings': [], 'items': []}
            previous_job = await self.store.get_diarization(user, mid)
            await self.store.save_diarization(user, mid, job, expected_job_id=previous_job["id"] if previous_job else None)
            self.active = (user, mid, job)
            self.task = asyncio.create_task(self.run(user, mid, doc, job))
            return copy.deepcopy(job)

    async def run(self, user, mid, doc, job):
        try:
            ids = sorted({s['audio'][0]['recording_id'] for s in doc['segments'] if len(s['audio']) == 1})
            if not ids or len(ids) > 10:
                raise ValueError('Use 1–10 completed, clocked recordings')
            pcm = io.BytesIO()
            offsets = {}
            for rid in ids:
                while await self.store.refinement_live() and job['status'] != 'cancelling':
                    job['status'] = 'paused'; await self.store.save_diarization(user, mid, job); await asyncio.sleep(.5)
                if job['status'] == 'cancelling':
                    return
                job['status'] = 'running'
                audio = await self.recording(user, mid, rid)
                offsets[rid] = pcm.tell() / 32
                with wave.open(io.BytesIO(audio)) as wav:
                    duration_ms = wav.getnframes() / 16
                    if pcm.tell() + wav.getnframes() * 2 > 1800 * 32000:
                        raise ValueError('Speaker analysis is limited to 30 minutes total')
                    pcm.write(wav.readframes(wav.getnframes()))
                job['recordings'].append({'recording_id': rid, 'audio_sha256': hashlib.sha256(audio).hexdigest(),
                                          'duration_ms': duration_ms, 'offset_ms': offsets[rid]})
                # One shared clustering pass keeps voice labels consistent across recording sessions.
                pcm.write(b'\0' * 16000)
            if pcm.tell() > 1800 * 32000:
                raise ValueError('Speaker analysis is limited to 30 minutes total')
            out = io.BytesIO()
            with wave.open(out, 'wb') as wav:
                wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000); wav.writeframes(pcm.getbuffer())
            audio = out.getvalue()
            while await self.store.refinement_live() and job['status'] != 'cancelling':
                job['status'] = 'paused'; await self.store.save_diarization(user, mid, job); await asyncio.sleep(.5)
            if job['status'] == 'cancelling':
                return
            job['status'] = 'running'
            async with httpx.AsyncClient(timeout=600, follow_redirects=False) as client:
                response = await client.post(os.environ['DIARIZATION_SERVICE_URL'].rstrip('/') + '/diarize',
                    headers={'Authorization': 'Bearer ' + os.environ['DIARIZATION_SERVICE_TOKEN']},
                    data={'num_speakers': str(job['num_speakers'])}, files={'file': ('recording.wav', audio, 'audio/wav')})
                response.raise_for_status()
            result = validate_result(response.json(), audio)
            if job['status'] == 'cancelling':
                return
            job.update(model=result['model'], turns=result['turns'])
            recording_key = f'{result["audio_sha256"]}:{result["model"]}:{job["num_speakers"]}'
            for segment in doc['segments']:
                spans = segment['audio']
                if len(spans) != 1 or spans[0]['recording_id'] not in offsets:
                    continue
                span = spans[0]
                recording = next(r for r in job['recordings'] if r['recording_id'] == span['recording_id'])
                if span['end_ms'] > recording['duration_ms'] + 20:
                    continue
                offset = offsets[span['recording_id']]
                job['items'].append({'segment_id': segment['segment_id'], 'recording_key': recording_key,
                    'cluster': attribution(offset + span['start_ms'], offset + span['end_ms'], result['turns'])})
            job['status'] = 'cancelled' if job['status'] == 'cancelling' else 'completed'
        except asyncio.CancelledError:
            job['status'] = 'interrupted'
        except Exception:
            job.update(status='failed', error='Speaker analysis failed. Check recording coverage and local worker; original transcript is unchanged.')
        finally:
            if job['status'] == 'cancelling':
                job['status'] = 'cancelled'
            try:
                await self.store.save_diarization(user, mid, job)
            finally:
                self.active = None

    async def cancel(self, user, mid):
        if self.active and self.active[:2] == (user, mid):
            self.active[2]['status'] = 'cancelling'
        return await self.current(user, mid)

    async def apply(self, user, mid, command):
        job = await self.current(user, mid)
        if not job or job['id'] != command.job_id or job['status'] != 'completed':
            raise CorrectionConflict('No completed speaker analysis to apply')
        # Verify source audio before the locked commit; existing manual assignments are checked under lock.
        for recording in job['recordings']:
            audio = await self.recording(user, mid, recording['recording_id'])
            if hashlib.sha256(audio).hexdigest() != recording['audio_sha256']:
                raise CorrectionConflict('Source audio changed; run speaker analysis again')
        return await self.store.apply_diarization(user, mid, job)

    async def close(self):
        if self.task and not self.task.done():
            self.task.cancel(); await self.task
