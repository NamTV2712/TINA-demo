"""Pinned Claude Code tool round trips over native DeepSeek and Bedrock dialects.

Run in the worker image with network disabled. Both endpoints are loopback stubs
and all credentials are dummy values. Bedrock emits real AWS event-stream framing.
"""
import base64
import json
import os
from pathlib import Path
import shutil
import struct
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
import zlib

from llm.claude_code import ClaudeCodeHarness


def _anthropic_events(model, content):
    events = [{"type": "message_start", "message": {
        "id": "msg_wire", "type": "message", "role": "assistant", "model": model, "content": [],
        "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 1},
    }}]
    tool = content["type"] == "tool_use"
    initial = {**content, "input": {}} if tool else {"type": "text", "text": ""}
    delta = ({"type": "input_json_delta", "partial_json": json.dumps(content["input"])} if tool
             else {"type": "text_delta", "text": content["text"]})
    events += [{"type": "content_block_start", "index": 0, "content_block": initial},
               {"type": "content_block_delta", "index": 0, "delta": delta},
               {"type": "content_block_stop", "index": 0},
               {"type": "message_delta", "delta": {"stop_reason": "tool_use" if tool else "end_turn",
                "stop_sequence": None}, "usage": {"output_tokens": 5}}, {"type": "message_stop"}]
    return events


def _aws_event(payload):
    def header(name, value):
        name, value = name.encode(), value.encode()
        return bytes([len(name)]) + name + b"\x07" + struct.pack(">H", len(value)) + value
    headers = (header(":message-type", "event") + header(":event-type", "chunk")
               + header(":content-type", "application/json"))
    body = json.dumps({"bytes": base64.b64encode(json.dumps(payload).encode()).decode()}).encode()
    prelude = struct.pack(">II", 16 + len(headers) + len(body), len(headers))
    message = prelude + struct.pack(">I", zlib.crc32(prelude)) + headers + body
    return message + struct.pack(">I", zlib.crc32(message))


@unittest.skipUnless(shutil.which("claude"), "requires the pinned worker CLI")
class ClaudeCliWireTest(unittest.TestCase):
    def _tool_round_trip(self, bedrock):
        requests, called = [], []
        model = "us.anthropic.claude-sonnet-4-6" if bedrock else "deepseek-flash"
        nonce = "claude-native-read-tool-check"

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append({"path": self.path, "body": payload,
                                 "auth": self.headers.get("Authorization")})
                names = [tool.get("name") for tool in payload.get("tools", [])]
                if "Read" in names and not called:
                    called.append(True)
                    content = {"type": "tool_use", "id": "toolu_wire", "name": "Read",
                               "input": {"file_path": str(work / "note.txt")}}
                else:
                    content = {"type": "text", "text": nonce}
                events = _anthropic_events(model, content)
                if bedrock:
                    body = b"".join(_aws_event(event) for event in events)
                    content_type = "application/vnd.amazon.eventstream"
                else:
                    body = "".join("event: " + event["type"] + "\ndata: " + json.dumps(event)
                                   + "\n\n" for event in events).encode()
                    content_type = "text/event-stream"
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("x-amzn-bedrock-content-type", "application/json")
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
                url = f"http://127.0.0.1:{server.server_port}"
                environment = {
                    "HOME": str(work / "home"), "TINA_AGENT_EFFORT": "xhigh",
                    "TINA_AGENT_MODEL": model, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                    "CLAUDE_CODE_USE_BEDROCK": "1" if bedrock else "",
                    "ANTHROPIC_BASE_URL": "" if bedrock else url + "/anthropic",
                    "ANTHROPIC_AUTH_TOKEN": "" if bedrock else "dummy-offline-key",
                    "ANTHROPIC_API_KEY": "", "CLAUDE_CODE_OAUTH_TOKEN": "",
                    "AWS_BEARER_TOKEN_BEDROCK": "dummy-offline-key" if bedrock else "",
                    "AWS_REGION": "us-east-1", "AWS_DEFAULT_REGION": "us-east-1",
                    "ANTHROPIC_BEDROCK_BASE_URL": url if bedrock else "",
                }
                with patch.dict(os.environ, environment):
                    harness = ClaudeCodeHarness()
                    harness.prepare(work)
                    events = list(harness.run_turn(work, "Read note.txt with Read and reply only with its content.",
                                                  model=model, allowed_tools=["Read"]))
                done = next(event for event in reversed(events) if event["type"] == "done")
                self.assertTrue(done["ok"], done.get("reply"))
                self.assertEqual(done["reply"].strip(), nonce)
                self.assertTrue(called)
                self.assertTrue(any(nonce in json.dumps(message.get("content", []))
                    for request in requests for message in request["body"].get("messages", [])
                    if message.get("role") == "user"))
                self.assertTrue(all(request["auth"] == "Bearer dummy-offline-key" for request in requests))
                paths = [request["path"] for request in requests if request["body"].get("tools")]
                if bedrock:
                    self.assertTrue(any(path.endswith("/invoke-with-response-stream") for path in paths), paths)
                    self.assertTrue(all(request["body"].get("anthropic_version") == "bedrock-2023-05-31"
                                        for request in requests if request["body"].get("tools")))
                else:
                    self.assertTrue(any(path.startswith("/anthropic/v1/messages") for path in paths), paths)
                    self.assertTrue(all(request["body"].get("model") == model
                                        for request in requests if request["body"].get("tools")))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_deepseek_native_messages_tool_round_trip(self):
        self._tool_round_trip(False)

    def test_bedrock_native_stream_tool_round_trip(self):
        self._tool_round_trip(True)


if __name__ == "__main__":
    unittest.main()
