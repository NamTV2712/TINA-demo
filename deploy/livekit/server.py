"""One-room Agents pilot with capability-authenticated TINA text/PCM custom I/O."""
import asyncio
from collections import deque
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from datetime import timedelta
import logging
import os
import time
from uuid import UUID

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from livekit import api, rtc
from livekit.agents import Agent, AgentSession, llm
from livekit.agents.types import APIConnectOptions
from livekit.agents.voice import SessionConnectOptions

from adapters import TinaLLM, VieNeuTTS, HttpAudioOutput, SAMPLE_RATE

# Framework/provider logs must not include source text, questions, PCM or bearer capabilities.
logging.getLogger('livekit.agents').setLevel(logging.CRITICAL)
logging.getLogger('httpx').setLevel(logging.WARNING)


class Question(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: UUID
    question: str = Field(min_length=1, max_length=2000)
    revision: int = Field(ge=0)


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
    revision: int
    token: str
    room_name: str
    current_id: str | None = None
    cancelled: deque = field(default_factory=lambda: deque(maxlen=32))
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    touched: float = field(default_factory=time.monotonic)

    async def close(self):
        await self.session.aclose()
        await self.room.disconnect()
        await delete_room(self.room_name)


def create_app(client=None, room_connector=connect_room):
    core = os.environ.get('MEETING_API_URL', 'http://meeting-api:8000').rstrip('/')
    tts_url = os.environ.get('TTS_SERVICE_URL', 'http://tts:8000').rstrip('/')
    tts_token = os.environ.get('TTS_API_TOKEN', '')
    http = client or httpx.AsyncClient(timeout=95, follow_redirects=False)
    rows, opening = {}, asyncio.Lock()

    async def config(mid, session, token, revision=None):
        if mid <= 0 or len(session) > 128:
            raise HTTPException(422, 'Invalid meeting session')
        try: UUID(session)
        except ValueError: raise HTTPException(422, 'Invalid meeting session') from None
        if not token.startswith('Bearer ') or len(token) > 256:
            raise HTTPException(401, 'Voice capability required')
        try:
            r = await http.get(f'{core}/bots/voice/{mid}/{session}/config', headers={'Authorization': token}, timeout=5)
        except httpx.HTTPError: raise HTTPException(503, 'TINA is unavailable') from None
        if r.status_code != 200: raise HTTPException(403, 'Voice capability or active session rejected')
        value = r.json()
        if not value.get('enabled') or value.get('engine') != 'livekit' or revision is not None and value.get('revision') != revision:
            raise HTTPException(409, 'Voice runtime policy changed')
        return value

    async def get_runtime(mid, session, token, revision):
        await config(mid, session, token, revision)
        key = (mid, session)
        async with opening:
            row = rows.get(key)
            if row and (row.revision != revision or row.token != token):
                if row.lock.locked(): raise HTTPException(409, 'Previous voice turn is stopping')
                rows.pop(key); await row.close(); row = None
            if row:
                row.touched = time.monotonic()
                return row
            if rows: raise HTTPException(503, 'The one-meeting LiveKit pilot is busy')
            async def answer(request):
                headers = {'Authorization': token}
                if request['speaker']: headers['X-Voice-Speaker-Key'] = request['speaker']
                r = await http.post(f'{core}/bots/voice/{mid}/{session}/answer', json=request['body'], headers=headers)
                if r.status_code != 200 or len(r.content) > 200000: raise RuntimeError('TINA answer rejected')
                return r.json()
            async def speech(text):
                async with http.stream('POST', tts_url+'/v1/audio/speech', headers={'X-API-Key': tts_token},
                    json={'model':'tts-1','input':text,'voice':'auto','response_format':'pcm','meeting_id':mid}, timeout=145) as r:
                    if (r.status_code != 200 or r.headers.get('x-audio-sample-rate','24000') != '24000'
                            or r.headers.get('x-audio-channels','1') != '1'):
                        raise RuntimeError('Local TTS rejected')
                    async for chunk in r.aiter_bytes(): yield chunk
            name = f'tina-meeting-{mid}-{session}'
            room = await room_connector(name)
            model = TinaLLM(answer)
            session_io = AgentSession(llm=model, tts=VieNeuTTS(speech), vad=None, turn_detection='manual',
                user_away_timeout=None, conn_options=SessionConnectOptions(
                    llm_conn_options=APIConnectOptions(max_retry=0,timeout=95),
                    tts_conn_options=APIConnectOptions(max_retry=0,timeout=145)))
            try:
                from livekit.agents.voice import room_io
                await session_io.start(Agent(instructions='Use only the authorized TINA backend.'),room=room,
                    session_host=False,record=False,room_options=room_io.RoomOptions(
                        audio_input=False,video_input=False,text_input=False,audio_output=False,text_output=False,
                        close_on_disconnect=False))
            except BaseException:
                await session_io.aclose(); await room.disconnect(); await delete_room(name)
                raise
            row = Runtime(room,session_io,model,revision,token,name)
            rows[key] = row
            return row

    async def reap():
        while True:
            await asyncio.sleep(2)
            for key, row in list(rows.items()):
                try:
                    await config(*key, row.token, row.revision)
                    if row.lock.locked() or time.monotonic()-row.touched < 90: continue
                except HTTPException as exc:
                    if exc.status_code == 503: continue
                async with opening:
                    if rows.get(key) is row: rows.pop(key)
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
    app.state.rows = rows
    app.state.get_runtime = get_runtime

    @app.middleware('http')
    async def bounded_body(request, call_next):
        if request.method in ('POST','DELETE') and (not request.headers.get('content-length','').isdigit()
                or int(request.headers['content-length']) > 20000):
            from fastapi.responses import JSONResponse
            return JSONResponse({'detail':'Bounded request body required'},status_code=413)
        return await call_next(request)

    @app.get('/health')
    async def health():
        try:
            async with api.LiveKitAPI() as livekit:
                await asyncio.wait_for(livekit.room.list_rooms(api.ListRoomsRequest()),3)
        except Exception: raise HTTPException(503,'LiveKit server is unavailable') from None
        return {'ready':True,'engine':'livekit-agents','version':'1.8.11','capacity':1,'sessions':len(rows)}

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

    @app.post('/bots/{mid}/{session}/answer')
    async def answer(mid:int,session:str,body:Question,request:Request,authorization:str=Header(default=''),
                     x_voice_speaker_key:str|None=Header(default=None,pattern=r'^[0-9a-f]{64}$')):
        row=await get_runtime(mid,session,authorization,body.revision)
        if row.lock.locked(): raise HTTPException(409,'Voice turn is busy')
        async with row.lock:
            rid=str(body.request_id)
            if rid in row.cancelled: raise HTTPException(409,'Voice turn stopped')
            row.current_id=rid; row.model.result=None
            row.model.request={'body':body.model_dump(mode='json'),'speaker':x_voice_speaker_key}
            row.session.output.audio=None
            handle=row.session.generate_reply(user_input=body.question,chat_ctx=llm.ChatContext.empty())
            try:
                await asyncio.wait_for(wait_handle(handle,request),98)
                if rid in row.cancelled or not row.model.result: raise HTTPException(409,'Voice turn stopped')
                return row.model.result | {'voice_runtime':'livekit'}
            finally:
                row.model.request=None; row.model.result=None; row.touched=time.monotonic()

    @app.post('/bots/{mid}/{session}/v1/audio/speech')
    async def speech(mid:int,session:str,body:Speech,request:Request,authorization:str=Header(default=''),
                     x_voice_revision:int=Header(ge=0),x_voice_request_id:UUID=Header()):
        if body.meeting_id!=mid or body.voice!='auto': raise HTTPException(422,'Only the selected room voice is supported')
        row=await get_runtime(mid,session,authorization,x_voice_revision)
        rid=str(x_voice_request_id)
        async def stream():
            async with row.lock:
                if rid in row.cancelled: return
                row.current_id=rid
                output=HttpAudioOutput(); row.session.output.audio=output
                handle=row.session.say(body.input,add_to_chat_ctx=False)
                waiter=asyncio.create_task(handle.wait_for_playout())
                try:
                    async with asyncio.timeout(150):
                        while not waiter.done() or not output.queue.empty():
                            if rid in row.cancelled: return
                            try: yield await asyncio.wait_for(output.queue.get(),.1)
                            except TimeoutError: pass
                        if handle.exception() is not None or not output.samples:
                            raise RuntimeError('Agent speech failed')
                finally:
                    if not waiter.done(): handle.interrupt(); waiter.cancel()
                    with suppress(asyncio.CancelledError): await waiter
                    row.session.output.audio=None; row.touched=time.monotonic()
        return StreamingResponse(stream(),media_type='audio/pcm',headers={
            'X-Audio-Sample-Rate':str(SAMPLE_RATE),'X-Audio-Channels':'1','Cache-Control':'no-store'})

    @app.delete('/bots/{mid}/{session}/turn')
    async def stop(mid:int,session:str,body:Stop,authorization:str=Header(default='')):
        await config(mid,session,authorization)
        row=rows.get((mid,session));rid=str(body.request_id)
        if row:
            row.cancelled.append(rid)
            if row.current_id==rid: await row.session.interrupt()
        return {'stopped':True}
    return app


if __name__=='__main__':
    import uvicorn
    uvicorn.run(create_app(),host='0.0.0.0',port=8080,access_log=False)
