"""Bounded health diagnostics, configuration authority and credential boundaries."""
import importlib.util
import json
from pathlib import Path
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest.mock import Mock, patch

BIN = Path(__file__).resolve().parent.parent / "bin"
spec = importlib.util.spec_from_file_location("diagnostics_test", BIN / "tina_diagnostics.py")
diag = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diag)
GOLDEN = json.loads((BIN.parents[2] / "core/meetings/contracts/asr-status.v1/golden/Status.json").read_text())


class Selected:
    def __init__(self):
        self.context, self.project = "test", "test-instance"
        self.base, self.env, self.runtime = ["docker", "--context=test", "compose", "-p", "test-instance"], {}, {}
        self.services = {
            "admin-api": {"environment": {"INTERNAL_API_SECRET": "identity-secret"}},
            "meeting-api": {"environment": {"TRANSCRIPTION_SERVICE_URL": "http://legacy-asr",
                                           "TRANSCRIPTION_SERVICE_TOKEN": "legacy-token",
                                           "DIARIZATION_SERVICE_URL": "http://host.docker.internal:18014",
                                           "ALIGNMENT_SERVICE_URL": "http://host.docker.internal:18015"}}}
        self.preflight, self.guard_existing_config, self.check_images, self.readiness = [Mock() for _ in range(4)]

    def endpoint(self, *args):
        return "http://127.0.0.1:9999"


