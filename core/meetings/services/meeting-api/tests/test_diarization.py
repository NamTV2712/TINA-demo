import copy
import hashlib
import io
import wave

import pytest
from pydantic import ValidationError

from meeting_api.collector.diarization import DiarizationOptions, apply_assignments, attribution, validate_result
from meeting_api.collector.speakers import observe, overlay, update, SpeakerUpdate
from meeting_api.collector.transcript_document import CorrectionConflict

MEETING={'id':42,'platform':'google_meet','native_meeting_id':'private-room'}


def test_exclusive_coverage_does_not_double_count_or_guess_overlap():
    turn=lambda a,b,s:dict(start_ms=a,end_ms=b,speaker=s)
    assert attribution(0,1000,[turn(0,1000,0)])==0
    assert attribution(0,1000,[turn(0,600,0),turn(0,600,0)]) is None
    assert attribution(0,1000,[turn(0,1000,0),turn(0,1000,1)]) is None
    assert attribution(0,1000,[turn(0,500,0),turn(500,1000,1)]) is None
    assert attribution(0,300,[turn(0,300,0)]) is None
    assert attribution(0,1000,[]) is None


def test_registry_application_is_idempotent_monotonic_preserves_manual_metadata_and_raw():
    rows=[dict(segment_id=f's:{i}',speaker_key=f'channel:{i}',speaker='Speaker',session_uid='session',text='original words',start=i,end=i+1) for i in range(5)]
    rows[3].update(source='glow-bound',participant_id='meet-observed',speaker='Minh')
    data={};observe(data,MEETING,rows)
    data['speaker_registry']['speakers'][rows[3]['speaker_id']]['history'].append({'recording_key': 'previous-audio'})
    old=copy.deepcopy(rows)
    manual=rows[2]['speaker_id']
    update(data,MEETING,manual,SpeakerUpdate(expected_revision=1,name=None),7)
    job={'id':'job','status':'completed','items':[dict(segment_id=s['segment_id'],recording_key='audio-model-hash',cluster=0 if i<4 else None) for i,s in enumerate(rows)]}
    data['transcript_diarization']=copy.deepcopy(job)
    apply_assignments(data,MEETING,job,7)
    result=overlay(rows,data)
    assert result[0]['speaker_id']==result[1]['speaker_id']
    assert result[0]['speaker_revision']>old[0]['speaker_revision']
    assert result[2]['speaker_id']==manual and result[2]['speaker_status']=='unknown'
    assert result[3]['speaker_id']==old[3]['speaker_id'] and result[3]['speaker']=='Minh'
    assert result[4]['speaker_id']!=result[0]['speaker_id']
    assert all(s['text']=='original words' for s in result)
    assert rows==old
    before=copy.deepcopy(data);apply_assignments(data,MEETING,job,7);assert data==before
    entry=data['speaker_registry']['speakers'][result[0]['speaker_id']]
    update(data,MEETING,entry['speaker_id'],SpeakerUpdate(expected_revision=entry['revision'],name='Lan'),7)
    assert overlay(rows,data)[0]['speaker']=='Lan'
    assert 'name' not in data['transcript_outbox'][-1]
    with pytest.raises(CorrectionConflict):
        apply_assignments(data,MEETING,{**job,'id':'stale'},7)


def test_worker_result_checks_hash_bounds_and_finite_numbers():
    content=io.BytesIO()
    with wave.open(content,'wb') as wav:
        wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000);wav.writeframes(b'\0'*32000)
    audio=content.getvalue()
    result={'audio_sha256':hashlib.sha256(audio).hexdigest(),'model':'model-v1','turns':[{'start_ms':0,'end_ms':1000,'speaker':0}]}
    assert validate_result(result,audio)['duration_ms']==1000
    for change in [{'audio_sha256':'wrong'},{'turns':[{'start_ms':0,'end_ms':float('nan'),'speaker':0}]},{'turns':[{'start_ms':0,'end_ms':1100,'speaker':0}]}]:
        with pytest.raises(ValueError): validate_result({**result,**change},audio)


def test_renaming_an_acoustic_voice_does_not_lock_its_segment_assignment():
    rows = [dict(segment_id=f's:{i}', speaker_key=f'channel:{i}', speaker='Speaker', text='raw words') for i in range(2)]
    data = {}
    observe(data, MEETING, rows)
    job = {'id': 'first', 'status': 'completed',
           'items': [dict(segment_id=f's:{i}', recording_key='audio-model', cluster=i) for i in range(2)],
           'turns': [dict(start_ms=i * 1000, end_ms=(i + 1) * 1000, speaker=i) for i in range(2)]}
    data['transcript_diarization'] = copy.deepcopy(job)
    apply_assignments(data, MEETING, job, 7)
    sid = data['speaker_registry']['segments']['s:0']
    entry = data['speaker_registry']['speakers'][sid]
    update(data, MEETING, sid, SpeakerUpdate(expected_revision=entry['revision'], name='Alice'), 7)
    job = {**job, 'id': 'second', 'items': [{**item, 'cluster': 1 - item['cluster']} for item in job['items']]}
    data['transcript_diarization'] = copy.deepcopy(job)
    apply_assignments(data, MEETING, job, 7)
    result = overlay(rows, data)
    assert result[0]['speaker_id'] != sid
    assert result[1]['speaker_id'] == sid and result[1]['speaker'] == 'Alice'
    assert all(row['text'] == 'raw words' for row in result)


@pytest.mark.parametrize('number',[True,0,21,-2])
def test_count_validation(number):
    with pytest.raises(ValidationError): DiarizationOptions(num_speakers=number)
