"""Actual self-hosted room + AgentSession + local TTS; only the meeting API is a synthetic fixture."""
import asyncio
import hashlib
import json
import os
import time
from uuid import uuid4

import httpx
from livekit import api

from server import create_app


async def main():
    session=str(uuid4());calls=[]
    real=httpx.AsyncHTTPTransport()
    class FixtureTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self,request):
            if request.url.host=='meeting-api':
                calls.append(request.url.path)
                if request.url.path.endswith('/config'):
                    return httpx.Response(200,json={'enabled':True,'engine':'livekit','revision':1})
                return httpx.Response(200,json={'text':'Dạ, em nghe.','reason':'answered','sources':[]})
            return await real.handle_async_request(request)
        async def aclose(self):await real.aclose()
    async with httpx.AsyncClient(transport=FixtureTransport(),timeout=45) as http:
        app=create_app(client=http)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as client:
                headers={'Authorization':'Bearer synthetic-scoped-capability'}
                body={'question':'Synthetic source-free acknowledgment','request_id':str(uuid4()),'revision':1}
                base=f'/bots/1/{session}'
                started=time.monotonic()
                response=await client.post(base+'/answer',headers=headers,json=body)
                assert response.status_code==200,response.text
                assert response.json()['voice_runtime']=='livekit'
                room_name=app.state.rows[(1,session)].room_name
                async with api.LiveKitAPI() as livekit:
                    rooms=await livekit.room.list_rooms(api.ListRoomsRequest())
                    assert any(room.name==room_name for room in rooms.rooms)
                audio=await client.post(base+'/v1/audio/speech',headers=headers|{
                    'X-Voice-Revision':'1','X-Voice-Request-Id':body['request_id']},
                    json={'input':response.json()['text'],'meeting_id':1,'voice':'auto','response_format':'pcm'})
                assert audio.status_code==200 and len(audio.content)>4800 and len(audio.content)%2==0
                stop=await client.request('DELETE',base+'/turn',headers=headers,json={'request_id':body['request_id']})
                assert stop.status_code==200
                assert (await client.post(base+'/answer',headers=headers,json=body)).status_code==409
                report={'real_self_hosted_room':True,'actual_agent_session_llm':True,'local_vieneu_tts':True,
                    'sample_rate':24000,'pcm_bytes':len(audio.content),'pcm_sha256':hashlib.sha256(audio.content).hexdigest(),
                    'stop_replay_fenced':True,'meeting_api_is_synthetic':True,'live_google_meet':False,
                    'duration_ms':round((time.monotonic()-started)*1000)}
        async with api.LiveKitAPI() as livekit:
            rooms=await livekit.room.list_rooms(api.ListRoomsRequest())
            assert not any(room.name==room_name for room in rooms.rooms)
        report['room_removed_after_close']=True
        print(json.dumps(report),flush=True)


if __name__=='__main__':asyncio.run(main())
