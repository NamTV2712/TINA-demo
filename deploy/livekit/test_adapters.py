import asyncio
import pytest
from livekit import rtc
from livekit.agents import Agent, AgentSession, llm
from livekit.agents.types import APIConnectOptions
from adapters import TinaLLM, VieNeuTTS, HttpAudioOutput


async def test_actual_agents_llm_session_calls_tina_once_and_preserves_metadata():
    calls=[]
    async def answer(request):
        calls.append(request)
        return {'text':'Lan phụ trách demo.','sources':[{'id':'s0'}],'reason':'answered'}
    model=TinaLLM(answer)
    model.request={'question':'Ai làm demo?','request_id':'synthetic'}
    session=AgentSession(llm=model,vad=None,turn_detection='manual',user_away_timeout=None)
    try:
        await session.start(Agent(instructions='Use the authorized TINA backend.'))
        handle=session.generate_reply(user_input='Ai làm demo?',chat_ctx=llm.ChatContext.empty())
        await asyncio.wait_for(handle.wait_for_playout(),5)
        assert handle.exception() is None
        assert len(calls)==1 and model.result['sources']==[{'id':'s0'}]
    finally: await session.aclose()


async def test_actual_agents_tts_emits_bounded_pcm_without_a_cloud_model():
    calls=[]
    async def speech(text):
        calls.append(text)
        yield b'\0\0' * 2400
    model=VieNeuTTS(speech)
    output=HttpAudioOutput()
    session=AgentSession(tts=model,vad=None,turn_detection='manual',user_away_timeout=None)
    session.output.audio=output
    try:
        await session.start(Agent(instructions='Use local TTS.'))
        handle=session.say('Dạ, em nghe.',add_to_chat_ctx=False)
        async def drain():
            data=bytearray()
            while not handle.done() or not output.queue.empty():
                try:data.extend(await asyncio.wait_for(output.queue.get(),.1))
                except TimeoutError:pass
            return data
        data=await asyncio.wait_for(drain(),5)
        assert handle.exception() is None and len(data)==4800 and len(calls)==1
    finally: await session.aclose()
