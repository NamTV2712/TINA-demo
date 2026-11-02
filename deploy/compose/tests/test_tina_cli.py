"""CLI/TUI regression tests; mutations use fake Docker, never production."""
import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch, Mock

import test_make_entrypoint as fixtures

BIN = Path(__file__).resolve().parent.parent / "bin"


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, BIN / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


cli = module("tina_cli_test", "tina.py")
tui = module("tina_tui_test", "tina_tui.py")
installer = module("tina_install_test", "install-tina.py")
style = module("tina_style_test", "tina_style.py")


def args(command, **kwargs):
    return argparse.Namespace(command=command, service=None, dry_run=False, yes=True, **kwargs)


class CliTest(unittest.TestCase):
    def setUp(self):
        self.docker = fixtures.Docker()
        for item in [patch.object(cli.stack, "run", self.docker),
                     patch.dict(os.environ, {"ENV_FILE": str(fixtures.ROOT / "deploy/compose/.env.example")}, clear=True)]:
            item.start()
            self.addCleanup(item.stop)
        self.selected = cli.stack.Stack("doctor")
        self.docker.calls.clear()

    def test_status_whitelists_fields_and_contains_no_env_credentials(self):
        self.docker.rows[0]["Secret"] = "private-fixture"
        data = cli.status(self.selected)
        self.assertNotIn("private-fixture", json.dumps(data))
        self.assertNotIn("Secret", json.dumps(data))
        self.assertEqual(data["project"], "existing")
        self.assertEqual(data["terminal_url"], "http://127.0.0.1:23000")

    def test_status_without_published_ui_does_not_fail(self):
        self.selected.services["terminal"]["ports"] = []
        self.assertIsNone(cli.status(self.selected)["terminal_url"])

    def test_every_mutation_dry_run_leaves_no_bootstrap_build_or_docker_mutation(self):
        for command in cli.MUTATIONS:
            with self.subTest(command=command):
                parsed = args(command)
                parsed.dry_run = True
                data = cli.execute(self.selected, parsed)
                self.assertFalse(data["will_write"])
        self.assertFalse(self.docker.calls, "Dry-run should only use already-resolved configuration")

    def test_restart_keeps_existing_image_and_does_not_recreate_or_build(self):
        parsed = args("restart")
        parsed.service = "terminal"
        cli.execute(self.selected, parsed)
        calls = [a for a, _ in self.docker.calls]
        restart = next(a for a in calls if "restart" in a)
        self.assertEqual(restart[-1], "terminal")
        self.assertIn("--no-deps", restart)
        self.assertFalse(any("build" in a or "up" in a or "--force-recreate" in a for a in calls))

    def test_restart_missing_container_refuses_without_implicit_up(self):
        self.docker.rows = [row for row in self.docker.rows if row["Service"] != "terminal"]
        parsed = args("restart")
        parsed.service = "terminal"
        with self.assertRaisesRegex(cli.CliError, "missing containers"):
            cli.execute(self.selected, parsed)
        self.assertFalse(any("restart" in a or "up" in a for a, _ in self.docker.calls))

    def test_down_retains_volumes(self):
        cli.execute(self.selected, args("down"))
        down = next(a for a, _ in self.docker.calls if "down" in a)
        self.assertNotIn("-v", down)

    def test_up_uses_wait_and_no_build(self):
        cli.execute(self.selected, args("up"))
        up = next(a for a, _ in self.docker.calls if "up" in a)
        self.assertIn("--no-build", up)
        self.assertIn("--wait", up)
        self.assertIn("never", up)
        self.assertFalse(any("build" in a for a, _ in self.docker.calls))

    def test_invalid_service_cannot_be_passed_as_compose_flag(self):
        for service in ("--volumes", "storage-init", "missing"):
            parsed = args("restart")
            parsed.service = service
            with self.assertRaises(cli.CliError):
                cli.execute(self.selected, parsed)
        self.assertFalse(self.docker.calls)

    def test_confirmation_never_reads_pipe_and_no_means_no_change(self):
        parsed = args("down")
        parsed.yes = False
        with patch.object(cli.sys, "stdin", io.StringIO()), patch("builtins.input") as prompt:
            with self.assertRaisesRegex(cli.CliError, "--yes"):
                cli.execute(self.selected, parsed)
            prompt.assert_not_called()
        with patch.object(cli.sys, "stdin") as stdin, patch.object(cli.sys, "stdout") as stdout, patch("builtins.input", return_value="n"):
            stdin.isatty.return_value = stdout.isatty.return_value = True
            with self.assertRaisesRegex(cli.CliError, "Cancelled"):
                cli.execute(self.selected, parsed)
        self.assertFalse(any("down" in a for a, _ in self.docker.calls))

    def test_json_mode_defaults_for_non_tty_and_preserves_error_envelope(self):
        for argv, expected in [(["status"], True), (["--json", "no-such-command"], False),
                               (["logs", "--tail", "1001", "--json"], False)]:
            stdout = io.StringIO()
            with patch.object(cli.sys, "stdout", stdout), patch.object(cli.sys, "stdin", io.StringIO()):
                code = cli.main(argv)
            result = json.loads(stdout.getvalue())
            self.assertEqual(result["ok"], expected)
            self.assertEqual(code, 0 if expected else 2)
            self.assertEqual(result["meta"]["schema_version"], "1")

    def test_read_commands_do_not_provision_access(self):
        for command in ("status", "plan", "doctor"):
            cli.execute(self.selected, args(command))
        self.assertFalse(any(a[0].endswith("/provision-token") for a, _ in self.docker.calls))

    def test_deploy_verifies_access_without_displaying_key(self):
        self.selected.env_file = BIN.parent / ".env"
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout), patch.object(cli.stack, "Stack", return_value=self.selected):
            data = cli.execute(self.selected, args("deploy"))
        self.assertNotIn("fixture-user-key", stdout.getvalue())
        self.assertFalse(data["credentials_displayed"])
        self.assertTrue(any(a[0].endswith("/provision-token") for a, _ in self.docker.calls))

    def test_log_redaction_includes_known_values_bearer_and_url_credentials(self):
        text = ('ADMIN_API_TOKEN=private-fixture\nAuthorization: Bearer hidden-value\n'
                '{"api_key":"unknown-db-key"}\nhttp://person:password@host/path')
        redacted = cli.redact(text, self.selected)
        for secret in ("private-fixture", "hidden-value", "unknown-db-key", "person:password"):
            self.assertNotIn(secret, redacted)
        self.assertIn("[REDACTED]", redacted)

    def test_split_child_output_is_redacted_and_does_not_reach_stdout(self):
        stderr = io.StringIO()
        stdout = io.StringIO()
        with patch.object(cli.sys, "stderr", stderr), contextlib.redirect_stdout(stdout):
            sink = cli.SafeOutput(self.selected)
            sink.write("key=private-")
            sink.write("fixture\nnext line")
            sink.flush()
        self.assertNotIn("private-fixture", stderr.getvalue())
        self.assertEqual(stdout.getvalue(), "")

    def test_open_uses_only_resolved_enabled_ui_and_dry_run_does_not_open(self):
        parsed = args("open")
        parsed.surface = "terminal"
        with patch.object(cli.webbrowser, "open", return_value=True) as browser:
            self.assertEqual(cli.execute(self.selected, parsed)["url"], "http://127.0.0.1:23000")
            browser.assert_called_once_with("http://127.0.0.1:23000")
            parsed.dry_run = True
            cli.execute(self.selected, parsed)
            browser.assert_called_once()
            parsed.dry_run = False
            parsed.surface = "dashboard"
            with self.assertRaises(cli.CliError):
                cli.execute(self.selected, parsed)

    def test_tui_requires_interactive_terminal(self):
        out = io.StringIO()
        with patch.object(cli.sys, "stdin", io.StringIO()), patch.object(cli.sys, "stdout", out):
            code = cli.main(["tui", "--json"])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(out.getvalue())["error"]["code"], "interactive_terminal_required")

    def test_full_doctor_retains_failed_diagnostics_in_json(self):
        result = {"ready": False, "diagnostics": [{"name": "asr", "state": "unreachable"}]}
        out = io.StringIO()
        with patch("tina_diagnostics.full_diagnostics", return_value=result), patch.object(cli.sys, "stdout", out):
            code = cli.main(["doctor", "--full", "--json"])
        body = json.loads(out.getvalue())
        self.assertEqual(code, 1)
        self.assertEqual(body["error"]["code"], "diagnostics_failed")
        self.assertEqual(body["data"]["diagnostics"], result["diagnostics"])

    def test_repository_checks_work_without_docker_and_preserve_failed_results(self):
        result = {"passed": False, "checks": [{"name": "graph", "exit_code": 9, "status": "fail", "log_path": "/private/check.log"}]}
        out = io.StringIO()
        with patch("tina_checks.run_checks", return_value=result), patch.object(cli.stack, "Stack", side_effect=AssertionError("Docker must not be resolved")), patch.object(cli.sys, "stdout", out):
            code = cli.main(["check", "graph", "--json"])
        self.assertEqual(code, 1)
        body = json.loads(out.getvalue())
        self.assertEqual(body["data"]["checks"][0]["exit_code"], 9)
        self.assertEqual(body["error"]["code"], "checks_failed")

    def test_check_dry_run_does_not_run_tests_or_create_logs(self):
        out = io.StringIO()
        with patch("tina_checks.run_checks") as run, patch.object(cli.stack, "Stack") as selected, patch.object(cli.sys, "stdout", out):
            self.assertEqual(cli.main(["check", "all", "--dry-run", "--json"]), 0)
        run.assert_not_called()
        selected.assert_not_called()
        self.assertFalse(json.loads(out.getvalue())["data"]["will_write"])

    def test_raw_asr_token_argument_is_refused_without_echo(self):
        for argv in [["asr", "configure", "--token", "never-echo-this"], ["asr", "configure", "--token=never-echo-this"]]:
            output = io.StringIO()
            with patch.object(cli.sys, "stdout", output):
                code = cli.main([*argv, "--json"])
            self.assertEqual(code, 2)
            self.assertNotIn("never-echo-this", output.getvalue())
            self.assertEqual(json.loads(output.getvalue())["error"]["code"], "invalid_arguments")

    def test_asr_status_and_verify_use_shared_adapter_without_mutation(self):
        with patch("tina_asr.validate_target") as target, patch("tina_asr.inspect", return_value={"ready": False, "asr_settings": [], "diagnostics": [{"name": "asr", "state": "unreachable"}]}):
            output = io.StringIO()
            with patch.object(cli.sys, "stdout", output):
                self.assertEqual(cli.main(["asr", "verify", "--json"]), 1)
            self.assertEqual(json.loads(output.getvalue())["error"]["code"], "asr_verification_failed")
            target.assert_called_once()


