from contextlib import asynccontextmanager
from uuid import uuid4

import asyncio
import socket
import httpx
import pytest
import uvicorn
from livekit.agents import AgentSession

import server

SESSION=str(uuid4())
HEADERS={'Authorization':'Bearer test-meeting-capability'}
URL=f'/bots/1/{SESSION}'


@pytest.fixture
async def service(monkeypatch):
    monkeypatch.delenv('MEETING_API_URL',raising=False)
    calls=[];blocked=[None];entered=asyncio.Event();connect_gate=[None];connect_entered=asyncio.Event()
    broken_tts=[False];config_hook=[None];config_status=[200]
    class PartialTTS(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'\0\0'*24000
            await asyncio.sleep(.1)
            raise httpx.ReadError('synthetic TTS connection lost after partial PCM')
    state={'engine':'livekit','enabled':True,'revision':1}
    heard={};planned=set()
    async def upstream(request):
        calls.append(request)
        if request.url.path.endswith('/config'):
            assert request.url.host=='meeting-api' and request.url.port==8080
            if config_hook[0]: await config_hook[0]()
            if request.headers.get('Authorization')!=HEADERS['Authorization']:return httpx.Response(401)
            return httpx.Response(config_status[0],json=state)
        if request.url.path.endswith('/agent'):
            import json
            body=json.loads(request.content)
            if body['operation']=='plan' and state.get('planning_unavailable'):
                return httpx.Response(503,json={'detail':'Synthetic planner outage'})
            if body['operation']=='context': return httpx.Response(200,json={'history':heard.get(request.headers.get('X-Voice-Speaker-Key'),[]),'available_tools':['search_meeting']})
            if body['operation']=='plan':
                if body['request_id'] in planned:return httpx.Response(200,json={'tool_calls':[]})
                planned.add(body['request_id'])
                plan=[{'name':'search_meeting','query':'demo'}]
                if state.get('two_tools'):plan.append({'name':'search_shared_documents','query':'demo'})
                return httpx.Response(200,json={'tool_calls':plan})
            return httpx.Response(200,json={'tool':'search_meeting','source_count':1,'sources':[{'id':'s0','text':'Lan phụ trách demo.'}]})
        if request.url.path.endswith('/answer'):
            entered.set()
            if blocked[0]: await blocked[0].wait()
            return httpx.Response(200,json={'text':'Lan phụ trách demo.','reason':'answered','sources':[{'id':'s0'}]})
        if broken_tts[0]: return httpx.Response(200,stream=PartialTTS())
        return httpx.Response(200,content=b'\0\0'*2400,headers={'x-audio-sample-rate':'24000','x-audio-channels':'1'})
    original_start=AgentSession.start
    async def start(self,agent,**kwargs):return await original_start(self,agent)
    monkeypatch.setattr(AgentSession,'start',start)
    async def disconnect():pass
    async def connect(name):
        connect_entered.set()
        if connect_gate[0]: await connect_gate[0].wait()
        from types import SimpleNamespace
        return SimpleNamespace(disconnect=disconnect)
    async def delete(name):pass
    monkeypatch.setattr(server,'delete_room',delete)
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as upstream_client:
        app=server.create_app(client=upstream_client,room_connector=connect)
        app.state.blocked=blocked;app.state.entered=entered
        app.state.connect_gate=connect_gate;app.state.connect_entered=connect_entered
        app.state.broken_tts=broken_tts
        app.state.config_hook=config_hook
        app.state.config_status=config_status
        app.state.heard=heard
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://pilot') as client:
                yield client,calls,state,app


def question():return {'request_id':str(uuid4()),'question':'Ai làm demo?','revision':1}


async def test_capability_policy_revision_and_payload_guard_before_runtime_creation(service):
    client,calls,state,app=service
    assert (await client.post(URL+'/answer',json=question())).status_code==401
    assert (await client.post(URL+'/answer',headers={'Authorization':'Bearer other'},json=question())).status_code==403
    state['engine']='tina'
    assert (await client.post(URL+'/answer',headers=HEADERS,json=question())).status_code==409
    state['engine']='livekit';state['revision']=2
    assert (await client.post(URL+'/answer',headers=HEADERS,json=question())).status_code==409
    assert (await client.post(URL+'/answer',headers=HEADERS,json=question()|{'documents':['private.md']})).status_code==422
    assert (await client.post(URL+'/answer',headers=HEADERS,content=b'x'*20001)).status_code==413
    async def chunked_body(): yield b'{}'
    assert (await client.post(URL+'/answer',headers=HEADERS,content=chunked_body())).status_code==413
    assert not app.state.rows


async def test_real_agents_answer_preserves_citations_and_speaker_scope(service):
    client,calls,state,app=service
    response=await client.post(URL+'/answer',headers=HEADERS|{'X-Voice-Speaker-Key':'a'*64},json=question())
    assert response.status_code==200,response.text
    assert response.json()['voice_runtime']=='livekit' and response.json()['sources']==[{'id':'s0'}]
    answers=[r for r in calls if r.url.path.endswith('/answer')]
    assert len(answers)==1 and answers[0].headers['X-Voice-Speaker-Key']=='a'*64
    import json
    operations=[json.loads(r.content)['operation'] for r in calls if r.url.path.endswith('/agent')]
    assert operations==['context','plan','lookup','plan']
    assert json.loads(answers[0].content)['agent_context']==[]
    assert len(app.state.rows)==1
    assert (await client.post(f'/bots/2/{uuid4()}/answer',headers=HEADERS,json=question())).status_code==503


async def test_real_agents_pcm_uses_existing_tts_and_stop_fences_only_its_turn(service):
    client,calls,state,app=service
    body=question()
    assert (await client.post(URL+'/answer',headers=HEADERS,json=body)).status_code==200
    headers=HEADERS|{'X-Voice-Revision':'1','X-Voice-Request-Id':body['request_id']}
    speech={'input':'Lan phụ trách demo.','meeting_id':1,'response_format':'pcm'}
    response=await client.post(URL+'/v1/audio/speech',headers=headers,json=speech)
    assert response.status_code==200 and 4800<=len(response.content)<=5760
    assert response.headers['x-audio-sample-rate']=='24000'
    stopped=await client.request('DELETE',URL+'/turn',headers=HEADERS,json={'request_id':body['request_id']})
    assert stopped.status_code==200
    assert (await client.post(URL+'/answer',headers=HEADERS,json=body)).status_code==409
    assert (await client.post(URL+'/answer',headers=HEADERS,json=question())).status_code==200
    assert len([r for r in calls if r.url.path.endswith('/v1/audio/speech')])==1


async def test_stop_during_real_agents_llm_cancels_the_deferred_backend_and_cannot_resume(service):
    client,calls,state,app=service
    gate=asyncio.Event();app.state.blocked[0]=gate
    body=question()
    task=asyncio.create_task(client.post(URL+'/answer',headers=HEADERS,json=body))
    try:
        await asyncio.wait_for(app.state.entered.wait(),2)
        assert (await client.request('DELETE',URL+'/turn',headers=HEADERS,json={'request_id':body['request_id']})).status_code==200
        response=await asyncio.wait_for(task,2)
        assert response.status_code==409
        assert (await client.post(URL+'/answer',headers=HEADERS,json=body)).status_code==409
        gate.set();app.state.blocked[0]=None
        fresh=await client.post(URL+'/answer',headers=HEADERS,json=question())
        assert fresh.status_code==200
        assert len([r for r in calls if r.url.path.endswith('/answer')])==2
    finally:
        gate.set();task.cancel()


async def test_stop_while_room_is_connecting_fences_the_future_turn_before_llm_dispatch(service):
    client,calls,state,app=service
    gate=asyncio.Event();app.state.connect_gate[0]=gate
    body=question();task=asyncio.create_task(client.post(URL+'/answer',headers=HEADERS,json=body))
    try:
        await asyncio.wait_for(app.state.connect_entered.wait(),2)
        assert not app.state.rows
        assert (await client.request('DELETE',URL+'/turn',headers=HEADERS,json={'request_id':body['request_id']})).status_code==200
        gate.set()
        response=await asyncio.wait_for(task,2)
        assert response.status_code==409
        assert not [r for r in calls if r.url.path.endswith('/answer')]
    finally:gate.set();task.cancel()


@pytest.mark.parametrize('failures',[1,4])
async def test_partial_tts_failure_never_finishes_a_successful_pcm_response_and_next_turn_recovers(service,failures):
    client,calls,state,app=service
    app.state.broken_tts[0]=True
    headers=HEADERS|{'X-Voice-Revision':'1','X-Voice-Request-Id':str(uuid4())}
    body={'input':'Synthetic complete answer whose audio fails halfway.','meeting_id':1}
    for _ in range(failures):
        headers['X-Voice-Request-Id']=str(uuid4())
        with pytest.raises(RuntimeError,match='Agent speech failed'):
            await client.post(URL+'/v1/audio/speech',headers=headers,json=body)
    row=app.state.rows[(1,SESSION)]
    assert row.pending_audio==0 and not row.lock.locked()
    app.state.broken_tts[0]=False
    response=await client.post(URL+'/v1/audio/speech',headers=headers|{'X-Voice-Request-Id':str(uuid4())},json=body)
    assert response.status_code==200 and len(response.content)>0


async def test_stale_reaper_cannot_close_a_replacement_runtime_or_delete_its_room(service,monkeypatch):
    client,calls,state,app=service
    old_check=asyncio.Event();release_check=asyncio.Event()
    closing=asyncio.Event();release_close=asyncio.Event()
    deleted=[];closed=[]
    async def delete(name): deleted.append(name)
    monkeypatch.setattr(server,'delete_room',delete)
    original_close=server.Runtime.close
    async def close(row):
        closed.append(row)
        if len(closed)==1:
            closing.set()
            await release_close.wait()
        await original_close(row)
    monkeypatch.setattr(server.Runtime,'close',close)
    old=await app.state.get_runtime(1,SESSION,HEADERS['Authorization'],1)
    async def hold_old_check():
        app.state.config_hook[0]=None
        old_check.set()
        await release_check.wait()
    app.state.config_hook[0]=hold_old_check
    replacement=None
    try:
        await asyncio.wait_for(old_check.wait(),4)
        state['revision']=2
        replacement=asyncio.create_task(app.state.get_runtime(1,SESSION,HEADERS['Authorization'],2))
        await asyncio.wait_for(closing.wait(),2)
        release_check.set()
        # The old reaper must queue behind replacement while the old runtime is being closed.
        await asyncio.sleep(.03)
        release_close.set()
        new=await asyncio.wait_for(replacement,2)
        await asyncio.sleep(.05)
        assert app.state.rows[(1,SESSION)] is new
        assert closed.count(old)==1 and deleted==[old.room_name]
        assert new.room_name!=old.room_name
        body=question()|{'revision':2}
        assert (await client.post(URL+'/answer',headers=HEADERS,json=body)).status_code==200
    finally:
        release_check.set();release_close.set()
        if replacement and not replacement.done():replacement.cancel()


async def test_truncated_tts_aborts_the_real_http_chunked_stream(service):
    _,calls,state,app=service
    app.state.broken_tts[0]=True
    listener=socket.socket()
    listener.bind(('127.0.0.1',0))
    port=listener.getsockname()[1]
    worker=uvicorn.Server(uvicorn.Config(app,lifespan='off',log_config=None,log_level='critical',
                                        access_log=False,timeout_graceful_shutdown=1))
    task=asyncio.create_task(worker.serve(sockets=[listener]))
    received=0
    try:
        async with asyncio.timeout(3):
            while not worker.started: await asyncio.sleep(.01)
        async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}',timeout=5) as client:
            async with client.stream('POST',URL+'/v1/audio/speech',headers=HEADERS|{
                'X-Voice-Revision':'1','X-Voice-Request-Id':str(uuid4())},
                json={'input':'Synthetic complete answer.','meeting_id':1}) as response:
                assert response.status_code==200
                with pytest.raises(httpx.RemoteProtocolError):
                    async for chunk in response.aiter_bytes(): received+=len(chunk)
        assert received>0
    finally:
        worker.should_exit=True
        await asyncio.wait_for(task,3)
        listener.close()


