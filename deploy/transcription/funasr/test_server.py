"""Model-free regression checks; never load weights or call the running ASR service."""
import asyncio
import io
import json
import socket
import threading
import time
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import httpx
import uvicorn
from fastapi import HTTPException, Request

import server
import numpy as np
import soundfile as sf
from telemetry import AsrMetrics


class FakeASR:
    def __init__(self):
        self.calls = []
        self.started = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.active = 0
        self.max_active = 0

    def generate(self, **options):
        self.calls.append(options)
        self.active += 1
        self.max_active = max(self.active, self.max_active)
        self.started.set()
        try:
            if not self.release.wait(timeout=2):
                raise RuntimeError("Test inference was not released")
            return [{"text": "hello xin chào", "language": "Vietnamese", "sentence_info": [
                {"start": 100, "end": 400, "text": "hello"},
                {"start": 600, "end": 900, "text": "xin chào"},
            ]}]
        finally:
            self.active -= 1


def connected_request():
    request = Mock(spec=Request)
    request.is_disconnected = AsyncMock(return_value=False)
    request.state = SimpleNamespace(asr_timing={})
    return request


class ServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.model = FakeASR()
        server.app.state.asr = self.model
        server.app.state.inference_lock = asyncio.Semaphore(1)
        server.app.state.inference_requests = 0
        server.app.state.metrics = AsrMetrics()
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=server.app), base_url="http://test",
        )
        recording = io.BytesIO()
        with wave.open(recording, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(b"\0\0" * 16000)
        self.audio = recording.getvalue()

    async def asyncTearDown(self):
        self.model.release.set()
        await self.client.aclose()

    async def transcribe(self, **fields):
        return await self.client.post(
            "/v1/audio/transcriptions",
            files={"file": ("test.wav", self.audio, "audio/wav")},
            data={"model": "custom", "response_format": "verbose_json", **fields},
        )

    async def test_vad_segments_and_context_reach_the_wire(self):
        prompt = "older context " + "x" * 800
        response = await self.transcribe(language="vi", prompt=prompt)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["segments"], [
            {"start": 0.1, "end": 0.4, "text": "hello"},
            {"start": 0.6, "end": 0.9, "text": "xin chào"},
        ])
        options = self.model.calls[0]
        self.assertTrue(options["sentence_timestamp"])
        self.assertEqual(options["context"], prompt[-800:])
        self.assertEqual(options["language"], "Vietnamese")
        self.assertEqual(server.app.state.inference_requests, 0)

    async def test_short_recovery_tail_pads_inference_only(self):
        original = np.linspace(-0.1, 0.1, 243, dtype=np.float32)
        recording = io.BytesIO()
        sf.write(recording, original, 16000, format="WAV", subtype="FLOAT")
        self.audio = recording.getvalue()
        input_path = None

        def generate(**options):
            nonlocal input_path
            input_path = options["input"]
            pcm, rate = sf.read(input_path, dtype="float32")
            self.assertEqual(rate, 16000)
            self.assertEqual(len(pcm), 3200)
            np.testing.assert_array_equal(pcm[:len(original)], original)
            self.assertFalse(pcm[len(original):].any())
            return [{"text": "yes", "sentence_info": [{"start": 0, "end": 200, "text": "yes"}]}]

        with patch.object(self.model, "generate", side_effect=generate):
            response = await self.transcribe()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["duration"], len(original) / 16000)
        self.assertEqual(response.json()["segments"], [{"start": 0, "end": len(original) / 16000, "text": "yes"}])
        self.assertEqual(server.app.state.metrics.recent[-1]["audio_ms"], round(len(original) / 16, 3))
        self.assertFalse(Path(input_path).exists(), "padded input is temporary")

    async def test_empty_tail_is_rejected_and_padding_does_not_hide_model_errors(self):
        recording = io.BytesIO()
        sf.write(recording, np.zeros(0, dtype=np.float32), 16000, format="WAV", subtype="FLOAT")
        self.audio = recording.getvalue()
        self.assertEqual((await self.transcribe()).status_code, 400)
        self.assertEqual(self.model.calls, [])
        recording = io.BytesIO()
        sf.write(recording, np.zeros(243, dtype=np.float32), 16000, format="WAV", subtype="FLOAT")
        self.audio = recording.getvalue()
        with patch.object(self.model, "generate", side_effect=RuntimeError("model failed")):
            self.assertEqual((await self.transcribe()).status_code, 502)

    async def test_silence_threshold_is_validated_and_forwarded(self):
        self.assertEqual((await self.transcribe()).status_code, 200)
        self.assertEqual(self.model.calls[-1]["max_end_silence_time"], 800)
        self.assertEqual((await self.transcribe(min_silence_duration_ms="450")).status_code, 200)
        self.assertEqual(self.model.calls[-1]["max_end_silence_time"], 450)
        for invalid in ("0", "99", "2001", "nan"):
            self.assertEqual((await self.transcribe(min_silence_duration_ms=invalid)).status_code, 422)
        self.assertEqual(len(self.model.calls), 2)

    async def test_full_queue_rejects_before_running_model(self):
        server.app.state.inference_requests = server.MAX_INFERENCE_REQUESTS
        response = await self.transcribe()
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers["retry-after"], "1")
        self.assertEqual(self.model.calls, [])

    async def test_status_correlates_request_timings_without_content(self):
        request_id = "11111111-1111-4111-8111-111111111111"
        response = await self.client.post(
            "/v1/audio/transcriptions", files={"file": ("test.wav", self.audio, "audio/wav")},
            data={"model": "custom", "prompt": "PRIVATE-CONTEXT"},
            headers={"X-ASR-Request-ID": request_id, "X-ASR-Source": "dictation", "X-ASR-Capture-Ms": "12.5"},
        )
        self.assertEqual(response.headers["x-asr-request-id"], request_id)
        self.assertIn("asr_inference;dur=", response.headers["server-timing"])
        status = (await self.client.get("/status")).json()
        sample = status["recent"][0]
        self.assertEqual(sample["request_id"], request_id)
        self.assertEqual(sample["source"], "dictation")
        self.assertEqual(sample["capture_ms"], 12.5)
        self.assertEqual(sample["audio_ms"], 1000)
        self.assertGreaterEqual(sample["total_ms"], sample["inference_ms"])
        self.assertNotIn("PRIVATE-CONTEXT", json.dumps(status))
        self.assertNotIn("hello", json.dumps(status))
        self.assertEqual(status["requests"], {"total": 1, "errors": 0})

    async def test_bad_requests_are_counted_with_unmeasured_stages(self):
        response = await self.client.post(
            "/v1/audio/transcriptions", files={"file": ("test.wav", self.audio)},
            data={"model": "invalid"}, headers={"X-ASR-Source": "PRIVATE-NAME", "X-ASR-Capture-Ms": "NaN"},
        )
        self.assertEqual(response.status_code, 400)
        status = (await self.client.get("/status")).json()
        self.assertEqual(status["requests"]["errors"], 1)
        self.assertEqual(status["recent"][0]["source"], "unknown")
        self.assertIsNone(status["recent"][0]["capture_ms"])
        self.assertIsNone(status["recent"][0]["inference_ms"])
        self.assertEqual(status["latency"]["inference_ms"]["count"], 0)
        self.assertNotIn("PRIVATE-NAME", json.dumps(status))

    async def test_device_reports_resolved_model_device(self):
        self.model.kwargs = {"device": "cpu"}
        status = (await self.client.get("/status")).json()
        self.assertEqual(status["model"]["device"], "cpu")
        self.assertEqual((await self.client.get("/health")).json()["device"], "cpu")

    async def test_metrics_are_bounded_with_nearest_rank_percentiles(self):
        metrics = AsrMetrics()
        for index in range(120):
            metrics.record({"request_id": "11111111-1111-4111-8111-111111111111", "at_ms": index,
                            "source": "extension", "http_status": 400 if index % 10 == 0 else 200,
                            "queue_ms": index})
        result = metrics.snapshot()
        self.assertEqual(len(result["recent"]), 100)
        self.assertEqual(result["requests"], {"total": 120, "errors": 12})
        self.assertEqual(result["latency"]["queue_ms"], {"count": 100, "p50_ms": 69, "p95_ms": 114})
        self.assertIsNone(result["latency"]["inference_ms"]["p95_ms"])

    async def test_queue_wait_has_a_deadline(self):
        lock = server.app.state.inference_lock
        await lock.acquire()
        try:
            with patch.object(server, "QUEUE_TIMEOUT_SECONDS", 0.02):
                response = await self.transcribe()
            self.assertEqual(response.status_code, 503)
            self.assertEqual(self.model.calls, [])
            self.assertEqual(server.app.state.inference_requests, 0)
        finally:
            lock.release()

    async def test_disconnected_waiter_does_not_run_inference(self):
        lock = server.app.state.inference_lock
        await lock.acquire()
        request = connected_request()
        task = asyncio.create_task(server._generate(request, {}))
        try:
            await asyncio.sleep(0.01)
            request.is_disconnected.return_value = True
            with self.assertRaises(HTTPException) as raised:
                await asyncio.wait_for(task, timeout=0.5)
            self.assertEqual(raised.exception.status_code, 499)
            self.assertEqual(self.model.calls, [])
            self.assertEqual(server.app.state.inference_requests, 0)
        finally:
            lock.release()

    async def test_cancelled_active_request_keeps_model_serialized(self):
        self.model.release.clear()
        first = asyncio.create_task(server._generate(connected_request(), {}))
        self.assertTrue(await asyncio.to_thread(self.model.started.wait, 1))
        first.cancel()
        second = asyncio.create_task(server._generate(connected_request(), {}))
        try:
            await asyncio.sleep(0.02)
            self.assertEqual(len(self.model.calls), 1)
            self.model.release.set()
            with self.assertRaises(asyncio.CancelledError):
                await first
            await second
            self.assertEqual(len(self.model.calls), 2)
            self.assertEqual(self.model.max_active, 1)
            self.assertEqual(server.app.state.inference_requests, 0)
        finally:
            self.model.release.set()
            await asyncio.gather(first, second, return_exceptions=True)

    async def test_http_disconnects_drop_queued_work_with_telemetry_enabled(self):
        class SlowASR(FakeASR):
            def generate(self, **options):
                time.sleep(.2)
                return super().generate(**options)

        model = SlowASR()
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        worker = uvicorn.Server(uvicorn.Config(server.app, log_level="error", access_log=False))
        thread = threading.Thread(target=lambda: worker.run(sockets=[sock]), daemon=True)
        with patch.object(server, "_load_model", return_value=model):
            thread.start()
            try:
                for _ in range(100):
                    if worker.started: break
                    await asyncio.sleep(.01)
                self.assertTrue(worker.started)
                async with httpx.AsyncClient(timeout=.055) as client:
                    async def send():
                        try:
                            await client.post(f"http://127.0.0.1:{port}/v1/audio/transcriptions",
                                              files={"file": ("test.wav", self.audio)}, data={"model": "custom"})
                            return "answered"
                        except httpx.TimeoutException:
                            return "timeout"
                    self.assertEqual(await asyncio.gather(*(send() for _ in range(3))), ["timeout"] * 3)
                await asyncio.sleep(.7)
                self.assertEqual(len(model.calls), 1)
                self.assertEqual(server.app.state.inference_requests, 0)
            finally:
                worker.should_exit = True
                await asyncio.to_thread(thread.join, 3)
                sock.close()


if __name__ == "__main__":
    unittest.main()
