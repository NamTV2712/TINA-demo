"""Synthetic meeting fixture, isolated execution and descriptive quality report; no real-user audio."""
from __future__ import annotations

import hashlib
import itertools
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import wave

import numpy as np

RATE = 16000
SCRIPT = [
    ('Linh', 'vi', 'Hiện tại hệ thống có ba máy chủ và dữ liệu đã được sao lưu.', 'fact'),
    ('Daniel', 'en', 'Currently the audio gateway is running on the local network.', 'fact'),
    ('Samantha', 'en', 'I will send the report by Friday.', 'action_item'),
    ('Linh', 'vi', 'Tôi sẽ kiểm tra dữ liệu và gửi kết quả trước thứ Sáu.', 'action_item'),
    ('Daniel', 'en', 'We decided to keep the current release for another week.', 'decision'),
    ('Samantha', 'en', 'We need to prepare the demo and verify the API.', 'action_item'),
    ('Linh', 'vi', 'Chúng ta thống nhất giữ bản hiện tại và tiếp tục kiểm thử.', 'decision'),
    ('Daniel', 'en', 'I will update the documentation and review the deployment logs.', 'action_item'),
    ('Samantha', 'en', 'The current build still needs a test with three speakers.', 'fact'),
    ('Linh', 'vi', 'Hiện tại phần nhận dạng vẫn cần kiểm tra thêm tiếng Anh.', 'fact'),
    ('Daniel', 'en', 'We have not decided to delete any recording.', None),
    ('Samantha', 'en', 'I will not publish the report before review.', None),
    ('Linh', 'vi', 'Tôi chưa quyết định thay đổi lịch phát hành.', None),
    ('Samantha', 'en', 'We decided to review the evidence before changing the release date.', 'decision'),
    ('Linh', 'vi', 'Tôi sẽ tổng hợp ghi chú và đối chiếu với bản ghi âm.', 'action_item'),
]


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def pcm(path):
    with wave.open(str(path), 'rb') as w:
        assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (RATE, 1, 2)
        return np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').copy()


def prepare(output):
    assert Path(__file__).resolve().parents[3] not in output.parents, 'Keep generated audio outside the repository'
    output.mkdir(parents=True, exist_ok=False)
    turns, parts = [], [np.zeros(RATE, dtype=np.int16)]
    samples = RATE
    for index, (voice, language, text, expected) in enumerate(SCRIPT):
        source, target = output / f'voice-{index:02}.aiff', output / f'turn-{index:02}.wav'
        subprocess.run(['say', '-v', voice, '-r', '165', '-o', str(source), text], check=True)
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(source), '-ac', '1', '-ar', str(RATE), str(target)], check=True)
        audio = pcm(target)
        active = np.flatnonzero(np.abs(audio.astype(np.int32)) > max(100, np.max(np.abs(audio.astype(np.int32))) * .015))
        assert len(active), f'TTS returned no speech: {voice}'
        audio = audio[max(0, active[0]-800):min(len(audio), active[-1]+801)]
        turns.append({'id':index, 'speaker':voice, 'language':language, 'text':text, 'expected_type':expected,
                      'start_ms':samples/RATE*1000, 'end_ms':(samples+len(audio))/RATE*1000})
        gap = 6.65 if index in (4,9) else .65
        parts += [audio, np.zeros(int(gap*RATE), dtype=np.int16)]
        samples += len(audio) + int(gap*RATE)
        source.unlink()
    mixed = np.concatenate(parts)
    with wave.open(str(output/'meeting.wav'), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE); w.writeframes(mixed.astype('<i2').tobytes())
    write_json(output/'manifest.json', {'version':'synthetic-meeting-e2e.v1', 'tts':'macOS say', 'speakers':sorted({t['speaker'] for t in turns}),
        'chunk_seconds':8, 'duration_seconds':len(mixed)/RATE, 'audio_sha256':hashlib.sha256((output/'meeting.wav').read_bytes()).hexdigest(),
        'limits':['Synthetic turn-taking; no microphone/browser/Meet transport, room acoustics or natural overlapping speech.',
                  'Known speaker count supplied; anonymous cluster labels scored with a global best permutation.',
                  'Known utterance intervals; no independent word-boundary reference.'], 'turns':turns})
    print(json.dumps({'prepared':str(output),'speakers':3,'turns':len(turns),'audio_seconds':len(mixed)/RATE}), flush=True)


