"""Offline HTTP/audio regression tests; native models are exercised by smoke.py."""
import io
import json
import threading
import hashlib
import tempfile
import sys
import socket
import time
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stderr
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

from server import SpeechServer

TOKEN = "test-only-" + "x" * 40


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        def synthesize(text):
            self.calls.append(text)
            return b"\x01\x00" * 2400
        self.engine = SimpleNamespace(synthesize=synthesize)
        self.server = SpeechServer(("127.0.0.1", 0), self.engine, TOKEN)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:" + str(self.server.server_port)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def call(self, body=None, *, token=TOKEN, raw=None, path="/v1/audio/speech"):
        data = raw if raw is not None else json.dumps(body or {"input": "Xin chào"}).encode()
        request = urllib.request.Request(self.url + path, data=data,
            headers={"X-API-Key": token, "Content-Type": "application/json"})
        try:
            response = self.opener.open(request, timeout=3)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            return response.status, dict(response.headers), response.read()

    def test_health_and_status_do_not_synthesize(self):
        for path in ("/health", "/status"):
            with self.opener.open(self.url + path) as r:
                self.assertEqual(json.load(r)["sample_rate"], 24000)
        self.assertEqual(self.calls, [])

    def test_bot_request_returns_raw_pcm_and_no_text_logs(self):
        output = io.StringIO()
        with redirect_stderr(output):
            code, headers, audio = self.call({"input": "private marker", "model": "tts-1",
                                            "voice": "auto", "response_format": "pcm"})
        self.assertEqual(code, 200)
        self.assertEqual(headers["X-Audio-Sample-Rate"], "24000")
        self.assertEqual(headers["Content-Type"], "application/octet-stream")
        self.assertEqual(audio, b"\x01\x00" * 2400)
        self.assertNotIn("private marker", output.getvalue())
        self.assertNotIn(TOKEN, output.getvalue())

    def test_auth_precedes_json_and_inference(self):
        self.assertEqual(self.call(token="bad", raw=b"not JSON")[0], 401)
        self.assertEqual(self.calls, [])

    def test_rejects_invalid_text_format_voice_and_oversize(self):
        for body in ({"input": " "}, {"input": 123}, {"input": "x" * 4001},
                     {"input": "x", "response_format": "wav"},
                     {"input": "x", "voice": "unknown"}, {"input": "x", "model": "unknown"},
                     {"input": "x", "ref_audio": "untrusted.wav"}):
            self.assertEqual(self.call(body)[0], 422)
        self.assertEqual(self.call(raw=b"x" * 20001)[0], 413)
        self.assertEqual(self.call(raw=b"bad JSON")[0], 400)
        self.assertEqual(self.calls, [])

    def test_concurrent_request_is_bounded_without_second_inference(self):
        entered, release = threading.Event(), threading.Event()
        def blocked(text):
            entered.set()
            release.wait(3)
            return b"\x01\x00" * 10
        self.engine.synthesize = blocked
        result = []
        request = threading.Thread(target=lambda: result.append(self.call()[0]))
        request.start()
        try:
            self.assertTrue(entered.wait(2))
            self.assertEqual(self.call()[0], 503)
        finally:
            release.set()
            request.join(3)
        self.assertEqual(result, [200])

    def test_native_error_is_sanitized_and_lock_recovers(self):
        def broken(text):
            raise RuntimeError("secret exception containing " + text)
        original = self.engine.synthesize
        self.engine.synthesize = broken
        code, _, body = self.call({"input": "private marker"})
        self.assertEqual(code, 503)
        self.assertNotIn(b"private marker", body)
        self.assertFalse(self.server.busy.locked())
        self.engine.synthesize = original
        self.assertEqual(self.call()[0], 200)

    def test_short_startup_token_is_refused(self):
        with self.assertRaises(ValueError):
            SpeechServer(("127.0.0.1", 0), self.engine, "short")


