"""One-room Agents pilot with capability-authenticated TINA text/PCM custom I/O."""
import asyncio
from collections import deque, OrderedDict
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from datetime import timedelta
import logging
import os
import time
from uuid import UUID, uuid4

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from livekit import api, rtc
from livekit.agents import Agent, AgentSession, llm
from livekit.agents.types import APIConnectOptions
from livekit.agents.voice import SessionConnectOptions

from adapters import TinaLLM, VieNeuTTS, SynthesisStatus, HttpAudioOutput, SAMPLE_RATE

MAX_ROOMS = 3

# Framework/provider logs must not include source text, questions, PCM or bearer capabilities.
logging.getLogger('livekit.agents').setLevel(logging.CRITICAL)
logging.getLogger('httpx').setLevel(logging.WARNING)


class BoundedBody:
    """Validate headers without wrapping streamed errors in BaseHTTPMiddleware."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type']=='http' and scope['method'] in ('POST','DELETE'):
            length = dict(scope['headers']).get(b'content-length',b'')
            if not length.isdigit() or len(length)>6 or int(length)>20000:
                await JSONResponse({'detail':'Bounded request body required'},status_code=413)(scope,receive,send)
                return
        await self.app(scope,receive,send)


class Question(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: UUID
    question: str = Field(min_length=1, max_length=2000)
    revision: int = Field(ge=0)


class HeardTurn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    question: str = Field(min_length=1, max_length=2000)
    answer: str = Field(min_length=1, max_length=4000)
    created_at_ms: int = Field(ge=0)


def heard_context(turns):
    context = llm.ChatContext.empty()
    for turn in turns:
        context.add_message(role='user', content=turn.question, created_at=turn.created_at_ms/1000)
        context.add_message(role='assistant', content=turn.answer, created_at=turn.created_at_ms/1000)
    return context


def context_turns(context):
    messages = [m for m in context.items if m.type == 'message' and m.role in ('user','assistant')]
    return [{'question':a.text_content,'answer':b.text_content,'created_at_ms':round(a.created_at*1000)}
            for a,b in zip(messages[::2],messages[1::2])]


class Speech(BaseModel):
    model_config = ConfigDict(extra='forbid')
    model: str = 'tts-1'
    input: str = Field(min_length=1, max_length=4000)
    voice: str = Field(default='auto', max_length=64)
    response_format: str = Field(default='pcm', pattern='^pcm$')
    meeting_id: int = Field(gt=0)


class Stop(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: UUID


async def connect_room(name):
    room = rtc.Room()
    token = api.AccessToken().with_identity('tina-agent').with_ttl(timedelta(minutes=2)).with_grants(
        api.VideoGrants(room_join=True, room=name, can_publish=False, can_subscribe=False, can_publish_data=False)).to_jwt()
    try:
        await asyncio.wait_for(room.connect(os.environ['LIVEKIT_URL'], token,
            options=rtc.RoomOptions(auto_subscribe=False)), 12)
    except BaseException:
        await room.disconnect()
        raise
    return room


async def delete_room(name):
    with suppress(Exception):
        async with api.LiveKitAPI() as livekit:
            await asyncio.wait_for(livekit.room.delete_room(api.DeleteRoomRequest(room=name)), 4)


@dataclass
class Runtime:
    room: object
    session: AgentSession
    model: TinaLLM
    tts: VieNeuTTS
    revision: int
    token: str
    room_name: str
    current_id: str | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    touched: float = field(default_factory=time.monotonic)
    pending_audio: int = 0
    failed: bool = False
    contexts: OrderedDict = field(default_factory=OrderedDict)

    async def close(self):
        with suppress(Exception):
            await asyncio.wait_for(self.session.aclose(),5)
        with suppress(Exception):
            await asyncio.wait_for(self.room.disconnect(),5)
        await delete_room(self.room_name)


class PCMResponse(StreamingResponse):
    """Release admission even when the client disconnects before the iterator starts."""
    def __init__(self, content, runtime):
        super().__init__(content, media_type='audio/pcm', headers={
            'X-Audio-Sample-Rate': str(SAMPLE_RATE), 'X-Audio-Channels': '1', 'Cache-Control': 'no-store'})
        self.runtime = runtime

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            try:
                await self.body_iterator.aclose()
            finally:
                self.runtime.pending_audio -= 1


def create_app(client=None, room_connector=connect_room):
    core = os.environ.get('MEETING_API_URL', 'http://meeting-api:8080').rstrip('/')
    tts_url = os.environ.get('TTS_SERVICE_URL', 'http://tts:8000').rstrip('/')
    tts_token = os.environ.get('TTS_API_TOKEN', '')
    http = client or httpx.AsyncClient(timeout=150, follow_redirects=False)
    rows, opening, stopped = {}, asyncio.Lock(), deque(maxlen=128)

    async def config(mid, session, token, revision=None):
        if mid <= 0 or len(session) > 128:
            raise HTTPException(422, 'Invalid meeting session')
        try: UUID(session)
        except ValueError: raise HTTPException(422, 'Invalid meeting session') from None
        if not token.startswith('Bearer ') or len(token) > 256:
            raise HTTPException(401, 'Voice capability required')
        try:
            r = await http.get(f'{core}/bots/voice/{mid}/{session}/config', headers={
                'Authorization': token,'X-TINA-Voice-Runtime':'livekit-v1'}, timeout=5)
        except httpx.HTTPError: raise HTTPException(503, 'TINA is unavailable') from None
        if r.status_code in (401,403,404):
            raise HTTPException(403, 'Voice capability or active session rejected')
        if r.status_code == 409:
            raise HTTPException(409, 'Voice session or policy changed')
        if r.status_code != 200:
            raise HTTPException(503, 'TINA is unavailable')
        try: value = r.json()
        except ValueError: raise HTTPException(503,'Invalid TINA configuration response') from None
        if not isinstance(value,dict) or value.get('enabled') is not True or value.get('engine') != 'livekit' or revision is not None and value.get('revision') != revision:
            raise HTTPException(409, 'Voice runtime policy changed')
        return value

    async def get_runtime(mid, session, token, revision):
        await config(mid, session, token, revision)
        key = (mid, session)
        async with opening:
            row = rows.get(key)
            if row and (row.revision != revision or row.token != token or row.failed):
                if row.lock.locked(): raise HTTPException(409, 'Previous voice turn is stopping')
                rows.pop(key); await row.close(); row = None
            if row:
                if getattr(row.room,'connection_state',rtc.ConnectionState.CONN_CONNECTED) != rtc.ConnectionState.CONN_CONNECTED:
                    if row.lock.locked(): raise HTTPException(503,'LiveKit room is reconnecting')
                    rows.pop(key); await row.close(); row=None
            if row:
                row.touched = time.monotonic()
                return row
            if len(rows) >= MAX_ROOMS: raise HTTPException(503, 'LiveKit meeting capacity is full')
            async def answer(request):
                headers = {'Authorization': token}
                if request['speaker']: headers['X-Voice-Speaker-Key'] = request['speaker']
                r = await http.post(f'{core}/bots/voice/{mid}/{session}/answer', json=request['body'], headers=headers)
                if r.status_code != 200 or len(r.content) > 200000: raise RuntimeError('TINA answer rejected')
                return r.json()
            async def agent(request, operation, lookup=None):
                headers = {'Authorization': token}
                if request['speaker']: headers['X-Voice-Speaker-Key'] = request['speaker']
                body = request['body'] | {'operation':operation}
                if operation == 'context': body.pop('agent_context', None)
                if lookup is not None: body['lookup'] = lookup
                r = await http.post(f'{core}/bots/voice/{mid}/{session}/agent', json=body, headers=headers)
                if r.status_code != 200 or len(r.content) > 200000: raise RuntimeError('TINA agent operation rejected')
                return r.json()
            async def speech(text):
                async with http.stream('POST', tts_url+'/v1/audio/speech', headers={'X-API-Key': tts_token},
                    json={'model':'tts-1','input':text,'voice':'auto','response_format':'pcm','meeting_id':mid}, timeout=145) as r:
                    if (r.status_code != 200 or r.headers.get('x-audio-sample-rate','24000') != '24000'
                            or r.headers.get('x-audio-channels','1') != '1'):
                        raise RuntimeError('Local TTS rejected')
                    async for chunk in r.aiter_bytes(): yield chunk
            # A late server-side deletion must never target a replacement generation's room.
            name = f'tina-meeting-{mid}-{session}-{uuid4().hex}'
            room = await room_connector(name)
            model = TinaLLM(answer, agent)
            tts = VieNeuTTS(speech)
            session_io = AgentSession(llm=model, tts=tts, vad=None, max_tool_steps=3, turn_handling={'turn_detection':'manual','interruption':{'resume_false_interruption':False}},
                user_away_timeout=None, conn_options=SessionConnectOptions(
                    llm_conn_options=APIConnectOptions(max_retry=0,timeout=160),
                    tts_conn_options=APIConnectOptions(max_retry=0,timeout=145)))
            try:
                from livekit.agents.voice import room_io
                await session_io.start(Agent(instructions='Use only the authorized TINA backend.', tools=model.tools()),room=room,
                    session_host=False,record=False,room_options=room_io.RoomOptions(
                        audio_input=False,video_input=False,text_input=False,audio_output=False,text_output=False,
                        close_on_disconnect=False))
            except BaseException:
                await session_io.aclose(); await room.disconnect(); await delete_room(name)
                raise
            row = Runtime(room,session_io,model,tts,revision,token,name)
            rows[key] = row
            return row

    async def reap():
        while True:
            await asyncio.sleep(2)
            for key, row in list(rows.items()):
                invalid = False
                try:
                    await config(*key, row.token, row.revision)
                except HTTPException as exc:
                    invalid = exc.status_code != 503
                async with opening:
                    if rows.get(key) is not row: continue
                    if not invalid and (row.lock.locked() or time.monotonic()-row.touched < 90): continue
                    rows.pop(key)
                    await row.close()

    @asynccontextmanager
    async def lifespan(app):
        task = asyncio.create_task(reap())
        try: yield
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError): await task
            for row in list(rows.values()): await row.close()
            if client is None: await http.aclose()

    app = FastAPI(lifespan=lifespan)
    app.add_middleware(BoundedBody)
    app.state.rows = rows
    app.state.get_runtime = get_runtime

    @app.get('/health')
    async def health():
        try:
            async with api.LiveKitAPI() as livekit:
                await asyncio.wait_for(livekit.room.list_rooms(api.ListRoomsRequest()),3)
        except Exception: raise HTTPException(503,'LiveKit server is unavailable') from None
        try:
            response = await http.get(core+'/health',timeout=3)
            if response.status_code != 200: raise HTTPException(503,'TINA Meeting API is unavailable')
        except httpx.HTTPError:
            raise HTTPException(503,'TINA Meeting API is unavailable') from None
        return {'ready':True,'engine':'livekit-agents','version':'1.8.11','capacity':MAX_ROOMS,'sessions':len(rows)}

    @app.get('/ready')
    async def ready():
        status = await health()
        if (len(tts_token) < 32 or tts_token.startswith('encrypted:') or not tts_token.isascii()
                or any(ord(c) < 33 or ord(c) > 126 for c in tts_token)):
            raise HTTPException(503, 'TTS credential is not configured')
        try:
            response = await http.get(tts_url + '/ready', headers={'X-API-Key': tts_token}, timeout=5)
            if response.status_code != 200:
                raise HTTPException(503, 'TTS authentication or readiness failed')
            body = response.json()
            if (body.get('status') != 'ok' or body.get('sample_rate') != SAMPLE_RATE
                    or body.get('channels') != 1 or body.get('format') != 'pcm_s16le'):
                raise HTTPException(503, 'Unexpected TTS audio format')
        except (httpx.HTTPError, ValueError, AttributeError):
            raise HTTPException(503, 'TTS is unavailable') from None
        return status | {'tts_ready': True}

    async def turn_permit(mid, session, rid, token, revision):
        try:
            response = await http.get(f'{core}/bots/voice/{mid}/{session}/turn/{rid}',
                params={'revision': revision}, headers={'Authorization': token}, timeout=5)
            if response.status_code == 200 and response.json().get('current') is True: return
        except (httpx.HTTPError, ValueError, AttributeError):
            raise HTTPException(503, 'Voice turn validation is unavailable') from None
        raise HTTPException(409, 'Voice turn is no longer current')

    async def wait_handle(handle, request):
        task=asyncio.create_task(handle.wait_for_playout())
        try:
            while not task.done():
                await asyncio.sleep(.05)
                if await request.is_disconnected():
                    handle.interrupt(); raise asyncio.CancelledError()
            await task
            if handle.exception() is not None: raise HTTPException(503,'Agent pipeline failed')
        finally:
            if not task.done(): handle.interrupt(); task.cancel()
            with suppress(asyncio.CancelledError): await task

    async def cancel_turn(mid, session, rid, token):
        # Release TINA's room reservation even if planning or the SDK failed before finalization.
        with suppress(httpx.HTTPError):
            await http.post(f'{core}/bots/voice/{mid}/{session}/state', headers={'Authorization':token},
                            json={'state':'QUIET','request_id':rid}, timeout=5)

    @app.post('/bots/{mid}/{session}/answer')
    async def answer(mid:int,session:str,body:Question,request:Request,authorization:str=Header(default=''),
                     x_voice_speaker_key:str|None=Header(default=None,pattern=r'^[0-9a-f]{64}$')):
        row=await get_runtime(mid,session,authorization,body.revision)
        if row.lock.locked(): raise HTTPException(409,'Voice turn is busy')
        async with row.lock:
            rid=str(body.request_id)
            if (mid,session,rid) in stopped: raise HTTPException(409,'Voice turn stopped')
            row.current_id=rid; row.model.result=None; row.model.plan_rounds=0; row.model.tool_requests.clear()
            row.model.request={'body':body.model_dump(mode='json'),'speaker':x_voice_speaker_key}
            row.session.output.audio=None
            context = llm.ChatContext.empty()
            try:
                snapshot = await row.model.agent(row.model.request, 'context')
                if len(snapshot['history']) > 3: raise RuntimeError('Heard context exceeds bound')
                context = heard_context([HeardTurn.model_validate(t) for t in snapshot['history']])
                now = time.monotonic()
                row.contexts = OrderedDict((k,v) for k,v in row.contexts.items() if now-v[0] < 900)
                if x_voice_speaker_key:
                    row.contexts.pop(x_voice_speaker_key, None)
                    row.contexts[x_voice_speaker_key] = (now, context.copy())
                    while len(row.contexts) > 32: row.contexts.popitem(last=False)
                    context = row.contexts[x_voice_speaker_key][1].copy()
                row.model.request['body']['agent_context'] = context_turns(context)
                await row.session.current_agent.update_chat_ctx(context.copy())
                if (mid,session,rid) in stopped: raise HTTPException(409,'Voice turn stopped')
                handle=row.session.generate_reply(user_input=body.question,chat_ctx=context.copy())
                await asyncio.wait_for(wait_handle(handle,request),165)
                if (mid,session,rid) in stopped: raise HTTPException(409,'Voice turn stopped')
                if not row.model.result: raise HTTPException(503,'TINA answer failed')
                return row.model.result | {'voice_runtime':'livekit'}
            except (RuntimeError, ValueError, httpx.HTTPError):
                raise HTTPException(503,'TINA agent operation failed') from None
            finally:
                if row.model.result is None:
                    if (mid,session,rid) not in stopped: row.failed=True
                    await cancel_turn(mid,session,rid,authorization)
                row.model.request=None; row.model.result=None; row.model.tool_requests.clear(); row.touched=time.monotonic()
                with suppress(RuntimeError): await row.session.current_agent.update_chat_ctx(context.copy())

    @app.post('/bots/{mid}/{session}/v1/audio/speech')
    async def speech(mid:int,session:str,body:Speech,request:Request,authorization:str=Header(default=''),
                     x_voice_revision:int=Header(ge=0),x_voice_request_id:UUID=Header()):
        if body.meeting_id!=mid or body.voice!='auto': raise HTTPException(422,'Only the selected room voice is supported')
        row=await get_runtime(mid,session,authorization,x_voice_revision)
        rid=str(x_voice_request_id)
        await turn_permit(mid,session,rid,authorization,x_voice_revision)
        if row.pending_audio >= 2: raise HTTPException(429,'Current speech and lookahead are already reserved')
        row.pending_audio += 1
        async def stream():
            async with row.lock:
                if (mid,session,rid) in stopped: return
                await turn_permit(mid,session,rid,authorization,x_voice_revision)
                if row.failed: raise RuntimeError('Agent speech failed')
                row.current_id=rid
                synthesis = SynthesisStatus()
                row.tts.synthesis = synthesis
                output=HttpAudioOutput(); row.session.output.audio=output
                handle=row.session.say(body.input,add_to_chat_ctx=False)
                waiter=asyncio.create_task(handle.wait_for_playout())
                try:
                    async with asyncio.timeout(150):
                        checked_at = time.monotonic()
                        while not waiter.done() or not output.queue.empty():
                            if (mid,session,rid) in stopped: return
                            if time.monotonic() - checked_at >= 1:
                                await turn_permit(mid,session,rid,authorization,x_voice_revision)
                                checked_at = time.monotonic()
                            if synthesis.failed: raise RuntimeError('Agent speech failed')
                            try: yield await asyncio.wait_for(output.queue.get(),.1)
                            except TimeoutError: pass
                        if handle.exception() is not None or handle.interrupted or not synthesis.complete or not output.samples:
                            raise RuntimeError('Agent speech failed')
                        await turn_permit(mid,session,rid,authorization,x_voice_revision)
                finally:
                    if not waiter.done(): handle.interrupt(); waiter.cancel()
                    with suppress(asyncio.CancelledError): await waiter
                    # Recreate a failed SDK session before the next turn instead of retaining its error budget/state.
                    row.failed = row.failed or synthesis.failed
                    row.session.output.audio=None; row.touched=time.monotonic()
        return PCMResponse(stream(), row)

    @app.delete('/bots/{mid}/{session}/turn')
    async def stop(mid:int,session:str,body:Stop,authorization:str=Header(default='')):
        await config(mid,session,authorization)
        row=rows.get((mid,session));rid=str(body.request_id)
        stopped.append((mid,session,rid))
        await cancel_turn(mid,session,rid,authorization)
        if row:
            if row.current_id==rid: await row.session.interrupt()
        return {'stopped':True}
    return app


if __name__=='__main__':
    import uvicorn
    uvicorn.run(create_app(),host='0.0.0.0',port=8080,access_log=False)
