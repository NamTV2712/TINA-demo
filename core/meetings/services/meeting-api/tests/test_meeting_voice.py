import asyncio
from copy import deepcopy
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from fakeredis.aioredis import FakeRedis

from meeting_api.lifecycle.voice import build_voice_router, voice_token
from meeting_api.lifecycle.speech_status import PlaybackStore


class Repo:
    def __init__(self):
        self.row = {'id': 1, 'user_id': 7, 'platform': 'google_meet', 'status': 'active',
                    'data': {'voice_agent_enabled': True, 'voice_assistant_capable': True, 'voice_assistant': {
                        'enabled': True, 'include_transcript': True, 'documents': [], 'revision': 1}}}
    async def get_meeting(self, mid): return deepcopy(self.row) if mid == 1 else None
    async def list_sessions(self, **kwargs): return ['current']
    async def save_voice_reply(self, mid, session, reply):
        from meeting_api.lifecycle.voice_replies import merge_reply
        self.row['data'] = merge_reply(self.row['data'], session, reply)
    async def set_voice_policy(self, mid, user, revision, policy):
        if revision != self.row['data']['voice_assistant']['revision']: raise ValueError()
        saved = dict(policy, revision=revision + 1)
        self.row['data']['voice_assistant'] = saved
        return saved


@pytest.fixture
async def setup(monkeypatch):
    monkeypatch.setenv('ADMIN_TOKEN', 'test-admin-secret')
    monkeypatch.setenv('INTERNAL_API_SECRET', 'test-internal-secret')
    monkeypatch.setenv('AGENT_API_URL', 'http://agent.test')
    monkeypatch.setenv('TTS_SERVICE_URL', 'http://tts.test')
    repo, redis, calls = Repo(), FakeRedis(decode_responses=True), []
    entered, release = asyncio.Event(), asyncio.Event()
    blocked = [False]
    async def upstream(request):
        calls.append(request)
        if request.url.path.endswith('/answer'):
            entered.set()
            if blocked[0]: await release.wait()
            return httpx.Response(200, json={'text': 'Supported answer', 'sources': []})
        return httpx.Response(200, json={'documents': ['wiki/shared.md']})
    def factory(**kwargs): return httpx.AsyncClient(transport=httpx.MockTransport(upstream), **kwargs)
    app = FastAPI()
    app.state.playback = PlaybackStore(redis, repo.save_voice_reply)
    app.include_router(build_voice_router(repo, redis, redis, app.state.playback, client_factory=factory))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        yield client, repo, redis, calls, entered, release, blocked
    await redis.aclose()


def headers(session='current'):
    return {'Authorization': 'Bearer ' + voice_token('test-admin-secret', 1, session)}


def question(): return {'request_id': str(uuid4()), 'question': 'What is the plan?', 'revision': 1}


async def test_kws_runtime_is_capability_scoped_validated_and_readable_only_by_owner(setup):
    import time
    client, _, redis, *_ = setup
    kws={'engine':'livekit-wakeword','version':'2.1.1','mode':'activation','device':'cpu','status':'ready',
         'models':['hey_tina','tina_oi'],'observed_at_ms':int(time.time()*1000)}
    path='/bots/voice/1/current/state'
    assert (await client.post(path,json={'state':'LISTENING','kws':kws})).status_code==401
    assert (await client.post(path,headers=headers(),json={'state':'LISTENING','kws':kws})).status_code==200
    result=await client.get('/meetings/1/voice-assistant',headers={'X-User-Id':'7'})
    assert result.json()['runtime']['kws']==kws
    assert (await client.get('/meetings/1/voice-assistant',headers={'X-User-Id':'8'})).status_code==404
    for change in [{'models':['tina','e_tina']},{'models':['hey_tina','hey_tina']},
                   {'observed_at_ms':kws['observed_at_ms']-20000},{'mode':'observe'},{'token':'must reject'}]:
        assert (await client.post(path,headers=headers(),json={'state':'LISTENING','kws':kws|change})).status_code==422


