"""Portable source identities and owner-scoped read-only replicas; never a second writer."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
from uuid import uuid4

from jsonschema import Draft202012Validator, FormatChecker
from .transcript_document import CorrectionConflict

CONTRACTS = next(root for p in Path(__file__).resolve().parents for root in (p / 'core/meetings/contracts', p / 'meetings/contracts') if (root / 'stt-foundation.v1').is_dir())
VALIDATOR = Draft202012Validator(json.loads((CONTRACTS / 'stt-foundation.v1/stt-foundation.schema.json').read_text()), format_checker=FormatChecker())


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def identity(*parts):
    return fingerprint(['tina:stt:v1', *parts])


def validate(snapshot):
    VALIDATOR.validate(snapshot)
    locator, authority = snapshot['locator'], snapshot['authority']
    mid = identity('meeting', authority['instance_id'], locator['platform'], locator['native_meeting_id'], locator['local_meeting_id'])
    if mid != snapshot['meeting_uid']:
        raise ValueError('Meeting identity mismatch')
    base = {k: v for k, v in snapshot.items() if k not in ('sequence', 'fingerprint')}
    if fingerprint(base) != snapshot['fingerprint']:
        raise ValueError('Snapshot fingerprint mismatch')
    sources = {s['source_id']: s for s in snapshot['sources']}
    if len(sources) != len(snapshot['sources']):
        raise ValueError('Duplicate source identity')
    for sid, source in sources.items():
        if sid != identity('source', mid, source['session_id'], source['channel']):
            raise ValueError('Source identity mismatch')
        if (source['start_sample'] is None) != (source['start_us'] is None):
            raise ValueError('Incomplete source anchor')
        if (source['clock_quality'] == 'unknown') != (source['start_sample'] is None):
            raise ValueError('Source clock is not verified')
    seen = set()
    for s in snapshot['segments']:
        if s['segment_uid'] in seen or s['segment_uid'] != identity('segment', mid, s['segment_id']):
            raise ValueError('Duplicate or invalid segment identity')
        seen.add(s['segment_uid'])
        if s['start_us'] >= s['end_us'] or s['revision'] != len(s['history']):
            raise ValueError('Invalid segment bounds or revision')
        if s['text'] != (s['history'][-1]['text'] if s['history'] else s['raw_text']):
            raise ValueError('Accepted text does not match revision history')
        if any(h['revision'] != i + 1 for i, h in enumerate(s['history'])):
            raise ValueError('Noncontiguous revision history')
        if any(h['kind'] == 'restore' and h['text'] != s['raw_text'] for h in s['history']):
            raise ValueError('Restore must return the original raw text')
        for ref in s['audio']:
            source = sources.get(ref['source_id'])
            if not source or ref['start_us'] >= ref['end_us'] or ref['start_us'] < s['start_us'] - 63 or ref['end_us'] > s['end_us'] + 63:
                raise ValueError('Invalid audio reference')
            if source['start_sample'] is None:
                if ref['start_sample'] is not None or ref['end_sample'] is not None:
                    raise ValueError('Legacy samples must remain unknown')
            else:
                if ref['start_sample'] is None or ref['end_sample'] is None or ref['start_sample'] >= ref['end_sample']:
                    raise ValueError('Invalid sample range')
                for edge in ('start', 'end'):
                    mapped = source['start_us'] + (ref[edge + '_sample'] - source['start_sample']) * 1_000_000 / 16000
                    if abs(mapped - ref[edge + '_us']) > 1:
                        raise ValueError('Sample timestamp drift')
    return snapshot


def replicate(data, snapshot, expected_revision):
    """Called under the destination meeting row lock. Source edits remain at the authority."""
    validate(snapshot)
    replicas = copy.deepcopy(data.get('stt_replicas') or {})
    key = snapshot['meeting_uid']
    old = replicas.get(key)
    if old == snapshot:
        return copy.deepcopy(old)
    current = old['sequence'] if old else 0
    if type(expected_revision) is not int or expected_revision != current or snapshot['sequence'] <= current:
        raise CorrectionConflict('Replica changed; reload before synchronization')
    if old:
        if old['authority'] != snapshot['authority'] or old['locator'] != snapshot['locator']:
            raise CorrectionConflict('Authority transfer is not supported')
        incoming = {s['segment_uid']: s for s in snapshot['segments']}
        source_catalog = {s['source_id']: s for s in snapshot['sources']}
        if any(source_catalog.get(s['source_id']) != s for s in old['sources']):
            raise CorrectionConflict('Source clocks cannot be removed or rewritten')
        for s in old['segments']:
            new = incoming.get(s['segment_uid'])
            if not new or any(new[k] != s[k] for k in ('segment_id', 'raw_text', 'start_us', 'end_us', 'audio')) or new['history'][:s['revision']] != s['history']:
                raise CorrectionConflict('Source history cannot be removed or rewritten')
    if key not in replicas and len(replicas) >= 16:
        raise ValueError('A meeting supports at most 16 source replicas')
    replicas[key] = copy.deepcopy(snapshot)
    data['stt_replicas'] = replicas
    return copy.deepcopy(snapshot)


def export_bot(data, meeting, doc):
    instance = data.setdefault('stt_instance_id', str(uuid4()))
    locator = {k: str(meeting[k]) for k in ('platform', 'native_meeting_id')}
    locator['local_meeting_id'] = str(meeting['id'])
    mid = identity('meeting', instance, locator['platform'], locator['native_meeting_id'], locator['local_meeting_id'])
    sources, segments = {}, []
    for s in doc['segments']:
        refs = []
        for span in s['audio']:
            session = span['session_id'] or 'recording-' + str(span['recording_id'])
            channel = 'recording-' + str(span['recording_id']) + '-pcm16k'
            sid = identity('source', mid, session, channel)
            anchor = round((s['start_ms'] - span['start_ms']) * 1000)
            source = {'source_id': sid, 'session_id': session, 'channel': channel, 'sample_rate': 16000,
                      'start_sample': 0, 'start_us': anchor, 'clock_quality': 'decoded'}
            if sid in sources and sources[sid] != source:
                raise ValueError('Recording source clock changed')
            sources[sid] = source
            left, right = round(span['start_ms'] * 16), round(span['end_ms'] * 16)
            refs.append({'source_id': sid, 'start_sample': left, 'end_sample': right,
                         'start_us': round(anchor + left * 1_000_000 / 16000), 'end_us': round(anchor + right * 1_000_000 / 16000)})
        segments.append({'segment_id': s['segment_id'], 'segment_uid': identity('segment', mid, s['segment_id']),
                         'raw_text': s['raw_text'], 'text': s['text'], 'revision': s['revision'], 'speaker': s['speaker'],
                         'start_us': round(s['start_ms'] * 1000), 'end_us': round(s['end_ms'] * 1000), 'audio': refs,
                         'history': [{k: h[k] for k in ('revision', 'text', 'kind', 'at')} for h in s['history']]})
    base = {'version': 'stt-foundation.v1', 'meeting_uid': mid, 'authority': {'system': 'meeting-api', 'instance_id': instance},
            'locator': locator, 'sources': sorted(sources.values(), key=lambda s: s['source_id']),
            'segments': sorted(segments, key=lambda s: (s['start_us'], s['segment_uid']))}
    old = data.get('stt_foundation') or {}
    digest = fingerprint(base)
    result = {**base, 'sequence': old.get('sequence', 0) + (old.get('fingerprint') != digest), 'fingerprint': digest}
    if len(json.dumps(result, ensure_ascii=False).encode()) > 4 * 1024 * 1024:
        raise ValueError('Source snapshot exceeds 4 MiB')
    validate(result)
    data['stt_foundation'] = result
    return copy.deepcopy(result)