class ConnectionLimitTests(unittest.TestCase):
    def test_slow_headers_have_total_deadline_and_excess_connections_are_refused(self):
        engine = SimpleNamespace(synthesize=lambda _: b"\x01\x00")
        server = SpeechServer(("127.0.0.1", 0), engine, TOKEN,
                              max_connections=1, request_timeout=.4)
        entered, finished = threading.Event(), threading.Event()
        original = server.process_request_thread
        def tracked(*args):
            entered.set()
            try:
                original(*args)
            finally:
                finished.set()
        server.process_request_thread = tracked
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        address = server.server_address
        try:
            with socket.create_connection(address, timeout=2) as slow:
                slow.sendall(b"GET /health HTTP/1.1\r\nX-Slow: ")
                self.assertTrue(entered.wait(1))
                with socket.create_connection(address, timeout=2) as excess:
                    try:
                        self.assertEqual(excess.recv(1), b"")
                    except ConnectionResetError:
                        pass
                started = time.monotonic()
                # Keep activity well inside the ordinary 10-second socket timeout.
                while not finished.wait(.03):
                    try:
                        slow.sendall(b"x")
                    except OSError:
                        break
                    self.assertLess(time.monotonic() - started, 2)
                self.assertTrue(finished.wait(1))
                self.assertLess(time.monotonic() - started, 2)
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(f"http://127.0.0.1:{address[1]}/health", timeout=2) as response:
                self.assertEqual(response.status, 200)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)


class AudioTests(unittest.TestCase):
    def test_synthesis_uses_female_voice_and_spoken_name(self):
        import numpy as np
        from engine import Engine, spoken_text
        from unittest.mock import Mock

        engine = Engine.__new__(Engine)
        engine.tts = SimpleNamespace(sample_rate=24000, infer=Mock(return_value=np.ones(240)))
        original = "Xin chào, tôi là TINA. Tina giúp bạn dùng API."
        self.assertTrue(engine.synthesize(original))
        engine.tts.infer.assert_called_once_with(
            "Xin chào, tôi là ti na. ti na giúp bạn dùng API.",
            voice="Trúc Ly", apply_watermark=False)
        self.assertIn("TINA", original)
        unchanged = "retina Latina TINA_API Tina123 đTINA API"
        self.assertEqual(spoken_text(unchanged), unchanged)
        self.assertEqual(spoken_text("(TINA), tina!"), "(ti na), ti na!")

    def test_real_resampler_outputs_24k_little_endian_mono(self):
        import numpy as np
        from engine import pcm24
        wave = np.sin(2 * np.pi * 440 * np.arange(48000) / 48000) * .2
        pcm = pcm24(wave, 48000)
        self.assertEqual(len(pcm), 24000 * 2)
        self.assertGreater(np.abs(np.frombuffer(pcm, dtype="<i2")).max(), 100)
        self.assertFalse(pcm.startswith(b"RIFF"))
        for bad in (np.array([]), np.array([float("nan")]), np.zeros((2, 10))):
            with self.assertRaises(ValueError):
                pcm24(bad, 48000)


class AssetTests(unittest.TestCase):
    def test_offline_validation_requests_only_pinned_subset(self):
        import engine
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "snapshot"
            snapshot.mkdir()
            content = b"test model bytes"
            (snapshot / "model.onnx").write_bytes(content)
            files = [{"path": "model.onnx", "sha256": hashlib.sha256(content).hexdigest()}]
            (root / "model-assets.json").write_text(json.dumps({"repos": [
                {"repo": "test/voice", "revision": "pinned", "files": files}]}))
            ref = root / "hub/models--test--voice/refs/main"
            ref.parent.mkdir(parents=True)
            ref.write_text("pinned")
            calls = []
            def downloaded(*args, **kwargs):
                calls.append(kwargs)
                return snapshot
            with patch.object(engine, "__file__", str(root / "engine.py")), patch.dict(
                sys.modules, {"huggingface_hub": SimpleNamespace(snapshot_download=downloaded)}
            ):
                engine.verify_assets(root)
                self.assertEqual(calls[0]["allow_patterns"], ["model.onnx"])
                self.assertTrue(calls[0]["local_files_only"])
                (snapshot / "model.onnx").write_bytes(b"tampered")
                with self.assertRaises(RuntimeError):
                    engine.verify_assets(root)


if __name__ == "__main__":
    unittest.main()