async def test_capability_is_scoped_to_active_session_and_owner_policy_is_private(setup):
    client, *_ = setup
    assert (await client.get('/meetings/1/voice-assistant', headers={'X-User-Id': '8'})).status_code == 404
    assert (await client.get('/bots/voice/1/current/config')).status_code == 401
    assert (await client.get('/bots/voice/1/old/config', headers=headers('old'))).status_code == 409
    result = await client.get('/bots/voice/1/current/config', headers=headers())
    assert result.json() == {'enabled': True, 'ready': True, 'revision': 1, 'wake_variants': [], 'noise_suppression':False, 'unavailable_reason': None}


async def test_source_selection_is_explicit_and_policy_save_uses_revision(setup):
    client, *_ = setup
    policy = {'enabled': True, 'include_transcript': False, 'documents': [], 'revision': 1}
    path = '/meetings/1/voice-assistant'
    assert (await client.put(path, json=policy, headers={'X-User-Id': '7'})).status_code == 422
    policy['documents'] = ['wiki/private.md']
    assert (await client.put(path, json=policy, headers={'X-User-Id': '7'})).status_code == 422
    policy['documents'] = ['wiki/shared.md']
    response = await client.put(path, json=policy, headers={'X-User-Id': '7'})
    assert response.status_code == 200 and response.json()['policy']['revision'] == 2
    assert (await client.put(path, json=policy, headers={'X-User-Id': '7'})).status_code == 409


async def test_ns_trial_is_opt_in_and_does_not_require_or_grant_room_sharing(setup):
    client,*_=setup
    response=await client.put('/meetings/1/voice-assistant',headers={'X-User-Id':'7'},json={
        'enabled':False,'include_transcript':False,'documents':[],'revision':1,'noise_suppression':True})
    assert response.status_code==200 and response.json()['policy']['noise_suppression']
    assert not response.json()['policy']['enabled']
    config=await client.get('/bots/voice/1/current/config',headers=headers())
    assert config.json()['noise_suppression'] and not config.json()['enabled']


async def test_voice_request_is_idempotent_and_cannot_substitute_sources(setup):
    client, repo, redis, calls, *_ = setup
    body = question(); path = '/bots/voice/1/current/answer'
    assert (await client.post(path, json=body | {'documents': ['wiki/private.md']}, headers=headers())).status_code == 422
    first = await client.post(path, json=body, headers=headers())
    assert first.status_code == 200, first.text
    assert (await client.post(path, json=body, headers=headers())).status_code == 409
    assert len([r for r in calls if r.url.path.endswith('/answer')]) == 1
    assert (await client.post(path, json=body | {'question': 'changed'}, headers=headers())).status_code == 409


async def test_stop_during_thought_discards_late_answer_and_blocks_competing_turn(setup):
    client, repo, redis, calls, entered, release, blocked = setup
    blocked[0] = True
    body = question(); path = '/bots/voice/1/current/answer'
    task = asyncio.create_task(client.post(path, json=body, headers=headers()))
    await entered.wait()
    assert (await client.post(path, json=question(), headers=headers())).status_code == 409
    stopped = await client.post('/bots/voice/1/current/state', json={'state': 'QUIET', 'request_id': body['request_id']}, headers=headers())
    assert stopped.status_code == 200
    release.set()
    assert (await task).status_code == 409


async def test_source_revocation_during_thought_prevents_speech(setup):
    client, repo, redis, calls, entered, release, blocked = setup
    blocked[0] = True
    task = asyncio.create_task(client.post('/bots/voice/1/current/answer', json=question(), headers=headers()))
    await entered.wait()
    repo.row['data']['voice_assistant']['revision'] = 2
    release.set()
    assert (await task).status_code == 409


