from contextlib import asynccontextmanager
from uuid import uuid4

import httpx
import pytest
from livekit.agents import AgentSession

import server

SESSION=str(uuid4())
HEADERS={'Authorization':'Bearer test-meeting-capability'}
URL=f'/bots/1/{SESSION}'


@pytest.fixture
async def service(monkeypatch):
    calls=[]
    state={'engine':'livekit','enabled':True,'revision':1}
    async def upstream(request):
        calls.append(request)
        if request.url.path.endswith('/config'):
            if request.headers.get('Authorization')!=HEADERS['Authorization']:return httpx.Response(401)
            return httpx.Response(200,json=state)
        if request.url.path.endswith('/answer'):
            return httpx.Response(200,json={'text':'Lan phụ trách demo.','reason':'answered','sources':[{'id':'s0'}]})
        return httpx.Response(200,content=b'\0\0'*2400,headers={'x-audio-sample-rate':'24000','x-audio-channels':'1'})
    original_start=AgentSession.start
    async def start(self,agent,**kwargs):return await original_start(self,agent)
    monkeypatch.setattr(AgentSession,'start',start)
    async def disconnect():pass
    async def connect(name):
        from types import SimpleNamespace
        return SimpleNamespace(disconnect=disconnect)
    async def delete(name):pass
    monkeypatch.setattr(server,'delete_room',delete)
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as upstream_client:
        app=server.create_app(client=upstream_client,room_connector=connect)
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
    assert not app.state.rows


async def test_real_agents_answer_preserves_citations_and_speaker_scope(service):
    client,calls,state,app=service
    response=await client.post(URL+'/answer',headers=HEADERS|{'X-Voice-Speaker-Key':'a'*64},json=question())
    assert response.status_code==200,response.text
    assert response.json()['voice_runtime']=='livekit' and response.json()['sources']==[{'id':'s0'}]
    answers=[r for r in calls if r.url.path.endswith('/answer')]
    assert len(answers)==1 and answers[0].headers['X-Voice-Speaker-Key']=='a'*64
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