def run(output):
    assert output.is_dir() and (output/'manifest.json').is_file()
    assert not (output/'pipeline.json').exists(), 'Use a fresh output directory'
    root = Path(__file__).resolve().parents[3]
    env = dict(v.split('=',1) for v in json.loads(subprocess.check_output(['docker','inspect','tina-verify-20261015-meeting-api-1']))[0]['Config']['Env'] if '=' in v)
    endpoint = env.get('MINIO_ENDPOINT', 'storage:9000')
    env['S3_ENDPOINT'] = env.get('S3_ENDPOINT') or (endpoint if endpoint.startswith(('http://','https://')) else ('https://' if env.get('MINIO_SECURE') == 'true' else 'http://') + endpoint)
    env['S3_ACCESS_KEY'] = env.get('S3_ACCESS_KEY') or env.get('MINIO_ACCESS_KEY','')
    env['S3_SECRET_KEY'] = env.get('S3_SECRET_KEY') or env.get('MINIO_SECRET_KEY','')
    env['RECORDING_BUCKET'] = env.get('MINIO_BUCKET') or env.get('RECORDING_BUCKET','tina')
    pg = 'tina-verify-20261015-postgres-1'
    def sql(statement):
        return subprocess.check_output(['docker','exec','-i',pg,'sh','-c','psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'], input=statement.encode())
    count = int(sql("SELECT count(*) FROM meetings WHERE status IN ('active','joining','awaiting_admission') OR data->'transcript_alignment'->>'status' IN ('running','paused','cancelling') OR data->'transcript_diarization'->>'status' IN ('running','paused','cancelling');"))
    assert count == 0, 'A real meeting or audio job is active; leave its workers available'
    name = 'tina_memory_verify_' + __import__('uuid').uuid4().hex
    fd, filename = tempfile.mkstemp(prefix='tina-e2e-',suffix='.env'); os.fchmod(fd,0o600)
    created = False
    try:
        for file, source, dest in [('diarization.env','TINA_DIARIZATION_TOKEN','DIARIZATION_SERVICE_TOKEN'),('alignment.env','TINA_ALIGNMENT_TOKEN','ALIGNMENT_SERVICE_TOKEN')]:
            config = {}
            for line in (Path.home()/'.config/tina'/file).read_text().splitlines():
                key, sep, value = line.removeprefix('export ').partition('=')
                if sep and not key.startswith('#'): config[key.strip()] = shlex.split(value)[0] if value.strip() else ''
            if dest not in env: env[dest] = config[source]
        env.update(DB_NAME=name, DIARIZATION_SERVICE_URL='http://host.docker.internal:18014', ALIGNMENT_SERVICE_URL='http://host.docker.internal:18015')
        with os.fdopen(fd,'w') as f:
            for key in ['DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME','RECORDING_BUCKET','S3_ENDPOINT','S3_ACCESS_KEY','S3_SECRET_KEY','DIARIZATION_SERVICE_URL','DIARIZATION_SERVICE_TOKEN','ALIGNMENT_SERVICE_URL','ALIGNMENT_SERVICE_TOKEN']:
                if key in env: f.write(key+'='+env[key]+'\n')
        sql('CREATE DATABASE '+name+';'); created=True
        subprocess.run(['docker','run','--rm','--network','tina-verify-20261015_tina','--env-file',filename,'--entrypoint','python',
            '-v',str(root/'core')+':/task/core:ro','-v',str(Path(__file__).parent)+':/task/benchmark:ro','-v',str(output.resolve())+':/task/run',
            '-e','PYTHONPATH=/task/core/meetings/services/meeting-api/src','tina/v012-meeting-api:dev','/task/benchmark/meeting_e2e_pipeline.py'],check=True)
    finally:
        try:
            if created: sql('DROP DATABASE '+name+' WITH (FORCE);')
            cleanup = json.loads((output/'cleanup.json').read_text()) if (output/'cleanup.json').exists() else {}
            cleanup['temporary_database_dropped'] = created
            write_json(output/'cleanup.json', cleanup)
        finally:
            os.unlink(filename)