async def test_voice_reply_history_survives_redis_and_tracks_receipts_without_changing_transcript(setup):
    client, repo, redis, *_ = setup
    repo.row['data']['transcript'] = ['original ASR']
    body = question()
    response = await client.post('/bots/voice/1/current/answer', json=body, headers=headers())
    assert response.status_code == 200
    async def history():
        response = await client.get('/meetings/1/voice-assistant', headers={'X-User-Id': '7'})
        return response.json()['replies']
    assert (await history())[0]['text'] == 'Supported answer'
    assert (await history())[0]['state'] == 'queued'
    store = PlaybackStore(redis, repo.save_voice_reply)
    await store.report(1, body['request_id'], 'current', 'started')
    assert (await history())[0]['state'] == 'started'
    await store.report(1, body['request_id'], 'current', 'stopped')
    await store.report(1, body['request_id'], 'current', 'completed')
    await redis.flushall()
    assert (await client.post('/bots/voice/1/current/answer', json=body, headers=headers())).status_code == 409
    repo.row['status'] = 'completed'
    replies = await history()
    assert len(replies) == 1 and replies[0]['state'] == 'stopped'
    assert replies[0]['started_at_ms'] is not None and replies[0]['ended_at_ms'] is not None
    assert 'session_uid' not in replies[0] and 'question' not in replies[0]
    assert repo.row['data']['transcript'] == ['original ASR']
    assert (await client.get('/meetings/1/voice-assistant', headers={'X-User-Id': '8'})).status_code == 404


async def test_departed_bot_does_not_make_a_queued_reply_look_spoken(setup):
    client, repo, *_ = setup
    await client.post('/bots/voice/1/current/answer', json=question(), headers=headers())
    repo.row['status'] = 'completed'
    result = await client.get('/meetings/1/voice-assistant', headers={'X-User-Id': '7'})
    assert result.json()['replies'][0]['state'] == 'unconfirmed'


def test_voice_reply_merge_is_monotonic_and_hidden_from_transcript_shares():
    from meeting_api.lifecycle.voice_replies import merge_reply, public_replies
    from meeting_api.collector.projection import project_response_data
    reply = {'request_id': str(uuid4()), 'text': 'Approved answer', 'state': 'completed', 'created_at_ms': 1, 'updated_at_ms': 2}
    data = merge_reply({'title': 'Preserved', 'transcript_edits': {'raw': True}}, 'current', reply)
    assert merge_reply(data, 'current', reply | {'state': 'started'}) == data
    with pytest.raises(ValueError): merge_reply(data, 'other', reply)
    with pytest.raises(ValueError): merge_reply(data, 'current', reply | {'text': 'replacement'})
    with pytest.raises(ValueError): merge_reply({'artifact_deletion': {'state': 'completed'}}, 'current', reply)
    assert 'voice_replies' not in project_response_data(data, viewer_is_owner=False)
    assert 'voice_replies' not in project_response_data(data, viewer_is_owner=True)
    assert data['transcript_edits'] == {'raw': True}
    pending = merge_reply({}, 'current', reply | {'state': 'started'})
    assert public_replies({'data': pending}, 'current', False)[0]['state'] == 'unconfirmed'


async def test_receipt_retry_repairs_durable_history_after_the_redis_transition_commits():
    redis = FakeRedis(decode_responses=True)
    calls = []
    async def save(mid, session, reply):
        calls.append(reply)
        if len(calls) == 1: raise RuntimeError('temporary storage failure')
    store = PlaybackStore(redis, save)
    reply = {'request_id': str(uuid4()), 'text': 'Validated answer', 'state': 'queued', 'created_at_ms': 1, 'updated_at_ms': 1}
    try:
        with pytest.raises(RuntimeError):
            await store.begin(1, reply['request_id'], 'current', reply['text'], 'auto', reply=reply)
        _, created = await store.begin(1, reply['request_id'], 'current', reply['text'], 'auto', reply=reply)
        assert not created and len(calls) == 2
        await store.report(1, reply['request_id'], 'current', 'started')
        assert calls[-1]['state'] == 'started' and calls[-1]['started_at_ms'] is not None
    finally:
        await redis.aclose()


