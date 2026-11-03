"""Optional authenticated text -> mono PCM16/24 kHz sidecar. No core imports."""
from __future__ import annotations

import hmac
import json
import logging
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from engine import Engine, MODEL, SAMPLE_RATE

MAX_BODY = 20000
MAX_TEXT = 4000
log = logging.getLogger("tina.tts")


class SpeechServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, engine, token):
        if len(token) < 32 or not token.isascii() or any(ord(c) < 33 or ord(c) > 126 for c in token):
            raise ValueError("TTS_API_TOKEN must contain at least 32 printable ASCII characters")
        self.engine = engine
        self.token = token.encode("ascii")
        self.busy = threading.Lock()
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *_args):
        pass  # BaseHTTPRequestHandler logs paths/arguments; never log submitted text/credentials.

    def send_bytes(self, status, body, content_type="application/json", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass  # Stop can disconnect while native synthesis is still returning.

    def error(self, status, message):
        self.send_bytes(status, json.dumps({"detail": message}).encode())

    def do_GET(self):
        if self.path not in ("/health", "/status"):
            return self.error(404, "Not found")
        self.send_bytes(200, json.dumps({"status": "ok", "model": MODEL,
            "device": "cpu", "sample_rate": SAMPLE_RATE, "channels": 1,
            "format": "pcm_s16le", "busy": self.server.busy.locked()}).encode())

    def do_POST(self):
        if self.path != "/v1/audio/speech":
            return self.error(404, "Not found")
        supplied = self.headers.get("X-API-Key", "").encode("utf-8")
        if not hmac.compare_digest(supplied, self.server.token):
            return self.error(401, "Unauthorized")
        if self.headers.get("Transfer-Encoding"):
            return self.error(400, "Transfer encoding is not supported")
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            return self.error(400, "Invalid content length")
        if length < 0:
            return self.error(411, "Content length required")
        if length > MAX_BODY:
            return self.error(413, "Speech request is too large")
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            return self.error(415, "JSON required")
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                return self.error(400, "Incomplete request")
            body = json.loads(raw)
        except (ValueError, UnicodeError, TimeoutError):
            return self.error(400, "Invalid JSON")
        if not isinstance(body, dict) or set(body) - {"input", "model", "voice", "response_format"}:
            return self.error(422, "Unsupported speech fields")
        text = body.get("input")
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
            return self.error(422, "Input must contain 1-4000 characters")
        if (body.get("model", "tts-1") not in ("tts-1", MODEL)
                or body.get("voice", "auto") != "auto"
                or body.get("response_format", "pcm") != "pcm"):
            return self.error(422, "Use model=tts-1, voice=auto and response_format=pcm")
        if not self.server.busy.acquire(blocking=False):
            return self.error(503, "Speech service is busy; retry after the active request")
        started = time.monotonic()
        try:
            audio = self.server.engine.synthesize(text.strip())
            if not isinstance(audio, bytes) or not audio or len(audio) % 2:
                raise ValueError("Invalid PCM")
            self.send_bytes(200, audio, "application/octet-stream", {
                "X-Audio-Sample-Rate": str(SAMPLE_RATE), "X-Audio-Channels": "1",
                "Server-Timing": f"tts;dur={(time.monotonic() - started) * 1000:.1f}",
            })
            log.info("synthesis complete: characters=%d bytes=%d seconds=%.3f",
                     len(text), len(audio), time.monotonic() - started)
        except Exception:
            # Never expose model exception messages: they may contain input text.
            log.error("synthesis failed")
            self.error(503, "Speech synthesis failed")
        finally:
            # Native inference is not preemptible; keep this lock until it actually finishes.
            self.server.busy.release()


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    token = os.environ.get("TTS_API_TOKEN", "")
    if len(token) < 32:
        raise SystemExit("Set a private TTS_API_TOKEN of at least 32 characters")
    directory = Path(os.environ.get("HF_HOME", "/models"))
    engine = Engine(directory)
    host = os.environ.get("TINA_TTS_HOST", "127.0.0.1")
    port = int(os.environ.get("TINA_TTS_PORT", "8000"))
    server = SpeechServer((host, port), engine, token)
    log.info("TTS ready: CPU, mono PCM16, 24000 Hz")
    server.serve_forever()


if __name__ == "__main__":
    main()