@pytest.mark.parametrize('core_status',[200,503,'unreachable'])
async def test_readiness_checks_the_real_meeting_api_endpoint(monkeypatch,core_status):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    monkeypatch.delenv('MEETING_API_URL',raising=False)
    class LiveKit:
        room=SimpleNamespace(list_rooms=AsyncMock(return_value=None))
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
    monkeypatch.setattr(server.api,'LiveKitAPI',LiveKit)
    async def upstream(request):
        assert str(request.url)=='http://meeting-api:8080/health'
        if core_status=='unreachable':raise httpx.ConnectError('synthetic refused connection')
        return httpx.Response(core_status)
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as upstream_client:
        app=server.create_app(client=upstream_client)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://pilot') as client:
            response=await client.get('/health')
            assert response.status_code==(200 if core_status==200 else 503)
            if core_status==200:assert response.json()['ready'] is True


def test_compose_pilot_uses_the_same_meeting_api_as_the_gateway():
    from pathlib import Path
    import yaml
    compose=yaml.safe_load((Path(__file__).resolve().parents[1]/'compose/docker-compose.yml').read_text())
    services=compose['services']
    gateway=dict(item.split('=',1) for item in services['gateway']['environment'])
    assert services['livekit-agent']['environment']['MEETING_API_URL']==gateway['MEETING_API_URL']=='http://meeting-api:8080'