async def test_stop_releases_both_reservations_even_if_voice_history_storage_fails(setup, monkeypatch):
    client, repo, redis, *_ = setup
    failed = [False]
    # The fixture bound the original method; use the same store callback with a failing repository write.
    from meeting_api.lifecycle.voice_replies import merge_reply
    def save(data, session, reply):
        if failed[0]: raise RuntimeError('synthetic storage outage')
        return merge_reply(data, session, reply)
    monkeypatch.setattr('meeting_api.lifecycle.voice_replies.merge_reply', save)
    body = question()
    assert (await client.post('/bots/voice/1/current/answer', json=body, headers=headers())).status_code == 200
    failed[0] = True
    response = await client.post('/bots/voice/1/current/state', json={'state':'QUIET','request_id':body['request_id']}, headers=headers())
    assert response.status_code == 200
    assert await redis.get('meeting:voice:1:lock') is None
    assert await redis.get('speech:active:1') is None
    assert (await PlaybackStore(redis).get(1, body['request_id']))['state'] == 'stopped'
    failed[0] = False
    await PlaybackStore(redis, repo.save_voice_reply).report(1, body['request_id'], 'current', 'stopped')
    assert repo.row['data']['voice_replies'][body['request_id']]['state'] == 'stopped'
    assert (await client.post('/bots/voice/1/current/answer', json=question(), headers=headers())).status_code == 200


async def test_readiness_polling_does_not_reload_knowledge_every_two_seconds(setup):
    client, repo, redis, calls, *_ = setup
    for _ in range(3):
        response = await client.get('/bots/voice/1/current/config', headers=headers())
        assert response.json()['ready'] is True
    assert len([r for r in calls if r.url.path.endswith('/ready')]) == 2  # One Agent probe and one TTS probe.


async def test_spawn_default_signing_key_and_tts_token_reach_new_bot(monkeypatch):
    from meeting_api.bot_spawn import service
    from meeting_api.bot_spawn.fakes import InMemoryMeetingRepo, FakeRuntimeClient
    async def context(user): return {}
    monkeypatch.setattr(service, '_fetch_bot_context', context)
    monkeypatch.setenv('ADMIN_TOKEN', 'test-admin-signing-secret')
    monkeypatch.setenv('TTS_API_TOKEN', 'test-tts-' + 'x' * 40)
    monkeypatch.setenv('TTS_SERVICE_URL', 'http://tts.test')
    monkeypatch.setenv('TINA_MEETING_VOICE', '1')
    monkeypatch.setenv('BOT_AUTHENTICATED', '0')
    runtime = FakeRuntimeClient()
    await service.request_bot(InMemoryMeetingRepo(), runtime, user_id=7, platform='google_meet',
        native_meeting_id='synthetic-token-proof', transcribe_enabled=False, voice_agent_enabled=True)
    env = runtime.specs[0]['env']
    assert env['TTS_API_TOKEN'] == 'test-tts-' + 'x' * 40
    assert env['TTS_SERVICE_URL'] == 'http://tts.test'
    assert len(env['TINA_VOICE_TOKEN']) == 64 and '/bots/voice/' in env['TINA_VOICE_URL']


async def test_owner_must_explicitly_approve_name_variants_and_hey_prefix_is_refused(setup):
    client, *_ = setup
    path = '/meetings/1/voice-assistant'
    base = {'enabled': True, 'include_transcript': True, 'documents': [], 'revision': 1}
    assert (await client.put(path, json=base | {'wake_variants': ['Hey Tina']}, headers={'X-User-Id': '7'})).status_code == 422
    approved = await client.put(path, json=base | {'wake_variants': ['Ti Na', 'TI NA', 'ti na ơi']}, headers={'X-User-Id': '7'})
    assert approved.status_code == 200
    assert approved.json()['policy']['wake_variants'] == ['ti na', 'ti na ơi']


