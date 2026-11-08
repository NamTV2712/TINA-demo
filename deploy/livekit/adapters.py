"""LiveKit model/PCM adapters. TINA remains the authority for sources and heard-text history."""
import asyncio
from uuid import uuid4

from livekit import rtc
from livekit.agents import llm, tts
from livekit.agents.voice import io
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS

SAMPLE_RATE = 24000
MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * 120


class TinaLLM(llm.LLM):
    def __init__(self, answer):
        super().__init__()
        self.answer = answer
        self.request = None
        self.result = None

    @property
    def model(self): return 'tina-selected-backend'

    @property
    def provider(self): return 'tina-knowledge'

    def chat(self, *, chat_ctx, tools=None, conn_options=DEFAULT_API_CONNECT_OPTIONS, **kwargs):
        if self.request is None: raise RuntimeError('No authorized TINA turn')
        return TinaStream(self, self.request, chat_ctx, conn_options)


class TinaStream(llm.LLMStream):
    def __init__(self, model, request, chat_ctx, conn_options):
        self.model, self.request = model, request
        super().__init__(model, chat_ctx=chat_ctx, tools=[], conn_options=conn_options)

    async def _run(self):
        result = await self.model.answer(self.request)
        if not isinstance(result.get('text'), str) or not 1 <= len(result['text']) <= 4000:
            raise RuntimeError('Invalid TINA answer')
        self.model.result = result
        self._event_ch.send_nowait(llm.ChatChunk(id=str(uuid4()), delta=llm.ChoiceDelta(role='assistant', content=result['text'])))


class VieNeuTTS(tts.TTS):
    def __init__(self, synthesize):
        super().__init__(capabilities=tts.TTSCapabilities(streaming=False), sample_rate=SAMPLE_RATE, num_channels=1)
        self.speech = synthesize

    @property
    def model(self): return 'vieneu-v3-turbo'

    @property
    def provider(self): return 'tina-local-tts'

    def synthesize(self, text, *, conn_options=DEFAULT_API_CONNECT_OPTIONS):
        return VieNeuStream(self, input_text=text, conn_options=conn_options)


class VieNeuStream(tts.ChunkedStream):
    def __init__(self, model, **kwargs):
        self.model = model
        super().__init__(tts=model, **kwargs)

    async def _run(self, output_emitter):
        output_emitter.initialize(request_id=str(uuid4()), sample_rate=SAMPLE_RATE, num_channels=1,
                                  mime_type='audio/pcm', frame_size_ms=20)
        size = 0
        async for chunk in self.model.speech(self._input_text):
            size += len(chunk)
            if size > MAX_AUDIO_BYTES: raise RuntimeError('Audio exceeds bound')
            output_emitter.push(chunk)
        if not size or size % 2: raise RuntimeError('Invalid PCM stream')
        output_emitter.end_input()


class HttpAudioOutput(io.AudioOutput):
    """Bounded PCM delivery. Actual microphone playback receipts still come from the bot."""
    def __init__(self):
        super().__init__(label='tina-http-pcm', sample_rate=SAMPLE_RATE,
                         capabilities=io.AudioOutputCapabilities(pause=False))
        self.queue = asyncio.Queue(maxsize=8)
        self.samples = 0
        self.segment_samples = 0

    async def capture_frame(self, frame: rtc.AudioFrame):
        if frame.sample_rate != SAMPLE_RATE or frame.num_channels != 1:
            raise RuntimeError('Unexpected PCM format')
        await super().capture_frame(frame)
        self.samples += frame.samples_per_channel
        self.segment_samples += frame.samples_per_channel
        if self.samples * 2 > MAX_AUDIO_BYTES: raise RuntimeError('Audio exceeds bound')
        await self.queue.put(bytes(frame.data))

    def flush(self):
        super().flush()
        if self.segment_samples:
            self.on_playback_finished(playback_position=self.segment_samples / SAMPLE_RATE, interrupted=False)
            self.segment_samples = 0

    def clear_buffer(self):
        while not self.queue.empty(): self.queue.get_nowait()
        super().flush()
        if self.segment_samples:
            self.on_playback_finished(playback_position=self.segment_samples / SAMPLE_RATE, interrupted=True)
            self.segment_samples = 0