@pytest.mark.parametrize('upstream_status,expected',[(401,403),(403,403),(404,403),(409,409),
                                                  (429,503),(500,503),(503,503),(504,503)])
async def test_config_distinguishes_permission_failures_from_service_outages(service,upstream_status,expected):
    _,_,_,app=service
    app.state.config_status[0]=upstream_status
    with pytest.raises(server.HTTPException) as failure:
        await app.state.get_runtime(1,SESSION,HEADERS['Authorization'],1)
    assert failure.value.status_code==expected
    assert not app.state.rows


async def test_transient_503_keeps_an_inflight_answer_and_recovers_without_replacing_its_room(service):
    client,_,_,app=service
    gate=asyncio.Event();checked=asyncio.Event();app.state.blocked[0]=gate
    body=question()
    task=asyncio.create_task(client.post(URL+'/answer',headers=HEADERS,json=body))
    try:
        await asyncio.wait_for(app.state.entered.wait(),2)
        row=app.state.rows[(1,SESSION)]
        app.state.config_status[0]=503
        async def observe_check():checked.set()
        app.state.config_hook[0]=observe_check
        await asyncio.wait_for(checked.wait(),4)
        await asyncio.sleep(.05)
        assert app.state.rows.get((1,SESSION)) is row and row.lock.locked()
        assert not task.done()
        app.state.config_status[0]=200;app.state.config_hook[0]=None
        gate.set()
        response=await asyncio.wait_for(task,2)
        assert response.status_code==200 and response.json()['reason']=='answered'
        assert app.state.rows[(1,SESSION)] is row
    finally:
        gate.set()
        if not task.done():task.cancel()


