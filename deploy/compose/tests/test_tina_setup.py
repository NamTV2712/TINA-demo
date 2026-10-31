"""Fresh-install safety and wizard flow; no production mutations or image builds."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from test_tina_cli import cli, tui
import tina_setup as setup


class SetupTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / ".env"
        self.selected = Mock()
        self.selected.env_file = self.path
        self.selected.context, self.selected.project = "orbstack", "new-tina"
        self.selected.env = {"ENV_FILE": str(self.path), "PROJECT": "new-tina",
                             "COMPOSE_PROJECT_NAME": "new-tina", "COMPOSE_PROFILES": "",
                             "DOCKER_CONTEXT": "orbstack", "COMPOSE_FILE": str(setup.stack.HERE / "docker-compose.yml"),
                             "IMAGE_TAG": "new-tina"}
        self.selected.config = {"volumes": {"data": {"name": "new-tina_data"}},
                                "networks": {"tina": {"name": "new-tina_tina"}}}
        self.selected.services = {"terminal": {"ports": [{"published": "13000", "host_ip": "127.0.0.1"}]}}
        self.selected.config["services"] = self.selected.services
        self.selected.plan_data.return_value = {"env_file": str(self.path), "project": "new-tina",
                                                "docker_context": "orbstack", "services": ["terminal"]}
        self.selected.endpoint.return_value = "http://127.0.0.1:13000"
        self.calls = []

        def run(args, **kwargs):
            self.calls.append(args)
            output = "unix:///private/docker.sock" if args[1:3] == ["context", "inspect"] else ""
            return subprocess.CompletedProcess(args, 1 if args[1] in {"volume", "network"} else 0, output, "")

        for item in (patch.dict(os.environ, {"ENV_FILE": str(self.path), "DOCKER_CONTEXT": "orbstack"}, clear=True),
                     patch.object(setup.stack, "run", side_effect=run),
                     patch.object(setup.shutil, "which", return_value="/usr/bin/tool"),
                     patch.object(setup.socket, "socket")):
            item.start()
            self.addCleanup(item.stop)

    def test_prepare_ignores_other_installation_env_and_pins_base_config(self):
        with patch.dict(os.environ, {"COMPOSE_FILE": "production.yml", "PROJECT": "production",
                                    "ADMIN_TOKEN": "never-copy-this", "TERMINAL_PORT": "23000"}), \
                patch.object(setup.stack, "Stack", return_value=self.selected) as constructor:
            setup.prepare("new-tina")
        env = constructor.call_args.kwargs["env"]
        self.assertEqual(env["PROJECT"], "new-tina")
        self.assertEqual(env["COMPOSE_FILE"], str(setup.stack.HERE / "docker-compose.yml"))
        self.assertNotIn("ADMIN_TOKEN", env)
        self.assertNotIn("TERMINAL_PORT", env)
        self.assertFalse(self.path.exists())

    def test_existing_file_and_dangling_symlink_are_kept_without_docker_calls(self):
        for symlink in (False, True):
            if symlink:
                self.path.symlink_to(self.path.parent / "missing")
            else:
                self.path.write_text("keep-private-config")
            with self.assertRaisesRegex(setup.stack.StackError, "already exists"):
                setup.prepare("new-tina")
            self.assertFalse(self.calls)
            if not symlink:
                self.assertEqual(self.path.read_text(), "keep-private-config")
            self.path.unlink()

    def test_prerequisite_and_project_validation_fail_before_mutation(self):
        for project in ("-bad", "../production", "UpperCase", "a" * 64):
            with self.assertRaises(setup.stack.StackError):
                setup.prepare(project)
        with patch.object(setup.shutil, "which", return_value=None):
            with self.assertRaisesRegex(setup.stack.StackError, "Missing docker"):
                setup.prepare("new-tina")
        self.assertFalse(self.path.exists())
        self.assertFalse(self.calls)

    def test_remote_daemon_is_rejected_before_local_port_checks_or_config(self):
        with patch.object(setup.stack, "run", return_value=subprocess.CompletedProcess([], 0, "ssh://remote", "")), \
                patch.object(setup.stack, "Stack") as selected:
            with self.assertRaisesRegex(setup.stack.StackError, "local Docker socket"):
                setup.prepare("new-tina")
        selected.assert_not_called()
        self.assertFalse(self.path.exists())

    def test_existing_resources_external_volume_and_busy_port_block_creation(self):
        for kind in ("containers", "volume", "network", "external", "port"):
            with self.subTest(kind=kind):
                self.selected.config["volumes"]["data"]["external"] = kind == "external"
                with patch.object(setup.stack, "run") as run, patch.object(setup.socket, "socket") as sock:
                    def probe(args, **kwargs):
                        return subprocess.CompletedProcess(args, 0 if args[1] == kind else 1,
                                                           "container" if kind == "containers" else "", "")
                    run.side_effect = probe
                    if kind == "port":
                        sock.return_value.__enter__.return_value.bind.side_effect = OSError
                    with self.assertRaises(setup.stack.StackError):
                        setup.create(self.selected)
                self.assertFalse(self.path.exists())

    def test_atomic_private_creation_mints_unique_secrets_and_never_overwrites(self):
        with patch.object(setup.stack, "Stack", return_value=self.selected):
            setup.create(self.selected)
        text = self.path.read_text()
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        secrets = [line.split("=", 1)[1] for line in text.splitlines()
                   if line.split("=", 1)[0] in {"ADMIN_TOKEN", "INTERNAL_API_SECRET", "DB_PASSWORD",
                                               "NEXTAUTH_SECRET", "TINA_DISPATCH_SIGNING_KEY"}]
        self.assertEqual(len(set(secrets)), 5)
        self.assertTrue(all(len(value.strip("'")) == 64 for value in secrets))
        with self.assertRaises(FileExistsError):
            setup.create(self.selected)
        self.assertEqual(self.path.read_text(), text)
        self.assertEqual(list(self.path.parent.glob(".tina-setup-*")), [])

    def invoke(self, argv):
        output = io.StringIO()
        with patch.object(cli.sys, "stdout", output), patch.object(cli.sys, "stdin", io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()):
            code = cli.main(argv)
        return code, json.loads(output.getvalue())

    def test_dry_run_runs_no_creation_or_deploy_and_has_one_json_envelope(self):
        with patch.object(setup, "prepare", return_value=self.selected), patch.object(setup, "create") as create, \
                patch.object(cli, "execute") as execute:
            code, data = self.invoke(["setup", "--dry-run", "--json"])
        self.assertEqual(code, 0)
        self.assertFalse(data["data"]["will_write"])
        create.assert_not_called()
        execute.assert_not_called()

    def test_pipe_requires_confirmation_then_reuses_deploy_and_returns_asr_pending(self):
        with patch.object(setup, "prepare", return_value=self.selected), \
                patch.object(setup, "create", return_value=self.selected) as create, patch.object(cli, "execute") as execute:
            code, data = self.invoke(["setup", "--json"])
            self.assertEqual(code, 2)
            self.assertEqual(data["error"]["code"], "confirmation_required")
            create.assert_not_called()
            code, data = self.invoke(["setup", "--yes", "--json"])
        self.assertEqual(code, 0)
        create.assert_called_once()
        self.assertEqual(execute.call_args.args[1].command, "deploy")
        self.assertFalse(data["data"]["asr_ready"])
        self.assertIn(str(self.path), data["data"]["next_steps"][0])
        self.assertIn(("Set up a new installation", ["setup"]), tui.MENU)

    def test_failed_build_retains_config_and_recovery_commands(self):
        def create(selected):
            self.path.write_text("private-file-kept")
            return selected
        with patch.object(setup, "prepare", return_value=self.selected), \
                patch.object(setup, "create", side_effect=create), \
                patch.object(cli, "execute", side_effect=setup.stack.StackError("Build failed")):
            code, data = self.invoke(["setup", "--yes", "--json"])
        self.assertEqual(code, 1)
        self.assertEqual(data["data"]["setup"], "incomplete")
        self.assertIn("tina deploy", data["data"]["next_steps"][1])
        self.assertEqual(self.path.read_text(), "private-file-kept")

    def test_interactive_setup_reuses_asr_configure_and_reports_failed_probe(self):
        output = io.StringIO()
        output.isatty = lambda: True
        stdin = Mock()
        stdin.isatty.return_value = True
        for probe_fails in (False, True):
            with self.subTest(probe_fails=probe_fails):
                output.seek(0)
                output.truncate()
                calls = []
                def execute(selected, args):
                    calls.append(args.command + ":" + getattr(args, "asr_action", ""))
                    if getattr(args, "asr_action", "") == "verify":
                        data = {"ready": not probe_fails, "diagnostics": [{"name": "asr", "state": "unreachable" if probe_fails else "ready"}]}
                        if probe_fails:
                            raise cli.CliError("asr_verification_failed", "failed probe", 1, data)
                        return data
                    return {}
                with patch.object(setup, "prepare", return_value=self.selected), \
                        patch.object(setup, "create", return_value=self.selected), patch.object(cli, "execute", side_effect=execute), \
                        patch.object(cli.sys, "stdout", output), patch.object(cli.sys, "stdin", stdin), \
                        patch("builtins.input", return_value="y"), patch.object(cli, "emit") as emit, \
                        contextlib.redirect_stderr(io.StringIO()):
                    code = cli.main(["setup", "--yes", "--format", "table"])
                self.assertEqual(calls, ["deploy:", "asr:configure", "asr:verify"])
                self.assertEqual(code, 1 if probe_fails else 0)
                data = emit.call_args.args[1]
                self.assertEqual(data["asr_ready"], not probe_fails)
                self.assertEqual(data["setup"], "platform_ready")


if __name__ == "__main__":
    unittest.main()
