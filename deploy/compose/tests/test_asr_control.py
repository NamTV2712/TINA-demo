"""Per-account resource arbitration; no real model, Docker or LaunchAgent is changed."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import json
import importlib.util
import os
import threading
from types import SimpleNamespace
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer

BIN = Path(__file__).resolve().parent.parent / "bin"
spec = importlib.util.spec_from_file_location("asr_control", BIN / "asr_control.py")
control = importlib.util.module_from_spec(spec); spec.loader.exec_module(control)


class Identity:
    def __init__(self):
        self.users = {"1": {"backend": "viegem", "enabled": True, "revision": 0},
                      "2": {"backend": "viegem", "enabled": True, "revision": 0}}
    def read(self, user_id=None):
        return {"account": copy.deepcopy(self.users.get(user_id)),
                "counts": {name: sum(u["enabled"] and u["backend"] == name for u in self.users.values()) for name in control.BACKENDS}}
    def update(self, uid, backend, enabled, revision):
        if self.users[uid]["revision"] != revision: raise control.ControlError(409, "Stale")
        self.users[uid] = {"backend": backend, "enabled": enabled, "revision": revision + 1}


class Workers:
    def __init__(self): self.running = {name: True for name in control.BACKENDS}; self.calls = []; self.busy_now = False; self.fail_start = False; self.can_drain = True
    def status(self, name): return {"running": self.running[name], "ready": self.running[name]}
    def start(self, name):
        if self.fail_start: raise control.ControlError(503, "Startup failed")
        self.calls.append(("start", name)); self.running[name] = True
    def stop(self, name): self.calls.append(("stop", name)); self.running[name] = False
    def busy(self): return self.busy_now
    def drain(self, name, enabled): self.calls.append(("drain", name, enabled)); return self.can_drain


class ControlTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.identity, self.workers = Identity(), Workers()
        self.controller = control.Controller(self.identity, self.workers, Path(directory.name) / "state.json", "fixture", grace=0)
    def test_switch_keeps_worker_required_by_another_account(self):
        self.controller.select("1", "gipformer", True, 0)
        self.assertTrue(self.workers.running["viegem"])
        self.assertEqual(self.identity.users["2"]["backend"], "viegem")
        self.controller.select("2", "gipformer", True, 0)
        self.assertFalse(self.workers.running["viegem"])
    def test_busy_sessions_and_inflight_audio_prevent_stop(self):
        self.workers.busy_now = True
        self.controller.select("1", "gipformer", True, 0); self.controller.select("2", "gipformer", True, 0)
        self.assertTrue(self.workers.running["viegem"])
        self.workers.busy_now = False; self.workers.can_drain = False; self.controller.reconcile()
        self.assertTrue(self.workers.running["viegem"])
        self.workers.can_drain = True; self.controller.reconcile(); self.assertFalse(self.workers.running["viegem"])
    def test_failed_identity_recheck_reopens_drained_worker(self):
        original = self.identity.read
        def fail(_=None): raise control.ControlError(503, "Identity unavailable")
        self.identity.read = fail
        with self.assertRaises(control.ControlError): self.controller._retire({"gipformer": 1, "viegem": 0})
        self.assertIn(("drain", "viegem", False), self.workers.calls)
        self.assertTrue(self.workers.running["viegem"])
        self.identity.read = original
    def test_recent_completed_audio_defers_retirement(self):
        self.controller.grace = 10
        self.controller.unneeded_since["viegem"] = -1000
        original = self.workers.status
        self.workers.status = lambda name: {**original(name), "idle_seconds": 2}
        self.controller._retire({"gipformer": 1, "viegem": 0})
        self.assertTrue(self.workers.running["viegem"])
        self.assertFalse(any(call[0] == "drain" for call in self.workers.calls))
    def test_failed_start_and_stale_selection_never_overwrite_preferences(self):
        before = copy.deepcopy(self.identity.users); self.workers.fail_start = True
        with self.assertRaises(control.ControlError): self.controller.select("1", "gipformer", True, 0)
        self.assertEqual(self.identity.users, before)
        self.workers.fail_start = False
        with self.assertRaises(control.ControlError): self.controller.select("1", "gipformer", True, 99)
        self.assertEqual(self.identity.users, before)

    def test_http_requires_derived_key_and_rejects_extra_fields(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), control.handler(self.controller, "control-private"))
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_port}/runtime"
        def call(payload, key):
            req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"X-ASR-Control-Key": key})
            try:
                with urllib.request.urlopen(req) as response: return response.status, json.load(response)
            except urllib.error.HTTPError as error: return error.code, json.load(error)
        payload = {"user_id": "1", "backend": "gipformer", "enabled": True, "revision": 0}
        self.assertEqual(call(payload, "wrong")[0], 401)
        self.assertEqual(call({**payload, "command": "stop everything"}, "control-private")[0], 422)
        code, body = call(payload, "control-private")
        self.assertEqual(code, 200)
        self.assertEqual(body["account"]["backend"], "gipformer")
        self.assertNotIn("control-private", str(body))

    def test_discord_sessions_hold_workers_and_unavailable_connector_fails_safe(self):
        root = Path(__file__).resolve().parents[3]
        spec = importlib.util.spec_from_file_location("deployment_stack", root / "deploy/compose/bin/stack.py")
        stack = importlib.util.module_from_spec(spec); spec.loader.exec_module(stack)
        selected = SimpleNamespace(config={"networks": {"tina": {"name": "test-net"}}}, env={},
            services={"discord-connector": {}, "admin-api": {"environment": {}}}, endpoint=lambda *_: "http://127.0.0.1:18101")
        workers = control.Workers(selected)
        with patch.dict("sys.modules", {"stack": stack}), patch.object(stack, "run", return_value=SimpleNamespace(returncode=0, stdout="")), \
             patch.object(control, "request_json", return_value={"sessions": 1}):
            self.assertTrue(workers.busy())
        with patch.dict("sys.modules", {"stack": stack}), patch.object(stack, "run", return_value=SimpleNamespace(returncode=0, stdout="")), \
             patch.object(control, "request_json", side_effect=control.ControlError(503, "unavailable")):
            self.assertTrue(workers.busy())