def speaker_metrics(turns, hypothesis, samples, collar_ms=250):
    frames = np.arange(5, len(samples)/RATE*1000, 10)
    reference = np.full(len(frames), -1, dtype=int)
    names = sorted({t['speaker'] for t in turns})
    excluded = np.zeros(len(frames), dtype=bool)
    for t in turns:
        reference[(frames >= t['start_ms']) & (frames < t['end_ms'])] = names.index(t['speaker'])
        excluded |= (np.abs(frames-t['start_ms']) < collar_ms) | (np.abs(frames-t['end_ms']) < collar_ms)
    clusters = sorted({t['speaker'] for t in hypothesis})
    predictions = np.zeros((len(clusters),len(frames)),dtype=bool)
    for t in hypothesis: predictions[clusters.index(t['speaker'])] |= (frames>=t['start_ms']) & (frames<t['end_ms'])
    speech = (reference >= 0) & ~excluded
    permutations = list(itertools.permutations(range(len(names)),len(clusters))) if len(clusters)<=len(names) else []
    if not permutations:
        return {'detected_clusters':len(clusters), 'expected_speakers':len(names), 'mapping':{}, 'reason':'No injective mapping available; speaker count is reported separately'}
    mapped = max(permutations,key=lambda p:sum(np.sum(predictions[k] & (reference==label) & speech) for k,label in enumerate(p)))
    correct = np.zeros(len(frames),dtype=bool)
    for k,label in enumerate(mapped): correct |= predictions[k] & (reference==label)
    covered = predictions.any(axis=0)
    return {'detected_clusters':len(clusters),'expected_speakers':len(names),'mapping':{str(c):names[mapped[k]] for k,c in enumerate(clusters)},
            'speaker_count_matches':len(clusters)==len(names),'collar_ms':collar_ms,'reference_kind':'trimmed TTS utterance intervals, not hand-labelled phonetic activity',
            'scored_speech_seconds':round(float(speech.sum()*.01),2),
            'miss_rate':float(np.sum(speech & ~covered)/speech.sum()),
            'confusion_rate':float(np.sum(speech & covered & ~correct)/speech.sum()),
            'speech_label_accuracy':float(np.sum(speech & correct)/speech.sum()),
            'false_alarm_seconds':round(float(np.sum((reference<0) & ~excluded & covered)*.01),2)}


