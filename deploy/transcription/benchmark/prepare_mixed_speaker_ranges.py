"""Freeze annotation-selected AMI excerpts from official, byte-ranged mono PCM WAVs."""
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import random
import re
import struct
import sys
from urllib.request import Request, urlopen

import numpy as np
import soundfile as sf

from mixed_speaker import annotations, select

RATE = 16000
SEED = 20261026
BASE = 'https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/{meeting}/audio/'
STREAMS = ('Mix-Headset', 'Headset-0', 'Headset-1', 'Headset-2', 'Headset-3')


def sha256_file(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def parse_pcm_wav_header(prefix, total_bytes):
    if prefix[:4] != b'RIFF' or prefix[8:12] != b'WAVE':
        raise ValueError('Expected RIFF/WAVE source')
    riff_bytes = struct.unpack_from('<I', prefix, 4)[0] + 8
    pos, fmt, data = 12, None, None
    while pos + 8 <= len(prefix):
        chunk_id = prefix[pos:pos + 4]
        size = struct.unpack_from('<I', prefix, pos + 4)[0]
        start = pos + 8
        if chunk_id == b'fmt ':
            if size < 16 or start + 16 > len(prefix):
                raise ValueError('Incomplete WAV fmt chunk')
            fmt = struct.unpack_from('<HHIIHH', prefix, start)
        if chunk_id == b'data':
            data = (start, size)
            break
        pos = start + size + (size & 1)
    if fmt is None or data is None:
        raise ValueError('WAV header is missing fmt/data chunk')
    encoding, channels, rate, _, align, bits = fmt
    offset, data_bytes = data
    if (encoding, channels, rate, align, bits) != (1, 1, RATE, 2, 16):
        raise ValueError(f'Expected mono PCM16/{RATE} Hz, got {(encoding, channels, rate, align, bits)}')
    if riff_bytes != total_bytes or offset + data_bytes != total_bytes or data_bytes % align:
        raise ValueError('WAV RIFF/data size does not match remote entity length')
    return {'bytes': total_bytes, 'data_offset': offset, 'data_bytes': data_bytes,
            'frames': data_bytes // align, 'samplerate': rate, 'channels': channels,
            'etag': None, 'last_modified': None, 'url': None}


def _content_range(value):
    match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', value or '')
    if not match:
        raise ValueError(f'Invalid/missing Content-Range: {value!r}')
    return tuple(map(int, match.groups()))


def inspect_remote(url):
    request = Request(url, headers={'Range': 'bytes=0-65535', 'User-Agent': 'TINA-Research-Benchmark/1.0'})
    with urlopen(request, timeout=90) as response:
        if response.status != 206:
            raise ValueError(f'Range request returned HTTP {response.status}')
        first, last, total = _content_range(response.headers.get('Content-Range'))
        if first != 0 or last >= total:
            raise ValueError('Unexpected WAV header range')
        header = response.read(last - first + 1)
        if len(header) != last - first + 1:
            raise ValueError('Short WAV header range')
        info = parse_pcm_wav_header(header, total)
        info.update(url=url, etag=response.headers.get('ETag'), last_modified=response.headers.get('Last-Modified'))
        return info


def fetch_pcm_range(source, start_sample, end_sample):
    if not 0 <= start_sample < end_sample <= source['frames']:
        raise ValueError('PCM range is outside source WAV')
    start = source['data_offset'] + start_sample * 2
    end = source['data_offset'] + end_sample * 2 - 1
    request = Request(source['url'], headers={'Range': f'bytes={start}-{end}', 'User-Agent': 'TINA-Research-Benchmark/1.0'})
    with urlopen(request, timeout=90) as response:
        if response.status != 206 or _content_range(response.headers.get('Content-Range')) != (start, end, source['bytes']):
            raise ValueError('Server did not return the requested source byte range')
        etag = response.headers.get('ETag')
        if source['etag'] and etag != source['etag']:
            raise ValueError('Remote ETag changed between header and PCM range reads')
        raw = response.read(end - start + 1)
        if len(raw) != end - start + 1:
            raise ValueError('Short PCM range response')
    return raw, {'start_sample': start_sample, 'end_sample': end_sample,
        'start_byte': start, 'end_byte_inclusive': end, 'bytes': len(raw),
        'sha256': hashlib.sha256(raw).hexdigest()}


def mix_components(headsets):
    components = {speaker: np.rint(samples.astype(np.float64) / 4).astype(np.int16)
                  for speaker, samples in headsets.items()}
    mixed = sum((samples.astype(np.int32) for samples in components.values()), np.zeros_like(next(iter(components.values())), dtype=np.int32))
    if mixed.min() < -32768 or mixed.max() > 32767:
        raise ValueError('Controlled headset mix clips; keep the frozen common gain')
    return components, mixed.astype(np.int16)


def prepare(meeting, annotation_zip, output):
    meeting = str(meeting)
    annotation_zip = Path(annotation_zip).expanduser().resolve()
    output = Path(output).expanduser().resolve()
    repo = Path(__file__).resolve().parents[3]
    if output.exists() or output == repo or repo in output.parents:
        raise ValueError('Choose a fresh output directory outside the checkout')

    mapping, words = annotations(annotation_zip, meeting)
    cases, warmup = select(words)
    base = BASE.format(meeting=meeting)
    sources = {name: inspect_remote(base + f'{meeting}.{name}.wav') for name in STREAMS}
    identities = {(s['frames'], s['data_offset'], s['bytes']) for s in sources.values()}
    if len(identities) != 1:
        raise ValueError('Mix and headset recordings are not synchronized same-length WAVs')

    selected = [{'role': 'warmup', **warmup}, *[{'role': 'test', **case} for case in cases]]
    requests = []
    for case in selected:
        start_sample = int(case['start_s'] * RATE)
        end_sample = int(case['end_s'] * RATE)
        case['start_sample'], case['end_sample'] = start_sample, end_sample
        case['id'] = f'{meeting}-{start_sample}-{end_sample}'
        for source_name, source in sources.items():
            requests.append((case['id'], source_name, source, start_sample, end_sample))

    raw_ranges, range_manifest = {}, []
    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = {pool.submit(fetch_pcm_range, source, start, end): (case_id, name)
                   for case_id, name, source, start, end in requests}
        for future in as_completed(futures):
            case_id, name = futures[future]
            raw, evidence = future.result()
            raw_ranges[case_id, name] = raw
            range_manifest.append({'case': case_id, 'stream': name, **evidence})

    output.mkdir(parents=True, mode=0o700)
    (output / 'audio').mkdir(mode=0o700)
    manifest = {
        'meeting': meeting, 'license': 'CC-BY-4.0',
        'source_page': 'https://groups.inf.ed.ac.uk/ami/download/', 'audio_index': base,
        'annotation_zip': str(annotation_zip),
        'annotation_sha256': sha256_file(annotation_zip),
        'streams': sources, 'selected_byte_ranges': sorted(range_manifest, key=lambda r: (r['case'], r['stream']))}
    (output / 'range-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')

    for case in selected:
        case_id, arms = case['id'], {}
        official = np.frombuffer(raw_ranges[case_id, 'Mix-Headset'], dtype='<i2').copy()
        headsets = {speaker: np.frombuffer(raw_ranges[case_id, f'Headset-{channel}'], dtype='<i2').copy()
                    for speaker, channel in mapping.items()}
        components, controlled = mix_components(headsets)
        all_arms = {'official-mix': official, 'controlled-mix': controlled,
                    **{'headset-' + speaker: data for speaker, data in components.items()}}
        references = [{**word, 'start': word['start'] - case['start_s'], 'end': word['end'] - case['start_s']}
                      for word in words if case['start_s'] <= word['start'] and word['end'] <= case['end_s']]
        for arm, samples in all_arms.items():
            path = output / 'audio' / f'{case_id}-{arm}.wav'
            sf.write(path, samples, RATE, subtype='PCM_16')
            normalized = samples.astype(np.float64) / 32768
            wire = np.floor(np.where(normalized < 0, normalized * 32768, normalized * 32767) + .5).astype('<i2')
            arms[arm] = {'path': str(path), 'sha256': sha256_file(path),
                'wire_pcm_sha256': hashlib.sha256(wire.tobytes()).hexdigest(), 'rms': float(np.sqrt(np.mean(normalized ** 2))),
                'peak': float(np.max(np.abs(normalized)))}
        case['reference'], case['arms'] = references, arms

    rng = random.Random(SEED)
    schedule = []
    for repeat in range(3):
        blocks = [case for case in selected if case['role'] == 'test']
        rng.shuffle(blocks)
        for case in blocks:
            arms = list(case['arms'])
            rng.shuffle(arms)
            schedule.extend({'case': case['id'], 'arm': arm, 'repeat': repeat} for arm in arms)

    plan = {
        'version': 1, 'meeting': meeting, 'seed': SEED, 'source': manifest, 'mapping': mapping,
        'gain': .25, 'duration_s': 10, 'repeats': 3,
        'selection': 'Frozen from manual word annotations before inference: 4 windows per overlap stratum, disjoint starts, 10-second windows; no ASR-based selection.',
        'scoring': 'Mixed: time/speaker-order-preserving interleaving WER; headset: own-speaker references with inactive-channel insertion controls. Not official AMI/cpWER.',
        'asr': {'url': 'http://127.0.0.1:18000', 'model': 'custom', 'language': 'en', 'prompt': None,
                'max_speech_duration_s': 15, 'min_silence_duration_ms': 100},
        'decision': 'Descriptive held-out meeting; do not change production path from this single-meeting result.',
        'limits': ['Tracks are native close-talk headsets and can contain crosstalk; not ideal source separation.',
                   'Only selected annotated excerpts are range-fetched; each byte range is pinned by source ETag, Content-Range, and SHA-256.',
                   'Repeated requests check reproducibility, not independent meetings.',
                   'Fixed windows do not evaluate live merging, revisions, or UI latency.'],
        'cases': selected, 'schedule': schedule}
    (output / 'plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'meeting': meeting, 'cases': [(c['role'], c['stratum'], c['start_s'], c['overlap_s']) for c in selected],
        'requests': len(schedule), 'fetched_ranges': len(range_manifest), 'output': str(output)}))


if __name__ == '__main__':
    prepare(*sys.argv[1:])