async def test_anh_oi_is_refused_but_owner_requested_tin_oi_is_accepted(setup):
    client, *_ = setup
    for alias in ['Anh ơi']:
        response = await client.put('/meetings/1/voice-assistant', headers={'X-User-Id': '7'}, json={
            'enabled': True, 'include_transcript': True, 'documents': [], 'revision': 1, 'wake_variants': [alias]})
        assert response.status_code == 422
    response=await client.put('/meetings/1/voice-assistant',headers={'X-User-Id':'7'},json={
        'enabled':True,'include_transcript':True,'documents':[],'revision':1,'wake_variants':['Tin ơi']})
    assert response.status_code==200 and response.json()['policy']['wake_variants']==['tin ơi']


def diagnostic(code='name_not_matched', **changes):
    import time
    return {'event_id': str(uuid4()), 'code': code, 'observed_at_ms': int(time.time() * 1000),
            'heard_prefix': 'tiên na ơi', 'channel': 0, **changes}


async def test_audio_numbers_are_owner_and_session_scoped_bounded_and_expire(setup):
    import time
    client, repo, redis, *_ = setup
    now = int(time.time() * 1000)
    row = {'channel':0,'frames':5,'samples':5120,'last_frame_ms':now,'rms':.05,'sample_clock':True,
           'gap_samples':1024,'overlap_samples':0,'clock_resets':0,'asr_inflight':0,'asr_errors':0,'queue_ms':12.5}
    body = {'state':'LISTENING','audio':{'observed_at_ms':now,'channels':[row]}}
    path = '/bots/voice/1/current/state'
    assert (await client.post(path,json=body,headers=headers())).status_code == 200
    result = await client.get('/meetings/1/voice-assistant',headers={'X-User-Id':'7'})
    assert result.json()['runtime']['audio']['channels'][0]['queue_ms'] == 12.5
    assert await redis.ttl('meeting:voice:1:state') <= 15
    assert (await client.get('/meetings/1/voice-assistant',headers={'X-User-Id':'8'})).status_code == 404
    for changes in [{'text':'private'}, {'rms':2}, {'queue_ms':-1}, {'frames':True}]:
        bad = body | {'audio':body['audio'] | {'channels':[row | changes]}}
        assert (await client.post(path,json=bad,headers=headers())).status_code == 422
    assert (await client.post(path,json=body | {'audio':{'observed_at_ms':now,'channels':[row,row]}},headers=headers())).status_code == 422
    assert (await client.post(path,json=body | {'audio':{'observed_at_ms':now+6000,'channels':[row]}},headers=headers())).status_code == 422
    old = body | {'audio':{'observed_at_ms':now-16000,'channels':[row | {'last_frame_ms':now-16000}]}}
    assert (await client.post(path,json=old,headers=headers())).status_code == 200
    result=await client.get('/meetings/1/voice-assistant',headers={'X-User-Id':'7'})
    assert not result.json()['runtime'].get('audio')
    repo.row['status']='completed'
    assert not (await client.get('/meetings/1/voice-assistant',headers={'X-User-Id':'7'})).json()['runtime'].get('audio')


async def test_diagnostics_are_owner_only_ephemeral_and_do_not_change_meeting_or_transcript(setup):
    import json
    client, repo, redis, *_ = setup
    before = deepcopy(repo.row)
    detail = diagnostic(heard_prefix='tiên na ơi SECRET')
    r = await client.post('/bots/voice/1/current/state', headers=headers(), json={'state': 'LISTENING', 'diagnostic': detail})
    assert r.status_code == 200
    assert (await client.get('/meetings/1/voice-assistant', headers={'X-User-Id': '8'})).status_code == 404
    current = (await client.get('/meetings/1/voice-assistant', headers={'X-User-Id': '7'})).json()['runtime']
    assert current['diagnostic']['heard_prefix'] == 'tiên na ơi'
    assert current['diagnostic']['code'] == 'name_not_matched'
    assert current['session_active'] and current['heartbeat_fresh']
    assert 0 < await redis.pttl('meeting:voice:1:diagnostic') <= 30000
    state = await redis.get('meeting:voice:1:state')
    assert 'heard_prefix' not in state and 'SECRET' not in state
    assert repo.row == before
    await client.post('/bots/voice/1/current/state', headers=headers(), json={'state': 'LISTENING'})
    assert (await client.get('/meetings/1/voice-assistant', headers={'X-User-Id': '7'})).json()['runtime']['diagnostic']['event_id'] == detail['event_id']
    await redis.delete('meeting:voice:1:diagnostic')
    assert (await client.get('/meetings/1/voice-assistant', headers={'X-User-Id': '7'})).json()['runtime']['diagnostic'] is None


