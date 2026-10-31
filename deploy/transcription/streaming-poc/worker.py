"""Single-source MPS experiment. Run with the existing .venv/funasr Python."""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import time
import traceback
import urllib.request

os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', PYTORCH_ENABLE_MPS_FALLBACK='0', TOKENIZERS_PARALLELISM='false')
os.umask(0o077)

import numpy as np
import psutil
import soundfile as sf
from decoder import Decoder, Draft, RATE, MAX_SAMPLES

EXPECTED = {}


class ExperimentStopped(RuntimeError):
    pass


def guard():
    for port, path in [(8056, 'health'), (18000, 'status')]:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/{path}', timeout=3) as response:
                state = json.load(response)
        except Exception as error:
            raise ExperimentStopped(f'Production listener {port} unavailable; stopping the experiment') from error
        expected = EXPECTED.get(str(port))
        if expected and (not psutil.pid_exists(expected['pid']) or psutil.Process(expected['pid']).create_time() != expected['started']):
            raise ExperimentStopped(f'Production process {port} changed; stopping the experiment')
        if state.get('live_sessions', 0) or state.get('queue', {}).get('active', 0) or state.get('queue', {}).get('waiting', 0):
            raise ExperimentStopped('Production capture/ASR became active; stopping the experiment')
    if psutil.virtual_memory().available < 2 * 1024**3:
        raise ExperimentStopped('Less than 2 GiB available; stopping the experiment')


def main():
    global EXPECTED
    manifest_path = Path(sys.argv[1]).resolve()
    manifest = json.loads(manifest_path.read_text())
    EXPECTED = manifest['production_before']
    output = manifest_path.parent
    guard()
    if psutil.virtual_memory().available < 5 * 1024**3:
        raise RuntimeError('Need 5 GiB available before loading a temporary model')
    started = time.perf_counter()
    decoder = Decoder(Path(manifest['checkpoint']))
    runtime = {'device': str(decoder.asr.model.device), 'dtype': str(decoder.asr.model.dtype),
               'model_load_s': time.perf_counter() - started,
               'versions': {name: importlib.metadata.version(name) for name in ['qwen-asr', 'torch', 'transformers', 'numpy']}}
    (output / 'runtime.json').write_text(json.dumps(runtime, indent=2) + '\n')
    print(json.dumps({'loaded': runtime}), flush=True)
    # Warmup is disjoint from the measured test clips and is not included in quality/latency metrics.
    warmup, rate = sf.read(manifest['warmup'], dtype='float32')
    assert rate == RATE
    decoder.decode(warmup[:RATE*3], Draft(lambda _: None), guard=guard)
    show_events = '--show-events' in sys.argv
    with (output / 'events.jsonl').open('x', buffering=1) as events, (output / 'results.jsonl').open('x', buffering=1) as results:
        for case in manifest['cases']:
            guard()
            audio, rate = sf.read(case['path'], dtype='float32')
            if rate != RATE or audio.ndim != 1 or len(audio) > MAX_SAMPLES or hashlib.sha256(Path(case['path']).read_bytes()).hexdigest() != case['sha256']:
                raise ValueError('Audio does not match the frozen mono PCM16k fixture')
            origin = time.perf_counter()
            visible, first_token, windows = [], None, []

            def emit(payload):
                event = {'case': case['id'], 'mode': case['mode'], 'elapsed_s': time.perf_counter()-origin, **payload}
                events.write(json.dumps(event, ensure_ascii=False) + '\n')
                if payload.get('type') in ('delta', 'replace') and payload.get('text'):
                    visible.append(event)
                if show_events:
                    print(json.dumps(event, ensure_ascii=False), flush=True)

            draft, raw, result = Draft(emit), '', None
            paced = case['mode'].startswith('paced-')
            step = RATE * int(case['mode'].split('-')[1][:-1]) if paced else len(audio)
            try:
                ends = [*range(step, len(audio), step), len(audio)]
                for chunk, end in enumerate(ends):
                    if paced:
                        time.sleep(max(0, origin + end/RATE - time.perf_counter()))
                    guard()
                    # shortcut: re-encode a bounded utterance; add native acoustic-state streaming before long-session deployment.
                    result = decoder.decode(audio[:end], draft, chunk=chunk,
                        prefix=decoder.prefix(raw, chunk) if paced else '', stream=case['mode'] != 'batch', guard=guard)
                    raw = result['raw']
                    if first_token is None and result['first_token_s'] is not None:
                        first_token = result['first_token_clock'] - origin
                    windows.append({key: value for key, value in result.items() if key not in ('raw', 'text', 'first_token_clock')})
                    emit({'type': 'chunk_done', 'chunk': chunk, 'source_end_sample': end,
                          **{key: value for key, value in result.items() if key not in ('raw', 'text', 'first_token_clock')}})
                elapsed = time.perf_counter()-origin
                emit({'type': 'final' if result['eligible'] else 'language_review',
                      'text' if result['eligible'] else 'candidate': result['text'],
                      'source_start_sample': 0, 'source_end_sample': len(audio)})
                row = {'id': case['id'], 'mode': case['mode'], 'ok': True, 'text': result['text'], 'language': result['language'],
                       'eligible': result['eligible'], 'duration_s': len(audio)/RATE, 'wall_s': elapsed,
                       'first_token_s': first_token, 'first_text_s': visible[0]['elapsed_s'] if visible else None,
                       'finalization_tail_s': max(0, elapsed-len(audio)/RATE) if paced else None,
                       'decode_compute_s': sum(window['generation_s'] for window in windows),
                       'replacements': draft.replacements, 'visible_events': len(visible),
                       'during_generate_events': sum(event.get('during_generate', False) for event in visible), 'windows': windows}
            except Exception as error:
                traceback.print_exc()
                # Failed requests count as empty hypotheses, never disappear from the paired score.
                row = {'id': case['id'], 'mode': case['mode'], 'ok': False, 'text': '', 'duration_s': len(audio)/RATE,
                       'wall_s': time.perf_counter()-origin, 'error_type': type(error).__name__,
                       'error': str(error) if isinstance(error, ExperimentStopped) else 'Decode failed; see worker.log'}
            results.write(json.dumps(row, ensure_ascii=False) + '\n')
            print(json.dumps({key: row.get(key) for key in ['id', 'mode', 'ok', 'first_text_s', 'wall_s', 'during_generate_events']}), flush=True)
            guard()


if __name__ == '__main__':
    main()