async def test_sdk_chat_context_is_per_caller_and_refreshes_only_played_prefixes(service):
    import json,time
    client,calls,state,app=service
    a,b='a'*64,'b'*64
    turn={'question':'Ai làm demo?','answer':'Lan phụ trách demo.', 'created_at_ms':int(time.time()*1000)-1000}
    app.state.heard[a]=[turn]
    for speaker in (a,b,a):
        if speaker==a and len([r for r in calls if r.url.path.endswith('/answer')])==2:
            app.state.heard[a]=[turn|{'answer':'Lan phụ trách'}]  # Actual stopped playback prefix.
        response=await client.post(URL+'/answer',headers=HEADERS|{'X-Voice-Speaker-Key':speaker},json=question())
        assert response.status_code==200,response.text
    bodies=[json.loads(r.content) for r in calls if r.url.path.endswith('/answer')]
    assert [b['agent_context'] for b in bodies]==[[turn],[],[turn|{'answer':'Lan phụ trách'}]]
    row=next(iter(app.state.rows.values()))
    assert server.context_turns(row.contexts[a][1])==[turn|{'answer':'Lan phụ trách'}]
    assert server.context_turns(row.contexts[b][1])==[]
    messages=row.session.current_agent.chat_ctx.items
    assert [m.text_content for m in messages if m.type=='message' and m.role=='assistant']==['Lan phụ trách']


async def test_repeated_planner_failures_release_core_turn_and_recover_when_service_returns(service):
    import json
    client,calls,state,app=service
    state['planning_unavailable']=True
    for _ in range(4):
        response=await client.post(URL+'/answer',headers=HEADERS,json=question())
        assert response.status_code==503
    state['planning_unavailable']=False
    assert (await client.post(URL+'/answer',headers=HEADERS,json=question())).status_code==200
    cancelled=[json.loads(r.content) for r in calls if r.url.path.endswith('/state')]
    assert len(cancelled)==4 and all(c['state']=='QUIET' for c in cancelled)


async def test_sdk_executes_transcript_and_wiki_tools_before_one_verified_final(service):
    import json
    client,calls,state,app=service
    state['two_tools']=True
    assert (await client.post(URL+'/answer',headers=HEADERS,json=question())).status_code==200
    operations=[json.loads(r.content) for r in calls if r.url.path.endswith('/agent')]
    assert len([op for op in operations if op['operation']=='plan'])==2
    assert {op['lookup']['name'] for op in operations if op['operation']=='lookup'}=={'search_meeting','search_shared_documents'}
    assert len([r for r in calls if r.url.path.endswith('/answer')])==1