async def test_diagnostic_heartbeat_or_retry_cannot_extend_original_text_expiry(setup):
    import time
    client, repo, redis, *_ = setup
    detail = diagnostic(observed_at_ms=int(time.time() * 1000) - 10000)
    for _ in range(2):
        assert (await client.post('/bots/voice/1/current/state', headers=headers(), json={'state': 'LISTENING', 'diagnostic': detail})).status_code == 200
    assert 0 < await redis.pttl('meeting:voice:1:diagnostic') <= 20000
    expired = diagnostic(observed_at_ms=int(time.time() * 1000) - 31000)
    await redis.delete('meeting:voice:1:diagnostic')
    await client.post('/bots/voice/1/current/state', headers=headers(), json={'state': 'LISTENING', 'diagnostic': expired})
    assert not await redis.exists('meeting:voice:1:diagnostic')


async def test_old_session_and_departed_meeting_cannot_expose_or_write_diagnostics(setup):
    import json,time
    client, repo, redis, *_ = setup
    await redis.set('meeting:voice:1:diagnostic', json.dumps(diagnostic() | {'session_uid': 'old', 'expires_at_ms': int(time.time()*1000)+30000}))
    owner={'X-User-Id':'7'}
    assert (await client.get('/meetings/1/voice-assistant', headers=owner)).json()['runtime']['diagnostic'] is None
    assert (await client.post('/bots/voice/1/old/state', headers=headers('old'), json={'state':'LISTENING','diagnostic':diagnostic()})).status_code == 409
    repo.row['status']='completed'
    assert (await client.get('/meetings/1/voice-assistant', headers=owner)).json()['runtime']['diagnostic'] is None
    assert (await client.post('/bots/voice/1/current/state', headers=headers(), json={'state':'LISTENING','diagnostic':diagnostic()})).status_code == 409


async def test_diagnostic_boundary_rejects_unknown_codes_and_unbounded_text(setup):
    client,*_=setup
    for detail in [diagnostic(code='untrusted message'), diagnostic(heard_prefix='x'*65), diagnostic(channel=-1)]:
        assert (await client.post('/bots/voice/1/current/state', headers=headers(), json={'state':'LISTENING','diagnostic':detail})).status_code == 422


@pytest.mark.parametrize('failed_host,reason', [('agent.test','sources_unavailable'),('tts.test','tts_unavailable')])
async def test_readiness_diagnostics_separate_tts_from_source_failure(setup, failed_host, reason):
    client,repo,redis,*_=setup
    async def upstream(request):
        return httpx.Response(503 if request.url.host==failed_host else 200,json={'documents':[]})
    def factory(**kwargs):return httpx.AsyncClient(transport=httpx.MockTransport(upstream),**kwargs)
    app=FastAPI();app.include_router(build_voice_router(repo,redis,redis,client_factory=factory))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as scoped:
        value=(await scoped.get('/bots/voice/1/current/config',headers=headers())).json()
        assert value['ready'] is False and value['unavailable_reason']==reason


