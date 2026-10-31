"""Settings writes target an in-memory API double; production is never changed."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch, Mock

import test_tina_cli

spec = importlib.util.spec_from_file_location("asr_test", test_tina_cli.BIN / "tina_asr.py")
asr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(asr)


def args(**kwargs):
    base = dict(scope="global", backend="custom", url="http://host.docker.internal:18002",
                token_env=None, token_file=None, clear_token=False, dry_run=False, yes=True)
    return SimpleNamespace(**{**base, **kwargs})


class AsrTest(unittest.TestCase):
    def setUp(self):
        self.selected = SimpleNamespace(
            context="test", project="test", env={}, runtime={},
            services={"admin-api": {"environment": {"INTERNAL_API_SECRET": "private-internal"},
                                   "ports": [{"target": 8001, "published": "9999"}]}},
            endpoint=lambda *_: "http://127.0.0.1:9999",
            validate_bindings=Mock(), guard_existing_config=Mock(),
            compose=Mock(return_value=SimpleNamespace(stdout=json.dumps(
                {"Service": "admin-api", "Project": "test", "State": "running",
                 "Publishers": [{"TargetPort": 8001, "PublishedPort": 9999}]}))))
        self.global_config = {"default_backend": "deployment", "apple_url": "http://apple",
                              "apple_token": "keep-apple", "unrelated": "keep"}
        self.account = {"backend": "default", "available_backends": ["default", "custom", "apple"],
                        "url": None, "token_set": False}
        self.account_secret = ""
        self.requests = []
        self.approval = Mock()
        self.patches = [patch.object(asr.diagnostics, "request_json", side_effect=self.request),
                        patch.object(asr.diagnostics, "resolve_asr", side_effect=self.resolve)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def request(self, url, auth=None, payload=None, method=None):
        self.requests.append((url, auth, copy.deepcopy(payload), method))
        if url.endswith("/internal/validate"):
            body = {"user_id": 7, "scopes": ["tx"], "webhook_secret": "never-expose"}
            return {"state": "responding", "body": body} if payload["token"] == "user-key" else {"state": "access_denied"}
        if url.endswith("/internal/settings/transcription"):
            if payload is not None:
                for key, value in payload.items():
                    if value:
                        self.global_config[key] = value
                    else:
                        self.global_config.pop(key, None)
            return {"state": "responding", "body": {"key": "transcription", "value": copy.deepcopy(self.global_config)}}
        if url.endswith("/user/transcription"):
            if auth != {"X-API-Key": "user-key"}:
                return {"state": "access_denied"}
            if payload is not None:
                for key, value in payload.items():
                    if key == "token":
                        self.account_secret = value
                        self.account.update(token_set=bool(value), token="********masked" if value else None)
                    else:
                        self.account[key] = value or None
            return {"state": "responding", "body": copy.deepcopy(self.account)}
        raise AssertionError("Unexpected API request")

    def resolve(self, selected, key=""):
        if key:
            custom = self.account["backend"] == "custom"
            config = {"backend": "custom" if custom else "deployment", "url": self.account.get("url") if custom else self.global_config.get("url", ""),
                      "token": self.account_secret if custom else self.global_config.get("token", "")}
        else:
            config = {"backend": self.global_config.get("default_backend", "deployment"), "url": self.global_config.get("url", ""),
                      "token": self.global_config.get("token", "")}
        return {"state": "configured" if config.get("url") else "unconfigured", "config": config}

    def writes(self):
        return [row for row in self.requests if row[-1] == "PUT"]

    def test_dry_run_shows_scope_mapping_and_token_action_without_write_or_secret(self):
        self.selected.env["ENDPOINT_TOKEN"] = "new-private-token"
        result = asr.configure(self.selected, args(token_env="ENDPOINT_TOKEN", dry_run=True), self.approval)
        self.approval.assert_not_called()
        self.assertFalse(self.writes())
        self.assertEqual(result["asr_change"]["stored_backend"], "deployment")
        self.assertEqual(result["asr_change"]["scope"], "global")
        self.assertNotIn("new-private-token", json.dumps(result))
        self.assertNotIn("private-internal", json.dumps(result))

    def test_global_custom_partial_write_preserves_other_fields_and_re_resolves(self):
        self.selected.env["ENDPOINT_TOKEN"] = "new-private-token"
        result = asr.configure(self.selected, args(token_env="ENDPOINT_TOKEN"), self.approval)
        self.assertTrue(result["asr_change"]["saved"])
        self.assertEqual(self.global_config["unrelated"], "keep")
        self.assertEqual(self.global_config["apple_token"], "keep-apple")
        self.assertEqual(self.writes()[0][2], {"default_backend": "deployment", "url": "http://host.docker.internal:18002", "token": "new-private-token"})
        self.assertNotIn("new-private-token", json.dumps(result))
        self.approval.assert_called_once()

    def test_account_write_is_credential_scoped_and_does_not_change_global(self):
        self.selected.env.update(TINA_API_KEY="user-key", ENDPOINT_TOKEN="account-token")
        before = copy.deepcopy(self.global_config)
        result = asr.configure(self.selected, args(scope="account", token_env="ENDPOINT_TOKEN"), self.approval)
        self.assertEqual(before, self.global_config)
        self.assertEqual(result["asr_change"]["account_id"], 7)
        self.assertTrue(self.writes()[0][0].endswith("/user/transcription"))
        self.assertEqual(self.writes()[0][1], {"X-API-Key": "user-key"})
        self.assertNotIn("account-token", json.dumps(result))

    def test_invalid_expired_or_missing_account_never_falls_back_to_global(self):
        for key in ("", "bad-key"):
            with self.subTest(key=key):
                self.selected.env["TINA_API_KEY"] = key
                with self.assertRaises(asr.AsrError):
                    asr.configure(self.selected, args(scope="account"), self.approval)
                self.assertFalse(self.writes())

    def test_changed_endpoint_requires_explicit_credential_decision(self):
        self.global_config.update(url="http://old-asr", token="keep-private")
        with self.assertRaisesRegex(asr.AsrError, "Endpoint changed"):
            asr.configure(self.selected, args(), self.approval)
        self.assertFalse(self.writes())
        result = asr.configure(self.selected, args(clear_token=True), self.approval)
        self.assertNotIn("token", self.global_config)
        self.assertEqual(result["asr_change"]["credential_change"], "clear")

    def test_unchanged_endpoint_preserves_token_without_resending_it(self):
        self.global_config.update(url="http://host.docker.internal:18002", token="preserve-private")
        asr.configure(self.selected, args(), self.approval)
        self.assertNotIn("token", self.writes()[0][2])
        self.assertEqual(self.global_config["token"], "preserve-private")

    def test_global_edit_during_review_is_rejected(self):
        def approve(_):
            self.global_config["url"] = "http://changed-elsewhere"
        with self.assertRaisesRegex(asr.AsrError, "changed while reviewing"):
            asr.configure(self.selected, args(), approve)
        self.assertFalse(self.writes())

    def test_cancel_occurs_before_put(self):
        def cancel(_):
            raise asr.AsrError("cancelled", "cancel")
        with self.assertRaises(asr.AsrError):
            asr.configure(self.selected, args(), cancel)
        self.assertFalse(self.writes())

    def test_unconfirmed_write_does_not_claim_rollback_or_retry(self):
        original = self.request
        def response(url, auth=None, payload=None, method=None):
            result = original(url, auth, payload, method)
            return {"state": "unreachable"} if method == "PUT" else result
        with patch.object(asr.diagnostics, "request_json", side_effect=response):
            with self.assertRaisesRegex(asr.AsrError, "do not assume rollback"):
                asr.configure(self.selected, args(), self.approval)
        self.assertEqual(len(self.writes()), 1)

    def test_readback_wrong_token_is_not_mistaken_for_verified_presence(self):
        self.selected.env["ENDPOINT_TOKEN"] = "expected-token"
        original = self.request
        def response(url, auth=None, payload=None, method=None):
            result = original(url, auth, payload, method)
            if method == "PUT":
                self.global_config["token"] = "different-token"
            return result
        with patch.object(asr.diagnostics, "request_json", side_effect=response):
            with self.assertRaisesRegex(asr.AsrError, "readback did not match"):
                asr.configure(self.selected, args(token_env="ENDPOINT_TOKEN"), self.approval)

    def test_private_token_file_and_symlink_or_world_readable_file_rules(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "token"
            path.write_text("private-file-token")
            path.chmod(0o600)
            result = asr.configure(self.selected, args(token_file=str(path), dry_run=True), self.approval)
            self.assertNotIn("private-file-token", json.dumps(result))
            path.chmod(0o644)
            with self.assertRaises(asr.AsrError):
                asr.configure(self.selected, args(token_file=str(path)), self.approval)
            link = Path(td) / "link"
            link.symlink_to(path)
            with self.assertRaises(OSError):
                asr.configure(self.selected, args(token_file=str(link)), self.approval)

    def test_bad_url_or_unsupported_token_field_is_rejected_before_write(self):
        for url in ("http://person:secret@host", "http://host?token=secret", "file:///etc/passwd", "http://host/\nvalue"):
            with self.assertRaises(asr.AsrError):
                asr.configure(self.selected, args(url=url), self.approval)
        with self.assertRaisesRegex(asr.AsrError, "no credential slot"):
            asr.configure(self.selected, args(backend="funasr", token_env="ANY"), self.approval)
        self.assertFalse(self.writes())

    def test_named_account_endpoint_is_global_owned(self):
        self.selected.env["TINA_API_KEY"] = "user-key"
        with self.assertRaisesRegex(asr.AsrError, "global endpoints"):
            asr.configure(self.selected, args(scope="account", backend="apple"), self.approval)
        asr.configure(self.selected, args(scope="account", backend="apple", url=None), self.approval)
        self.assertEqual(self.writes()[0][2], {"backend": "apple"})

    def test_status_and_verify_do_not_write_or_run_inference(self):
        result = asr.inspect(self.selected, "global", False, str)
        self.assertEqual(len(result["asr_settings"]), 2)
        with patch.object(asr.diagnostics, "asr_check", return_value={"state": "unreachable"}):
            self.assertFalse(asr.inspect(self.selected, "global", True, str)["ready"])
        self.assertFalse(self.writes())

    def test_wrong_project_or_missing_published_identity_is_refused(self):
        asr.validate_target(self.selected)
        self.selected.project = "another-stack"
        with self.assertRaises(asr.AsrError):
            asr.validate_target(self.selected)
        self.assertFalse(self.requests)

    def test_noninteractive_missing_scope_backend_does_not_prompt(self):
        with patch.object(asr.sys, "stdin", io.StringIO()), patch("builtins.input") as prompt:
            with self.assertRaises(asr.AsrError):
                asr.configure(self.selected, args(scope=None), self.approval)
            with self.assertRaises(asr.AsrError):
                asr.configure(self.selected, args(backend=None), self.approval)
            prompt.assert_not_called()

    def test_json_mode_does_not_prompt_even_on_tty(self):
        with patch.object(asr.sys, "stdin") as stdin, patch.object(asr.sys, "stdout") as stdout, patch("builtins.input") as prompt:
            stdin.isatty.return_value = stdout.isatty.return_value = True
            parsed = args(scope=None)
            parsed.json = True
            with self.assertRaises(asr.AsrError):
                asr.configure(self.selected, parsed, self.approval)
            prompt.assert_not_called()

    def test_eof_at_public_or_hidden_prompt_cancels_without_write(self):
        for hidden in (False, True):
            with self.subTest(hidden=hidden), patch("builtins.input", side_effect=EOFError), patch.object(asr.getpass, "getpass", side_effect=EOFError):
                with self.assertRaises(asr.AsrError) as error:
                    asr.read_input("Prompt", hidden)
                self.assertEqual(error.exception.code, "cancelled")
        self.assertFalse(self.writes())

    def test_malformed_settings_are_not_silently_rewritten(self):
        self.global_config["url"] = {"invalid": "object"}
        with self.assertRaisesRegex(asr.AsrError, "malformed"):
            asr.configure(self.selected, args(), self.approval)
        self.assertFalse(self.writes())


if __name__ == "__main__":
    unittest.main()