class DiagnosticsTest(unittest.TestCase):
    def setUp(self):
        self.selected = Selected()
        self.calls = []

    def response(self, url, headers=None, payload=None):
        self.calls.append((url, headers, payload))
        if "/internal/transcription/resolve" in url:
            return {"state": "responding", "body": {"backend": "funasr", "url": "http://host.docker.internal:18000/v1/audio/transcriptions",
                                                    "token": "resolved-secret", "model": "custom"}}
        if ":8056" in url:
            return {"state": "responding", "body": {"ok": True, "checks": {"stt_settings": "central"}, "live_sessions": 0}}
        if ":18000" in url:
            return {"state": "responding", "body": GOLDEN, "http_status": 200}
        return {"state": "responding", "body": {"status": "ok", "runtime": "worker"}}

    def full(self):
        with patch.object(diag, "request_json", side_effect=self.response), patch.object(diag, "container_request", return_value={"state": "responding", "body": GOLDEN}), patch.object(diag.socket, "create_connection") as tcp:
            data = diag.full_diagnostics(self.selected, lambda text: text.replace("identity-secret", "[REDACTED]"))
            tcp.return_value.send.assert_not_called()
            return data

    def test_resolver_authority_overrides_env_and_only_allowlisted_metadata_escapes(self):
        result = self.full()
        rows = {row["name"]: row for row in result["diagnostics"]}
        self.assertEqual(rows["asr_desktop"]["backend"], "funasr")
        self.assertEqual(rows["asr_desktop"]["model"], "Qwen/Qwen3-ASR-0.6B")
        self.assertTrue(any(url == "http://127.0.0.1:18000/status" for url, _, _ in self.calls))
        self.assertFalse(any("legacy-asr" in url for url, _, _ in self.calls))
        self.assertEqual(rows["capture_bridge"]["state"], "not_verified")
        self.assertTrue(rows["capture_bridge"]["listener_reachable"])
        self.assertTrue(result["ready"])
        self.assertFalse(result["complete"])
        for secret in ("identity-secret", "resolved-secret", "legacy-token"):
            self.assertNotIn(secret, json.dumps(result))

    def test_bound_desktop_credential_denial_does_not_fall_back_to_global(self):
        self.selected.runtime["TINA_DESKTOP_API_KEY"] = "bound-key"
        original = self.response
        def response(url, headers=None, payload=None):
            if payload and payload.get("token") == "bound-key":
                return {"state": "access_denied", "http_status": 401}
            return original(url, headers, payload)
        with patch.object(diag, "request_json", side_effect=response), patch.object(diag, "container_request", return_value={"state": "responding", "body": GOLDEN}), patch.object(diag.socket, "create_connection"):
            result = diag.full_diagnostics(self.selected, str)
        rows = {row["name"]: row for row in result["diagnostics"]}
        self.assertEqual(rows["asr_desktop"]["state"], "access_denied")
        self.assertEqual(rows["asr_bot"]["state"], "ready")
        self.assertFalse(result["ready"])

    def test_named_unconfigured_backend_never_uses_deployment_fallback(self):
        with patch.object(diag, "request_json", return_value={"state": "responding", "body": {"backend": "custom", "url": "", "token": "", "model": ""}}):
            self.assertEqual(diag.resolve_asr(self.selected)["state"], "unconfigured")

    def test_explicit_deployment_fallback_matches_existing_desktop_behavior(self):
        with patch.object(diag, "request_json", return_value={"state": "responding", "body": {"backend": "deployment", "url": "", "token": ""}}):
            data = diag.resolve_asr(self.selected)
        self.assertEqual(data["config"]["url"], "http://legacy-asr")
        self.assertEqual(data["config"]["token"], "legacy-token")

    def test_each_compose_failure_is_preserved_and_other_checks_still_run(self):
        self.selected.preflight.side_effect = RuntimeError("test engine unavailable")
        result = self.full()
        self.assertFalse(result["ready"])
        self.selected.readiness.assert_called_once()
        self.assertEqual(result["diagnostics"][0]["state"], "error")
        self.assertTrue(any(row["name"] == "alignment" for row in result["diagnostics"]))

    def test_unconfigured_optional_workers_are_explicit_and_not_probed(self):
        self.selected.services["meeting-api"]["environment"].pop("ALIGNMENT_SERVICE_URL")
        result = self.full()
        row = next(row for row in result["diagnostics"] if row["name"] == "alignment")
        self.assertEqual(row["state"], "unconfigured")
        self.assertFalse(row["required"])
        self.assertFalse(any(":18015" in url for url, _, _ in self.calls))

    def test_closed_capture_listener_is_a_blocker_without_creating_session(self):
        with patch.object(diag, "request_json", side_effect=self.response), patch.object(diag, "container_request", return_value={"state": "responding", "body": GOLDEN}), patch.object(diag.socket, "create_connection", side_effect=OSError):
            result = diag.full_diagnostics(self.selected, str)
        self.assertFalse(result["ready"])
        row = next(row for row in result["diagnostics"] if row["name"] == "capture_bridge")
        self.assertEqual(row["state"], "unreachable")

    def test_backend_response_cannot_echo_token_in_model_metadata(self):
        body = {**GOLDEN, "model": {key: "resolved-secret\x1b\n" for key in GOLDEN["model"]}}
        resolved = {"state": "configured", "config": {"backend": "custom", "url": "http://asr", "token": "resolved-secret"}}
        with patch.object(diag, "request_json", return_value={"state": "responding", "body": body}):
            row = diag.asr_check(self.selected, resolved, "asr", "test", str, True)
        self.assertNotIn("resolved-secret", json.dumps(row))
        self.assertNotIn("\x1b", row["model"] + row["vad"] + row["device"])
        self.assertNotIn("\n", row["model"] + row["vad"] + row["device"])

    def test_unsupported_or_wrong_service_is_never_ready(self):
        config = {"state": "configured", "config": {"backend": "custom", "url": "http://asr", "token": ""}}
        for response in [{"state": "unsupported", "http_status": 404},
                         {"state": "responding", "body": {"model": "wrong service"}}]:
            with self.subTest(response=response), patch.object(diag, "request_json", return_value=response):
                self.assertNotEqual(diag.asr_check(self.selected, config, "asr", "test", str, True)["state"], "ready")

    def test_endpoint_normalization_rejects_embedded_credentials_and_queries(self):
        self.assertEqual(diag.endpoint("http://host.docker.internal:18000/prefix/v1/audio/transcriptions/", "/status", True),
                         "http://127.0.0.1:18000/prefix/status")
        for url in ["file:///etc/passwd", "http://name:password@localhost", "http://localhost/?key=secret", "http://localhost/#frag"]:
            with self.assertRaises(ValueError):
                diag.endpoint(url, "/health")

    def test_container_probe_credentials_are_stdin_only(self):
        response = subprocess.CompletedProcess([], 0, '{"state":"access_denied","http_status":401}', "")
        with patch.object(diag.subprocess, "run", return_value=response) as run:
            result = diag.container_request(self.selected, "http://asr/status", "private-token")
        self.assertEqual(result["state"], "access_denied")
        self.assertNotIn("private-token", " ".join(run.call_args.args[0]))
        self.assertIn("private-token", run.call_args.kwargs["input"])
        self.assertEqual(run.call_args.kwargs["timeout"], 8)


class HttpBoundaryTest(unittest.TestCase):
    def test_redirect_does_not_forward_auth_and_oversize_body_is_rejected(self):
        hits = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                hits.append((self.path, self.headers.get("Authorization")))
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", "/target")
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"x" * (diag.LIMIT + 1))
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = "http://127.0.0.1:" + str(server.server_port)
            result = diag.request_json(base + "/redirect", {"Authorization": "Bearer test-token"})
            self.assertEqual(result["state"], "redirect_refused")
            self.assertEqual(len(hits), 1)
            self.assertEqual(diag.request_json(base + "/large")["state"], "invalid_response")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