async def test_new_diagnostics_win_over_delayed_old_events_and_stage_changes_do_not_refresh_prefix(setup):
    import time
    client,repo,redis,*_=setup
    now=int(time.time()*1000)
    latest=diagnostic(code='waiting_asr_tail',observed_at_ms=now,heard_at_ms=now-10000)
    await client.post('/bots/voice/1/current/state',headers=headers(),json={'state':'CAPTURING','diagnostic':latest})
    assert 0<await redis.pttl('meeting:voice:1:diagnostic')<=20000
    old=diagnostic(observed_at_ms=now-20000)
    await client.post('/bots/voice/1/current/state',headers=headers(),json={'state':'LISTENING','diagnostic':old})
    value=(await client.get('/meetings/1/voice-assistant',headers={'X-User-Id':'7'})).json()['runtime']['diagnostic']
    assert value['event_id']==latest['event_id'] and value['code']=='waiting_asr_tail'


async def test_conversation_history_requires_completed_playback_and_same_speaker_session_policy(setup):
    import json
    client, repo, redis, *_ = setup
    seen = []
    async def upstream(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={'text': 'Demo is Monday.',
                              'sources': [{'key': 'segment:demo', 'fingerprint': 'a' * 64}]})
    def factory(**kwargs): return httpx.AsyncClient(transport=httpx.MockTransport(upstream), **kwargs)
    store = PlaybackStore(redis, repo.save_voice_reply)
    app = FastAPI(); app.include_router(build_voice_router(repo, redis, redis, store, client_factory=factory))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as scoped:
        async def ask(speaker, revision=1):
            body = question() | {'revision': revision}
            h = headers() | ({'X-Voice-Speaker-Key': speaker} if speaker else {})
            r = await scoped.post('/bots/voice/1/current/answer', headers=h, json=body)
            assert r.status_code == 200, r.text
            return body
        async def finish(body, completed):
            if completed:
                await store.report(1, body['request_id'], 'current', 'started')
                await store.report(1, body['request_id'], 'current', 'completed')
            await scoped.post('/bots/voice/1/current/state', headers=headers(),
                              json={'state': 'QUIET', 'request_id': body['request_id']})
        first = await ask('a' * 64); assert seen[-1]['history'] == []
        await finish(first, False)
        second = await ask('a' * 64); assert seen[-1]['history'] == []
        await finish(second, True)
        third = await ask('a' * 64)
        assert len(seen[-1]['history']) == 1
        assert seen[-1]['history'][0]['answer'] == 'Demo is Monday.'
        await finish(third, True)
        other = await ask('b' * 64); assert not seen[-1]['history']; await finish(other, True)
        legacy = await ask(None); assert not seen[-1]['history']; await finish(legacy, True)
        repo.row['data']['voice_assistant']['revision'] = 2
        changed = await ask('a' * 64, 2); assert not seen[-1]['history']; await finish(changed, True)
        assert await redis.ttl('meeting:voice:1:current:history:1:' + 'a' * 64) <= 900
        bad = await scoped.post('/bots/voice/1/current/answer', headers=headers() | {'X-Voice-Speaker-Key': 'display name'}, json=question())
        assert bad.status_code == 422


async def test_completed_clarification_is_context_only_and_internal_refs_are_not_returned(setup):
    import json
    _, repo, redis, *_ = setup
    seen = []
    async def upstream(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={'text': 'Bạn hỏi bản demo hay bản chính thức?', 'sources': [],
            'clarification': True, 'context_refs': [{'key': 'segment:demo', 'fingerprint': 'a' * 64}]})
    def factory(**kwargs): return httpx.AsyncClient(transport=httpx.MockTransport(upstream), **kwargs)
    store = PlaybackStore(redis, repo.save_voice_reply)
    app = FastAPI(); app.include_router(build_voice_router(repo, redis, redis, store, client_factory=factory))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        h = headers() | {'X-Voice-Speaker-Key': 'a' * 64}
        body = question()
        r = await client.post('/bots/voice/1/current/answer', headers=h, json=body)
        assert r.status_code == 200 and r.json()['clarification'] is True
        assert 'context_refs' not in r.json() and not r.json()['evidence_available']
        await store.report(1, body['request_id'], 'current', 'started')
        await store.report(1, body['request_id'], 'current', 'completed')
        await client.post('/bots/voice/1/current/state', headers=headers(), json={'state': 'QUIET', 'request_id': body['request_id']})
        r = await client.post('/bots/voice/1/current/answer', headers=h, json=question())
        assert r.status_code == 200 and seen[-1]['history'][0]['answer'].endswith('?')
        assert seen[-1]['history'][0]['clarification'] is True


