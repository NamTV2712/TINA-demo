"""No live gate or deployment runs in these tests."""
import importlib.util
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch, Mock

BIN = Path(__file__).resolve().parent.parent / "bin"
spec = importlib.util.spec_from_file_location("checks_test", BIN / "tina_checks.py")
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


class ChecksTest(unittest.TestCase):
    def test_only_allowlisted_checks_and_no_mutating_gate(self):
        self.assertEqual(set(checks.CHECKS), {"cli", "graph", "dataflow", "contracts"})
        for command in checks.CHECKS.values():
            self.assertNotIn("seal-arch", command)
            self.assertNotIn("all", command)
            self.assertNotIn("docker", command)
        with self.assertRaises(ValueError):
            checks.run_checks("seal", str)

    def test_all_continues_after_failure_preserves_code_and_private_redacted_log(self):
        with tempfile.TemporaryDirectory() as td, patch.object(checks.Path, "home", return_value=Path(td)), patch.object(checks, "run_check", side_effect=[(0, "ok"), (17, "secret failure"), (0, "fine"), (0, "pass")]) as runner:
            result = checks.run_checks("all", lambda text: text.replace("secret", "[REDACTED]"))
            self.assertFalse(result["passed"])
            self.assertEqual(len(result["checks"]), 4)
            row = result["checks"][1]
            self.assertEqual(row["exit_code"], 17)
            self.assertEqual(row["failure_tail"], ["[REDACTED] failure"])
            path = Path(row["log_path"])
            self.assertEqual(path.stat().st_mode & 0o077, 0)
            self.assertEqual(path.parent.stat().st_mode & 0o077, 0)
            self.assertNotIn("secret", path.read_text())
            env = runner.call_args.args[1]
            self.assertEqual(env["npm_config_offline"], "true")
            self.assertEqual(env["PYTHONDONTWRITEBYTECODE"], "1")

    def test_missing_tool_returns_failed_result_with_actionable_log(self):
        with tempfile.TemporaryDirectory() as td, patch.object(checks.Path, "home", return_value=Path(td)), patch.object(checks, "run_check", side_effect=FileNotFoundError):
            result = checks.run_checks("cli", str)
            self.assertEqual(result["checks"][0]["exit_code"], 127)
            self.assertIn("uv", Path(result["checks"][0]["log_path"]).read_text())

    def test_timeout_stops_group_and_reports_exit_124(self):
        process = Mock()
        process.communicate.side_effect = [subprocess.TimeoutExpired("node", 300), ("partial output", None)]
        with patch.object(checks.subprocess, "Popen") as popen, patch.object(checks, "stop") as stop:
            popen.return_value.__enter__.return_value = process
            code, text = checks.run_check(["node", "gate"], {})
        self.assertEqual(code, 124)
        self.assertIn("timed out", text)
        stop.assert_called_once_with(process)

    def test_cancel_stops_child_group_and_propagates_interrupt(self):
        process = Mock()
        process.communicate.side_effect = KeyboardInterrupt
        with patch.object(checks.subprocess, "Popen") as popen, patch.object(checks, "stop") as stop:
            popen.return_value.__enter__.return_value = process
            with self.assertRaises(KeyboardInterrupt):
                checks.run_check(["node", "gate"], {})
        stop.assert_called_once_with(process)


if __name__ == "__main__":
    unittest.main()