def report(output):
    from metrics import score, percentile
    manifest=json.loads((output/'manifest.json').read_text()); result=json.loads((output/'pipeline.json').read_text())
    segments=result['canonical']['segments']; turns=manifest['turns']
    window_mode='silence-cut' if (output/'windows.json').exists() else 'fixed-8s'
    window_note=('ASR windows use the production silence-cut helper with no text/speaker oracle; available-at time includes observed lookahead.'
                 if window_mode=='silence-cut' else 'ASR receives fixed 8-second windows, paced in real time.')

    scoring=score(' '.join(t['text'] for t in turns),' '.join(s['raw_text'] for s in segments))
    scoring.update(wer=scoring['word_errors']/scoring['ref_words'], cer=scoring['char_errors']/scoring['ref_chars'])
    speakers=speaker_metrics(turns,result['diarization']['turns'],pcm(output/'meeting.wav'))
    words=[w for s in segments for w in s['words']]; aligned=[w for w in words if w['aligned']]
    latencies=[r['http_seconds'] for r in result['asr_requests']]
    attribution={'known_aligned_words':sum(w.get('speaker_id') is not None for w in aligned), 'unknown_aligned_words':sum(w.get('speaker_id') is None for w in aligned)}
    # Compare matched ASR tokens only; utterance bounds are not word-boundary ground truth.
    from metrics import normalize
    import jiwer
    from uuid import uuid5, NAMESPACE_URL
    reference=[(token,t) for t in turns for token in normalize(t['text']).split()]
    hypotheses=[(token,w) for s in segments for w in (s['words'] or [{'text':s['raw_text'],'aligned':False}]) for token in normalize(w['text']).split()]
    mapping=speakers.get('mapping',{})
    recording_key=result['diarization']['items'][0]['recording_key']
    identities={str(uuid5(NAMESPACE_URL,f'tina:meeting:1:diarization:{recording_key}:{cluster}')):name for cluster,name in mapping.items()}
    matched=[];deviations=[];correct=known=0
    matched_asr_by_language={'vi':0,'en':0}
    timing_outliers=[]
    tokens=jiwer.process_words(' '.join(t for t,_ in reference),' '.join(t for t,_ in hypotheses))
    for chunk in tokens.alignments[0]:
        if chunk.type!='equal':continue
        for r,h in zip(range(chunk.ref_start_idx,chunk.ref_end_idx),range(chunk.hyp_start_idx,chunk.hyp_end_idx)):
            word=hypotheses[h][1];truth=reference[r][1]
            matched_asr_by_language[truth['language']]+=1
            if not word.get('aligned'):continue
            midpoint=(word['start_ms']+word['end_ms'])/2-1767225600000
            deviations.append(max(truth['start_ms']-midpoint,midpoint-truth['end_ms'],0))
            if deviations[-1]>250:timing_outliers.append({'token':hypotheses[h][0],'outside_utterance_ms':deviations[-1],'language':truth['language']})
            name=identities.get(word.get('speaker_id'))
            known+=int(name is not None);correct+=int(name==truth['speaker'])
            matched.append({'token':hypotheses[h][0],'reference_voice':truth['speaker'],'predicted_voice':name,'language':truth['language']})
    attribution.update(matched_aligned_tokens=len(matched),matched_tokens_with_voice=known,
        matched_token_speaker_accuracy=correct/known if known else None,
        matched_token_unknown_rate=(len(matched)-known)/len(matched) if matched else None,
        aligned_midpoint_outside_utterance_p95_ms=percentile(deviations,.95),
        aligned_midpoint_outside_utterance_over_250ms=sum(d>250 for d in deviations))
    attribution.update(matched_asr_by_language=matched_asr_by_language, timing_outliers=timing_outliers)
    write_json(output/'matched-word-diagnostics.json',matched)
    summary={'fixture':{'speakers':3,'turns':len(turns),'duration_seconds':manifest['duration_seconds'],'origin':'macOS synthetic voices','asr_profile':manifest.get('asr_profile')},
        'asr':scoring,'speakers':speakers,'alignment':{'tokens':len(words),'aligned':len(aligned),'unaligned':len(words)-len(aligned),
        'coverage':len(aligned)/len(words) if words else 0,'word_boundary_mae':None,**attribution,'matched_aligned_by_language':{lang:sum(w['language']==lang for w in matched) for lang in ('vi','en')}},
        'latency':{'chunk_seconds':manifest['chunk_seconds'],'window_mode':window_mode,'window_seconds':[r['chunk_end_s']-r['chunk_start_s'] for r in result['asr_requests']],'asr_request_and_persist_p50_seconds':percentile(latencies,.5),'asr_request_and_persist_p95_seconds':percentile(latencies,.95),
        'speech_request_and_persist_p50_seconds':percentile([r['http_seconds'] for r in result['asr_requests'] if r['segments']],.5),
        'speech_request_and_persist_p95_seconds':percentile([r['http_seconds'] for r in result['asr_requests'] if r['segments']],.95),
        'first_caption_seconds':result['asr_requests'][0]['ready_seconds'],'audio_replay_wall_seconds':result['audio_replay_wall_seconds'],**result['stage_seconds']},
        'memory':{'windows':len(result['memory']['windows']),'candidates':len(result['memory']['facts'])},'checks':result['checks'],
        'limits':manifest['limits']+['Alignment uses the Vietnamese MFA model for both languages; no word-boundary MAE can be measured.',
            window_note+' Request-to-durable latency includes worker HTTP plus database persistence, and differs from caption waiting time.',
            'Meeting API uses an in-process HTTP transport with real PostgreSQL/MinIO and real worker HTTP; gateway/UI/live capture are excluded.',
            'Matched-token speaker accuracy is selective: untimed/unmatched tokens are excluded; inspect per-language coverage.',
            'Few samples on a shared machine describe observed variability, not population latency percentiles.']}
    summary['latency']['sum_replay_and_background_seconds']=result['audio_replay_wall_seconds']+sum(result['stage_seconds'].values())
    summary['latency']['final_caption_lag_seconds']=result['asr_requests'][-1]['ready_seconds']-manifest['duration_seconds']
    write_json(output/'summary.json',summary)
    rows=['# Synthetic Vietnamese–English meeting E2E','',f"Audio: {manifest['duration_seconds']:.2f}s, 3 synthetic voices, {len(turns)} turns. Real workers, isolated PostgreSQL and temporary MinIO objects.",'',
          '## Measurements','', '```json',json.dumps(summary,ensure_ascii=False,indent=2),'```','','## ASR reference and output','',
          '| Turn | Voice | Reference |','|---|---|---|']
    rows += [f"| {t['id']} | {t['speaker']} | {t['text']} |" for t in turns]
    rows += ['','### Recognized segments','']+[f"- {s['segment_id']}: {s['raw_text']}" for s in segments]
    rows += ['','## Extraction candidates and exact evidence','']
    rows += [f"- **{f['type']}**: {f['text']} (segments: {', '.join(e['segment_id'] for e in f['evidence'])})" for f in result['memory']['facts']]
    rows += ['','## Limits','']+['- '+limit for limit in summary['limits']]
    (output/'REPORT.md').write_text('\n'.join(rows)+'\n')
    print(json.dumps(summary,ensure_ascii=False,indent=2))


if __name__=='__main__':
    actions={'prepare':prepare,'run':run,'report':report}
    if len(sys.argv)!=3 or sys.argv[1] not in actions:
        raise SystemExit('Usage: meeting_e2e.py prepare|run|report OUTPUT')
    command,target=sys.argv[1:];actions[command](Path(target).expanduser().resolve())