class TuiAndInstallTest(unittest.TestCase):
    def test_tui_asr_submenu_dispatches_existing_cli(self):
        data = {"project": "test", "docker_context": "test", "services": []}
        with patch.object(tui.curses, "wrapper", side_effect=[["asr"], ["asr", "status"], None]), patch("builtins.input", return_value=""), patch("builtins.print"):
            calls = []
            tui.run_tui(calls.append, lambda: data)
        self.assertEqual(calls, [["asr", "status", "--format", "table"]])
    def test_tui_repository_submenu_uses_the_same_dispatcher(self):
        data = {"project": "test", "docker_context": "test", "services": []}
        with patch.object(tui.curses, "wrapper", side_effect=[["check"], ["check", "contracts"], None]), patch("builtins.input", return_value=""), patch("builtins.print"):
            calls = []
            tui.run_tui(calls.append, lambda: data)
        self.assertEqual(calls, [["check", "contracts", "--format", "table"]])
        self.assertIn(("Full system check", ["doctor", "--full"]), tui.MENU)
    def test_terminal_colors_match_tina_and_support_plain_output(self):
        self.assertEqual(style.PALETTE["brand"], "#91D7BE")
        stream = Mock()
        stream.isatty.return_value = True
        with patch.dict(os.environ, {"TERM": "xterm-256color", "COLORTERM": "truecolor"}, clear=True):
            self.assertIn("38;2;145;215;190", style.paint("TINA", stream=stream))
            with patch.dict(os.environ, {"NO_COLOR": "1"}):
                self.assertEqual(style.paint("TINA", stream=stream), "TINA")
            stream.isatty.return_value = False
            self.assertEqual(style.paint("TINA", stream=stream), "TINA")

    def test_json_has_no_ansi_even_on_color_capable_terminal(self):
        output = io.StringIO()
        with patch.dict(os.environ, {"TERM": "xterm-256color"}), contextlib.redirect_stdout(output):
            cli.emit(True, {"message": "ready"}, None, True)
        self.assertNotIn("\033", output.getvalue())
        self.assertTrue(json.loads(output.getvalue())["ok"])

    def test_custom_curses_palette_is_restored_after_use(self):
        terminal = Mock(COLORS=256, A_BOLD=1, A_REVERSE=2)
        terminal.error = RuntimeError
        terminal.has_colors.return_value = terminal.can_change_color.return_value = True
        terminal.color_content.return_value = (10, 20, 30)
        terminal.color_pair.side_effect = lambda n: n << 8
        with patch.dict(os.environ, {}, clear=True):
            attrs, restore = style.curses_theme(terminal)
        self.assertNotEqual(attrs["selected"], 0)
        self.assertEqual(terminal.init_color.call_count, 6)
        self.assertEqual(terminal.init_pair.call_count, 5)
        restore()
        self.assertEqual(terminal.init_color.call_count, 12)
        self.assertTrue(all(call.args[1:] == (10, 20, 30) for call in terminal.init_color.call_args_list[-6:]))

    def test_monochrome_and_no_color_keep_selection_without_color_initialization(self):
        terminal = Mock(COLORS=8, A_BOLD=1, A_REVERSE=2)
        terminal.error = RuntimeError
        terminal.has_colors.return_value = False
        with patch.dict(os.environ, {}, clear=True):
            attrs, restore = style.curses_theme(terminal)
            self.assertEqual(attrs["selected"], 3)
            restore()
        terminal.start_color.assert_not_called()
        terminal.has_colors.return_value = True
        with patch.dict(os.environ, {"NO_COLOR": "1"}):
            attrs, restore = style.curses_theme(terminal)
            self.assertEqual(attrs["selected"], 3)
        terminal.init_pair.assert_not_called()

    def test_fixed_palette_terminals_use_256_or_basic_green(self):
        for count in (256, 8):
            with self.subTest(colors=count):
                terminal = Mock(COLORS=count, A_BOLD=1, A_REVERSE=2,
                                COLOR_BLACK=0, COLOR_GREEN=2, COLOR_WHITE=7)
                terminal.error = RuntimeError
                terminal.has_colors.return_value = True
                terminal.can_change_color.return_value = False
                terminal.color_pair.side_effect = lambda n: n << 8
                with patch.dict(os.environ, {}, clear=True):
                    attrs, restore = style.curses_theme(terminal)
                self.assertNotEqual(attrs["selected"], 0)
                self.assertEqual(terminal.init_pair.call_count, 5)
                terminal.init_color.assert_not_called()
                restore()
                if count == 8:
                    self.assertEqual(terminal.init_pair.call_args_list[3].args, (4, 0, 2))

    def test_english_menu_and_cancel_copy(self):
        self.assertEqual(tui.MENU[0][0], "Service status")
        self.assertEqual(tui.MENU[-1][0], "Stop stack")
        self.assertTrue(all(label.isascii() for label, _ in tui.MENU))
        self.assertTrue(all(value.isascii() for value in cli.IMPACTS.values()))

    def test_keyboard_wraparound_and_refresh_exit(self):
        self.assertEqual(tui.move(0, tui.curses.KEY_UP, 3), 2)
        self.assertEqual(tui.move(2, tui.curses.KEY_DOWN, 3), 0)
        class Screen:
            def __init__(self, key):
                self.key = key
            def getmaxyx(self):
                return (24, 100)
            def getch(self):
                return self.key
            def __getattr__(self, name):
                return lambda *args: None
        with patch.object(tui.curses, "curs_set"):
            self.assertIsNone(tui.draw(Screen(ord("q")), tui.MENU, "TINA", "test"))
            self.assertEqual(tui.draw(Screen(ord("r")), tui.MENU, "TINA", "test"), ["refresh"])

    def test_tui_dispatches_same_cli_and_cancel_never_executes(self):
        status = lambda: {"project": "test", "docker_context": "test", "services": []}
        with patch.object(tui.curses, "wrapper", side_effect=[["status"], None]), patch("builtins.input", return_value=""), patch("builtins.print"):
            calls = []
            self.assertEqual(tui.run_tui(calls.append, status), 0)
            self.assertEqual(calls, [["status", "--format", "table"]])
        with patch.object(tui.curses, "wrapper", return_value=None):
            calls = []
            tui.run_tui(calls.append, status)
            self.assertEqual(calls, [])

    def test_tui_restores_original_terminal_settings_even_on_error(self):
        with patch.object(tui.sys, "stdin") as stdin, patch("termios.tcgetattr", return_value=[1, 2]) as get, patch("termios.tcsetattr") as restore, patch.object(tui, "menu_loop", side_effect=KeyboardInterrupt):
            stdin.isatty.return_value = True
            stdin.fileno.return_value = 7
            with self.assertRaises(KeyboardInterrupt):
                tui.run_tui(None, None)
            get.assert_called_once_with(7)
            self.assertEqual(restore.call_args.args[0], 7)
            self.assertEqual(restore.call_args.args[2], [1, 2])

    def test_install_is_idempotent_preserves_other_executables_and_works_outside_repo(self):
        with tempfile.TemporaryDirectory() as td:
            directory = Path(td)
            target = installer.install(directory)
            self.assertEqual(installer.install(directory), target)
            result = subprocess.run([str(target), "--version"], cwd="/tmp", capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout.strip(), "tina " + cli.VERSION)
            target.unlink()
            target.write_text("keep me")
            with self.assertRaises(FileExistsError):
                installer.install(directory)
            self.assertEqual(target.read_text(), "keep me")


if __name__ == "__main__":
    unittest.main()
