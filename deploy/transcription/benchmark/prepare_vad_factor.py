"""Freeze exact paired VAD on/off arms for every existing source/meeting window."""
import hashlib
import json
import pathlib
import random
import sys


def prepare(parent, output, scope='mixed-only'):
    parent=pathlib.Path(parent).expanduser().resolve();output=pathlib.Path(output).expanduser().resolve();repo=pathlib.Path(__file__).resolve().parents[3]
    assert not output.exists() and output!=repo and repo not in output.parents
    assert scope in ('mixed-only','all-sources','probe-only','trace-only','mixed-plus-headsets')
    plan=json.loads((parent/'plan.json').read_text());cases=[c for c in plan['cases'] if c['role']=='test']
    arms=['controlled-mix'] if scope in ('mixed-only','probe-only','trace-only') else ['controlled-mix']+['headset-'+s for s in plan['mapping']]
    rng=random.Random(str(plan['seed'])+'-vad-factor');schedule=[]
    if scope=='trace-only':
        windows=cases[:];rng.shuffle(windows)
        schedule=[{'case':c['id'],'arm':'controlled-mix','vad_mode':'fsmn','repeat':0} for c in windows]
    elif scope!='probe-only':
        for repeat in range(plan['repeats']):
            windows=cases[:];rng.shuffle(windows)
            for c in windows:
                tasks=[]
                for arm in arms:
                    modes=('fsmn','off') if scope!='mixed-plus-headsets' or arm=='controlled-mix' else ('fsmn',)
                    tasks.extend({'case':c['id'],'arm':arm,'vad_mode':mode,'repeat':repeat} for mode in modes)
                rng.shuffle(tasks);schedule.extend(tasks)
    output.mkdir(mode=0o700);result={'parent_experiment':str(parent),'parent_plan_sha256':hashlib.sha256((parent/'plan.json').read_bytes()).hexdigest(),
        'probe_worker':'http://127.0.0.1:18018','baseline_worker':'http://127.0.0.1:18000','model':plan['asr'],'language':'en','prompt':None,
        'max_speech_duration_s':15,'min_silence_duration_ms':100,'cases':cases,'arms':arms,'vad_modes':['fsmn','off'],'repeats':plan['repeats'],'scope':scope,
        'qwen_hf_cache_revision':'5eb144179a02acc5e5ba31e748d22b0cf3e303b0','fsmn_vad_cache_revision':'master',
        'warmup_case':next(c for c in plan['cases'] if c['role']=='warmup'),
        'schedule':schedule,'selection':f"Reuse the frozen {plan['meeting']} windows; no reselection or ASR-based tuning.",
        'score':'Same time/speaker-constrained mixed oracle and per-speaker headset metrics as the parent experiment. Compare VAD ON/OFF within identical PCM/source; direct A/B uses one scratch CPU Qwen instance so both modes share model weights and device.',
        'limitations':['CPU inference can differ from the production MPS device. The scratch process does not alter or restart the production worker.',
            'A successful VAD bypass shows an effect of the FunASR VAD pipeline, not necessarily segmentation boundaries in TINA. Returned sentence times are audited separately from the actual VAD audio ranges.',
            'Per-source headset leakage remains; this experiment isolates the VAD factor, not microphone bleed. One AMI meeting is not an independent-meeting sample.']}
    (output/'vad-plan.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'windows':len(cases),'input_arms':arms,'modes':result['vad_modes'],'repeats':result['repeats'],'scored_requests':len(schedule)}))


if __name__=='__main__':prepare(*sys.argv[1:])
