"""Real pinned-CLI regression: API model IDs must not turn into malformed URL paths.

Run directly in the worker image with network disabled; all requests use an in-process
loopback stub and a dummy credential. pytest also discovers it, skipping where agy is absent.
"""
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.parse import urlsplit

from llm.antigravity import AntigravityHarness


@unittest.skipUnless(shutil.which("agy"), "requires the pinned worker CLI")
class GeminiCliWireTest(unittest.TestCase):
    def test_native_function_result_preserves_signature_and_reads_a_file(self):
        requests = []
        called = []
        nonce = "gemini-read-tool-round-trip"
        signature = "b3BhcXVlLXRlc3QtdGhvdWdodC1zaWduYXR1cmU="

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(payload)
                functions = [function for tool in payload.get("tools", [])
                             for function in tool.get("functionDeclarations", [])]
                if not called and any(function.get("name") == "read_file" for function in functions):
                    called.append(True)
                    parts = [{"functionCall": {"name": "read_file", "args": {"Path": str(work / "note.txt")}},
                              "thoughtSignature": signature}]
                else:
                    parts = [{"text": nonce}]
                body = ("data: " + json.dumps({"candidates": [{"content": {"role": "model", "parts": parts},
                                                              "finishReason": "STOP"}]}) + "\n\n").encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                work = Path(directory)
                (work / "note.txt").write_text(nonce)
                with patch.dict(os.environ, {
                    "GEMINI_API_KEY": "dummy-offline-key", "TINA_ANTIGRAVITY_AUTH_MODE": "gemini-api",
                    "GOOGLE_GEMINI_BASE_URL": f"http://127.0.0.1:{server.server_port}",
                    "TINA_AGENT_MODEL": "gemini-3.1-pro-preview", "TINA_AGENT_EFFORT": "xhigh",
                    "TINA_MOUNTS": json.dumps([{"path": str(work), "write": False, "role": "active"}]),
                }):
                    harness = AntigravityHarness()
                    harness.prepare(work)
                    events = list(harness.run_turn(work, "Read note.txt and reply with its contents.",
                                                  model="gemini-3.1-pro-preview", allowed_tools=["Read"]))
                    done = next(event for event in reversed(events) if event["type"] == "done")
                    self.assertTrue(done["ok"], done.get("reply"))
                    self.assertEqual(done["reply"].strip(), nonce)
                    self.assertGreaterEqual(len(requests), 2)
                    # The CLI may issue a separate title/metadata request concurrently.
                    parts = [part for request in requests[1:] for content in request["contents"]
                             for part in content.get("parts", [])]
                    self.assertTrue(any(part.get("thoughtSignature") == signature for part in parts),
                                    [{"keys": list(part)} for part in parts])
                    self.assertTrue(any(nonce in json.dumps(part.get("functionResponse", {})) for part in parts))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_custom_api_model_uses_native_model_path_and_completes(self):
        paths = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                paths.append(urlsplit(self.path).path)
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                payload = {"candidates": [{"content": {"role": "model", "parts": [{"text": "OK"}]},
                                            "finishReason": "STOP"}],
                           "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1, "totalTokenCount": 2}}
                body = ("data: " + json.dumps(payload) + "\n\n").encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
                "GEMINI_API_KEY": "dummy-offline-key",
                "GOOGLE_GEMINI_BASE_URL": f"http://127.0.0.1:{server.server_port}",
                "TINA_ANTIGRAVITY_AUTH_MODE": "gemini-api",
                "TINA_AGENT_MODEL": "gemini-3.5-flash",
                "TINA_AGENT_EFFORT": "xhigh",  # ignored, including a legacy environment pin
            }):
                harness = AntigravityHarness()
                work = Path(directory)
                harness.prepare(work)
                events = list(harness.run_turn(work, "Reply only OK. Do not use tools.",
                                              model="gemini-3.5-flash", allowed_tools=[]))
                done = next(event for event in reversed(events) if event["type"] == "done")
                self.assertTrue(done["ok"], done.get("reply"))
                self.assertEqual(done["reply"].strip(), "OK")
                self.assertIn("/v1beta/models/gemini-3.5-flash:streamGenerateContent", paths)
                self.assertTrue(all("generativelanguage.googleapis.com" not in path for path in paths))
                self.assertTrue(all("/v1beta/v1beta/" not in path for path in paths))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
