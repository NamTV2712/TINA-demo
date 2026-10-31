"""Freeze a paired FSMN-VAD ON/OFF factor for the existing native-headset PCM windows."""
import hashlib
import json
import pathlib
import random
import sys


def build(experiment, output):
    experiment = pathlib.Path(experiment).expanduser().resolve()
    output = pathlib.Path(output).expanduser().resolve()
    assert not output.exists(), 'Never overwrite a frozen paired study'
    base = json.loads((experiment / 'plan.json').read_text())
    cases = [case for case in base['cases'] if case['role'] == 'test']
    arms = ['controlled-mix'] + ['headset-' + speaker for speaker in base['mapping']]
    schedule = []
    rng = random.Random(base['seed'] + '-vad-factor')
    for repeat in range(base['repeats']):
        order = cases[:]
        rng.shuffle(order)
        for case in order:
            tasks = [{'case': case['id'], 'arm': arm, 'vad_mode': mode, 'repeat': repeat}
                     for arm in arms for mode in ('fsmn', 'off')]
            rng.shuffle(tasks)
            schedule.extend(tasks)
    output.mkdir(mode=0o700)
    plan = {
        'version': 1,
        'parent_plan_sha256': hashlib.sha256((experiment / 'plan.json').read_bytes()).hexdigest(),
        'parent_experiment': str(experiment),
        'baseline_worker': 'http://127.0.0.1:18000',
        'probe_worker': 'http://127.0.0.1:18018',
        'model': base['asr'], 'duration_s': base['duration_s'], 'repeats': base['repeats'],
        'mapping': base['mapping'], 'cases': cases, 'arms': arms, 'seed': base['seed'] + '-vad-factor',
        'schedule': schedule,
        'question': 'For byte-identical mixed or native-headset PCM, what changes when the same Qwen AutoModel bypasses FSMN segmentation?',
        'scoring': 'Use the frozen parent reference, single-use time/speaker-constrained mixed oracle and own-speaker headset scoring unchanged. Compare VAD modes within each input and stratum; do not merge speaker tokens or change the release gate.',
        'limits': [
            'The scratch worker uses CPU so production MPS resources stay free. Both VAD modes share one CPU Qwen model and settings; device differs from the prior MPS study.',
            'Reuses the original fixed PCM windows. No new sample selection, gain normalization, VAD parameter tuning or model revision change.',
            'Repeated calls on one meeting are not independent meetings.',
        ],
    }
    (output / 'vad-plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'cases': len(cases), 'arms': arms, 'repeats': plan['repeats'], 'requests': len(schedule)}))


if __name__ == '__main__':
    build(*sys.argv[1:])