async def test_interrupted_history_keeps_only_monotonic_completed_sentences_and_session_source_scope(setup):
    import json
    _,repo,redis,*_=setup;seen=[]
    async def upstream(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200,json={'text':'Lan phụ trách demo. Hạn thứ Sáu.',
            'sources':[{'key':'segment:demo','fingerprint':'a'*64}]})
    def factory(**kwargs):return httpx.AsyncClient(transport=httpx.MockTransport(upstream),**kwargs)
    store=PlaybackStore(redis,repo.save_voice_reply);app=FastAPI()
    app.include_router(build_voice_router(repo,redis,redis,store,client_factory=factory))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        h=headers()|{'X-Voice-Speaker-Key':'a'*64};body=question();identifier=body['request_id']
        assert (await client.post('/bots/voice/1/current/answer',headers=h,json=body)).status_code==200
        await store.report(1,identifier,'current','started')
        await store.report(1,identifier,'current','started',played_text='Lan phụ trách demo.')
        from meeting_api.lifecycle.speech_status import SpeechConflict
        for text in ['invented','Lan']:
            with pytest.raises(SpeechConflict):await store.report(1,identifier,'current','started',played_text=text)
        await store.report(1,identifier,'current','stopped',played_text='Lan phụ trách demo.')
        await store.report(1,identifier,'current','completed')
        await client.post('/bots/voice/1/current/state',headers=headers(),json={'state':'QUIET','request_id':identifier})
        reply=repo.row['data']['voice_replies'][identifier]
        assert reply['state']=='stopped' and reply['played_text']=='Lan phụ trách demo.'
        assert reply['text']=='Lan phụ trách demo. Hạn thứ Sáu.','preserve the generated proposal separately'
        assert (await client.post('/bots/voice/1/current/answer',headers=h,json=question())).status_code==200
        history=seen[-1]['history'];assert len(history)==1 and history[0]['answer']=='Lan phụ trách demo.'
        assert 'Hạn thứ Sáu' not in json.dumps(history) and history[0]['clarification'] is False



async def test_public_answer_options_are_owner_scoped_opt_in_and_revision_bound(setup):
    client, repo, redis, *_ = setup
    policy={'enabled':True,'include_transcript':False,'documents':[],'revision':1,
            'allow_general_knowledge':True,'allow_web_search':True}
    assert (await client.put('/meetings/1/voice-assistant',headers={'X-User-Id':'8'},json=policy)).status_code==404
    response=await client.put('/meetings/1/voice-assistant',headers={'X-User-Id':'7'},json=policy)
    assert response.status_code==200 and response.json()['policy']['allow_web_search']
    assert response.json()['policy']['revision']==2
    from meeting_api.lifecycle.voice import VoicePolicy
    assert not VoicePolicy().allow_web_search and not VoicePolicy().allow_general_knowledge


def test_public_answer_metadata_is_validated_and_survives_playback_projection():
    from meeting_api.lifecycle.voice_replies import VoiceReply, merge_reply, public_replies
    reply=VoiceReply(request_id=uuid4(),text='Public reply.',state='completed',created_at_ms=1,updated_at_ms=2,
                     answer_kind='web',links=[{'url':'https://redis.io/docs/','title':'Redis'}],
                     lookups=[{'tool':'search_meeting','source_count':2}]).model_dump(mode='json')
    row={'data':merge_reply({},'current',reply)}
    assert public_replies(row,'current')[0]['links']==reply['links']
    for url in ['javascript:alert(1)','https://user:pass@example.com','file:///tmp/secret']:
        with pytest.raises(ValueError): VoiceReply.model_validate(reply|{'links':[{'url':url,'title':'bad'}]})
