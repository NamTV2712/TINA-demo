"""Deployment regressions; no live stack is started or stopped by this suite."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("compose_entrypoint", ROOT / "deploy/compose/bin/stack.py")
stack = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stack)


def fixture():
    return {
        "name": "existing",
        "networks": {"tina": {"name": "existing_tina"}},
        "volumes": {"agent-workspaces": {"name": "existing_agent-workspaces"}},
        "services": {
            "runtime": {"build": {}, "environment": {
                "DOCKER_NETWORK": "existing_tina", "AGENT_WORKER_IMAGE": "worker:resolved",
                "BROWSER_IMAGE": "bot:resolved"}, "healthcheck": {"test": ["CMD", "true"]}},
            "agent-api": {"build": {}, "environment": {
                "TINA_WORKSPACE_MOUNT_SOURCE": "existing_agent-workspaces"},
                "volumes": [{"type": "volume", "source": "agent-workspaces", "target": "/workspaces"}]},
            "agent-worker": {"build": {"context": "."}, "image": "worker:resolved", "profiles": ["build-only"]},
            "admin-api": {"build": {"context": "."}, "environment": {"ADMIN_API_TOKEN": "private-fixture"},
                          "ports": [{"target": 8001, "published": "28057", "host_ip": "127.0.0.1"}]},
            "terminal": {"build": {"context": "."}, "ports": [{"target": 3000, "published": "23000"}]},
            "gateway": {"build": {"context": "."}, "ports": [{"target": 8000, "published": "28056"}]},
            "storage-init": {"entrypoint": ["true"]},
            "meeting-api": {"depends_on": {"storage-init": {"condition": "service_completed_successfully"}}},
        },
    }


class Docker:
    def __init__(self):
        self.config = fixture()
        self.calls = []
        self.rows = [{"Service": name, "State": "running", "Health": "healthy"}
                     for name in self.config["services"] if name not in {"agent-worker", "storage-init"}]
        self.rows.append({"Service": "storage-init", "State": "exited", "ExitCode": 0})
        self.containers = []
        self.fail_build = self.fail_up = self.fail_access = False
        self.missing = set()
        self.context = "fixture-docker"

    def __call__(self, args, *, env=None, capture=False, check=True):
        args = list(args)
        if len(args) > 1 and args[0] == "docker" and args[1].startswith("--context="):
            args = [args[0], *args[2:]]
        self.calls.append((args, dict(env or {})))
        code, out = 0, ""
        if args[:2] == ["docker", "compose"]:
            if "config" in args:
                out = "" if "--environment" in args else json.dumps(self.config)
            elif "build" in args:
                code = int(self.fail_build)
            elif "up" in args:
                code = int(self.fail_up)
            elif "ps" in args:
                out = json.dumps(self.rows)
        elif args[:2] == ["docker", "version"]:
            out = "27.0.0"
        elif args[:3] == ["docker", "context", "show"]:
            out = self.context
        elif args[:2] == ["docker", "ps"]:
            out = "existing-container" if self.containers else ""
        elif args[:2] == ["docker", "inspect"]:
            out = json.dumps(self.containers)
        elif args[:3] == ["docker", "image", "inspect"]:
            code = int(args[-1] in self.missing)
        elif args[0] == "git":
            out = "testsha"
        elif args[0].endswith("/provision-token"):
            code, out = (9, "") if self.fail_access else (0, "fixture-user-key")
        if check and code:
            raise stack.StackError("injected command failure")
        return subprocess.CompletedProcess(args, code, out, "")


class EntryPointTest(unittest.TestCase):
    def setUp(self):
        self.docker = Docker()
        for item in [patch.object(stack, "run", self.docker),
                     patch.dict(os.environ, {"ENV_FILE": str(ROOT / "deploy/compose/.env.example")}, clear=True),
                     patch.object(stack.time, "sleep")]:
            item.start()
            self.addCleanup(item.stop)

    def invoke(self, action):
        with patch.object(stack.sys, "argv", ["stack.py", action]), contextlib.redirect_stdout(io.StringIO()):
            stack.main()

    def test_build_failure_prevents_activation_and_provisioning(self):
        self.docker.fail_build = True
        with self.assertRaises(stack.StackError):
            self.invoke("all")
        self.assertFalse(any("up" in args or args[0].endswith("/provision-token")
                             for args, _ in self.docker.calls))

    def test_images_built_and_checked_before_waiting_for_activation(self):
        self.invoke("all")
        calls = [args for args, _ in self.docker.calls]
        build = next(i for i, args in enumerate(calls) if "build" in args and "agent-worker" in args)
        checks = [i for i, args in enumerate(calls) if args[:3] == ["docker", "image", "inspect"]]
        up = next(i for i, args in enumerate(calls) if "up" in args)
        access = next(i for i, args in enumerate(calls) if args[0].endswith("/provision-token"))
        self.assertLess(build, min(checks))
        self.assertLess(max(checks), up)
        self.assertLess(up, access)
        self.assertTrue({"--wait", "--wait-timeout", "--no-build", "--pull", "never"} <= set(calls[up]))

    def test_failed_wait_does_not_mint_key(self):
        self.docker.fail_up = True
        with self.assertRaises(stack.StackError):
            self.invoke("all")
        self.assertFalse(any(args[0].endswith("/provision-token") for args, _ in self.docker.calls))

    def test_final_unhealthy_service_fails_before_access(self):
        self.docker.rows[0]["Health"] = "unhealthy"
        with self.assertRaisesRegex(stack.StackError, "not ready"):
            self.invoke("all")
        self.assertFalse(any(args[0].endswith("/provision-token") for args, _ in self.docker.calls))

    def test_access_failure_propagates_and_uses_resolved_port(self):
        self.docker.fail_access = True
        with self.assertRaisesRegex(stack.StackError, "provisioning failed"):
            self.invoke("all")
        attempts = [env for args, env in self.docker.calls if args[0].endswith("/provision-token")]
        self.assertEqual(len(attempts), 3)
        self.assertTrue(all(env["ADMIN_API_URL"] == "http://127.0.0.1:28057" for env in attempts))

    def test_missing_worker_prevents_up(self):
        self.docker.missing.add("worker:resolved")
        with self.assertRaisesRegex(stack.StackError, "agent-worker"):
            self.invoke("all")
        self.assertFalse(any("up" in args for args, _ in self.docker.calls))

    def test_different_override_chain_blocks_mutation(self):
        self.docker.containers = [{"Config": {"Labels": {
            "com.docker.compose.project.config_files": "/existing/machine.yml"}}}]
        with self.assertRaisesRegex(stack.StackError, "override"):
            self.invoke("all")
        self.assertFalse(any("build" in args or "up" in args for args, _ in self.docker.calls))

    def test_matching_override_chain_is_allowed(self):
        selected = stack.Stack("all")
        self.docker.containers = [{"Config": {"Labels": {
            "com.docker.compose.project.config_files": ",".join(selected.files)}}}]
        selected.guard_existing_config()

    def test_explicit_config_change_is_available(self):
        self.docker.containers = [{"Config": {"Labels": {}}}]
        with patch.dict(os.environ, {"ALLOW_CONFIG_CHANGE": "1"}):
            stack.Stack("all").guard_existing_config()

    def test_profile_cannot_silently_omit_running_dashboard(self):
        selected = stack.Stack("all")
        self.docker.containers = [{"Config": {"Labels": {
            "com.docker.compose.project.config_files": ",".join(selected.files),
            "com.docker.compose.service": "dashboard"}}, "State": {"Running": True}}]
        with self.assertRaisesRegex(stack.StackError, "COMPOSE_PROFILES"):
            selected.guard_existing_config()

    def test_starting_healthcheck_is_not_accepted(self):
        self.docker.rows[0]["Health"] = "starting"
        with self.assertRaises(stack.StackError):
            stack.Stack("doctor").readiness()

    def test_oneshot_failure_and_missing_service_are_rejected(self):
        selected = stack.Stack("doctor")
        self.docker.rows[-1]["ExitCode"] = 2
        with self.assertRaisesRegex(stack.StackError, "storage-init"):
            selected.readiness()
        self.docker.rows = [row for row in self.docker.rows if row["Service"] != "terminal"]
        with self.assertRaisesRegex(stack.StackError, "terminal: missing"):
            selected.readiness()

    def test_running_worker_without_healthcheck_is_accepted(self):
        stack.Stack("doctor").readiness()

    def test_network_workspace_and_worker_mismatch_fail_closed(self):
        for field in ("DOCKER_NETWORK", "AGENT_WORKER_IMAGE"):
            with self.subTest(field=field):
                config = copy.deepcopy(self.docker.config)
                self.docker.config["services"]["runtime"]["environment"][field] = "wrong"
                with self.assertRaises(stack.StackError):
                    stack.Stack("plan").validate_bindings()
                self.docker.config = config
        self.docker.config["services"]["agent-api"]["environment"]["TINA_WORKSPACE_MOUNT_SOURCE"] = "wrong"
        with self.assertRaises(stack.StackError):
            stack.Stack("plan").validate_bindings()

    def test_plan_does_not_mutate_or_expose_secrets(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            stack.Stack("plan").plan()
        self.assertNotIn("private-fixture", out.getvalue())
        self.assertFalse(any("up" in args or "build" in args for args, _ in self.docker.calls))

    def test_infrastructure_pull_failure_prevents_activation(self):
        original = self.docker.__call__
        def fail_pull(args, **kwargs):
            if "pull" in args:
                raise stack.StackError("injected infrastructure pull failure")
            return original(args, **kwargs)
        with patch.object(stack, "run", fail_pull), self.assertRaisesRegex(stack.StackError, "infrastructure"):
            self.invoke("all")
        self.assertFalse(any("up" in args for args, _ in self.docker.calls))

    def test_destroy_requires_explicit_opt_in(self):
        with self.assertRaisesRegex(stack.StackError, "DESTROY"):
            self.invoke("destroy")
        self.assertFalse(any("down" in args for args, _ in self.docker.calls))

    def test_down_never_removes_volumes(self):
        self.invoke("down")
        down = next(args for args, _ in self.docker.calls if "down" in args)
        self.assertNotIn("-v", down)

    def test_global_context_switch_does_not_move_builds_or_checks_to_another_daemon(self):
        selected = stack.Stack("all")
        self.assertIn("--context=fixture-docker", selected.base)
        self.docker.context = "another-daemon"
        selected.preflight()
        selected.build()
        for args, env in self.docker.calls:
            if args[:2] == ["docker", "build"] or args[:3] == ["docker", "image", "inspect"]:
                self.assertEqual(env["DOCKER_CONTEXT"], "fixture-docker")
                self.assertNotIn("BUILDX_BUILDER", env)

    def test_remote_builder_override_is_refused_before_build(self):
        with patch.dict(os.environ, {"BUILDX_BUILDER": "another-daemon"}):
            with self.assertRaisesRegex(stack.StackError, "BUILDX_BUILDER"):
                self.invoke("all")
        self.assertFalse(any(args[:2] == ["docker", "build"] for args, _ in self.docker.calls))

    def test_both_services_reject_published_admin_placeholder(self):
        for path, key in [
            ("core/identity/services/admin-api/src/admin_api/config.v1.json", "ADMIN_API_TOKEN"),
            ("core/meetings/services/meeting-api/src/meeting_api/config.v1.json", "ADMIN_TOKEN"),
        ]:
            declaration = json.loads((ROOT / path).read_text())
            entry = next(item for item in declaration["keys"] if item["key"] == key)
            self.assertIn("dev-admin-token", entry["forbidden_values"])
        self.docker.config["services"]["admin-api"]["environment"]["ADMIN_API_TOKEN"] = "dev-admin-token"
        with self.assertRaises(stack.StackError):
            self.invoke("all")


class BootstrapTest(unittest.TestCase):
    def test_fresh_secrets_are_private_unique_and_idempotent(self):
        script = ROOT / "deploy/compose/mint-dev-env.sh"
        with tempfile.TemporaryDirectory() as td:
            files = [Path(td) / name for name in ("first.env", "second.env")]
            for file in files:
                subprocess.run(["bash", str(script), str(file)], capture_output=True, check=True)
            def admin(file):
                return next(line.split("=", 1)[1] for line in file.read_text().splitlines()
                            if line.startswith("ADMIN_TOKEN="))
            first = files[0].read_bytes()
            self.assertEqual(len(admin(files[0])), 64)
            self.assertNotEqual(admin(files[0]), admin(files[1]))
            self.assertEqual(files[0].stat().st_mode & 0o077, 0)
            subprocess.run(["bash", str(script), str(files[0])], capture_output=True, check=True)
            self.assertEqual(first, files[0].read_bytes())

    def test_existing_placeholder_refused_without_rotating_any_secret(self):
        with tempfile.TemporaryDirectory() as td:
            file = Path(td) / ".env"
            for value in ("dev-admin-token", "'dev-admin-token'", '"dev-admin-token"'):
                original = f"ADMIN_TOKEN={value}\nINTERNAL_API_SECRET=\n"
                file.write_text(original)
                result = subprocess.run(["bash", str(ROOT / "deploy/compose/mint-dev-env.sh"), str(file)],
                                        capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(file.read_text(), original)
                self.assertNotIn(value, result.stderr)

    def test_existing_nonempty_credential_is_preserved(self):
        with tempfile.TemporaryDirectory() as td:
            file = Path(td) / ".env"
            # A leading # without preceding whitespace is a dotenv value, not an empty assignment.
            for value in ("private-existing-credential", "#private-existing-credential"):
                file.write_text("ADMIN_TOKEN=" + value + "\n")
                subprocess.run(["bash", str(ROOT / "deploy/compose/mint-dev-env.sh"), str(file)],
                               capture_output=True, check=True)
                self.assertTrue(file.read_text().startswith("ADMIN_TOKEN=" + value + "\n"))

    def test_dry_run_never_executes_docker_or_bootstrap(self):
        with tempfile.TemporaryDirectory() as td:
            marker = Path(td) / "called"
            docker = Path(td) / "docker"
            docker.write_text(f"#!/bin/sh\ntouch {shlex.quote(str(marker))}\nexit 97\n")
            docker.chmod(0o755)
            env = dict(os.environ, PATH=td + os.pathsep + os.environ["PATH"])
            for target in ("all", "build", "down", "bot", "doctor"):
                result = subprocess.run(["make", "-n", target], cwd=ROOT, env=env, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(marker.exists(), target)


@unittest.skipUnless(shutil.which("dotenvx"), "Dotenvx CLI required")
class DotenvxEnvTest(unittest.TestCase):
    @staticmethod
    def values(text):
        result = {}
        for line in text.splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                result[key] = value.strip().strip("\"'")
        return result

    def test_encrypted_compose_env_is_materialized_private_without_changing_source(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source, key_file = root / ".env", root / ".env.keys"
            source.write_text("TEST_VALUE=round-trip\n")
            subprocess.run(["dotenvx", "encrypt", "-f", str(source), "-fk", str(key_file)],
                           capture_output=True, check=True)
            encrypted = source.read_text()

            decrypted, temporary = stack._dotenvx_env_source(
                source, dict(os.environ, DOTENVX_KEY_FILE=str(key_file)))
            try:
                values = {}
                for line in decrypted.read_text().splitlines():
                    if "=" in line and not line.lstrip().startswith("#"):
                        key, value = line.split("=", 1)
                        values[key] = value.strip().strip("\"'")
                self.assertEqual(values["TEST_VALUE"], "round-trip")
                self.assertEqual(decrypted.stat().st_mode & 0o077, 0)
                self.assertEqual(source.read_text(), encrypted)
            finally:
                temporary.cleanup()

    def test_bootstrap_keeps_generated_secrets_encrypted(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            env_file, key_file = root / ".env", root / ".env.keys"
            env_file.write_text("ADMIN_TOKEN=\nINTERNAL_API_SECRET=\nTINA_FLOWS_API_KEY=\nTINA_FLOWS_TIMELINE_KEY=\n")
            subprocess.run(["dotenvx", "encrypt", "-f", str(env_file), "-fk", str(key_file)],
                           capture_output=True, check=True)
            subprocess.run(["bash", str(ROOT / "deploy/compose/mint-dev-env.sh"), str(env_file)],
                           env=dict(os.environ, DOTENVX_KEY_FILE=str(key_file)),
                           capture_output=True, check=True, text=True)

            encrypted = env_file.read_text()
            self.assertTrue(all(f"{key}=encrypted:" in encrypted for key in (
                "ADMIN_TOKEN", "INTERNAL_API_SECRET", "TINA_FLOWS_API_KEY", "TINA_FLOWS_TIMELINE_KEY")))
            decrypted = subprocess.run(["dotenvx", "decrypt", "--stdout", "-f", str(env_file), "-fk", str(key_file)],
                                       capture_output=True, check=True, text=True).stdout
            values = self.values(decrypted)
            self.assertTrue(all(len(values[key]) == 64 for key in (
                "ADMIN_TOKEN", "INTERNAL_API_SECRET", "TINA_FLOWS_API_KEY", "TINA_FLOWS_TIMELINE_KEY")))

@unittest.skipUnless(shutil.which("docker"), "Compose CLI required; daemon not needed")
class ComposeConfigTest(unittest.TestCase):
    def test_real_compose_resolves_project_profiles_override_and_image_variables(self):
        with tempfile.TemporaryDirectory() as td:
            directory = Path(td)
            overlay = directory / "machine override.yml"
            overlay.write_text("services:\n  terminal:\n    environment:\n      REVIEW_MARKER: present\n")
            env_file = directory / "chosen.env"
            env_file.write_text(
                "COMPOSE_PROJECT_NAME=custom-from-dotenv\nIMAGE_TAG=fixture\nADMIN_TOKEN=private-config-fixture\n"
                "BROWSER_IMAGE=tina/tina-bot:${IMAGE_TAG}\nCOMPOSE_PROFILES=dashboard\n"
                f"COMPOSE_FILE={ROOT / 'deploy/compose/docker-compose.yml'}:{overlay}\n")
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith(("COMPOSE_", "PROJECT", "IMAGE_TAG", "BROWSER_IMAGE", "ENV_FILE"))}
            env["ENV_FILE"] = str(env_file)
            with patch.dict(os.environ, env, clear=True):
                selected = stack.Stack("plan")
                selected.validate_bindings()
                self.assertEqual(selected.project, "custom-from-dotenv")
                self.assertEqual(selected.images()["bot"], "tina/tina-bot:dev")
                self.assertTrue("dashboard" in selected.services, "dotenv dashboard profile was ignored")
                self.assertEqual(selected.files[-1], str(overlay.resolve()))
                self.assertTrue(selected.services["runtime"]["environment"].get("ADMIN_TOKEN") == "private-config-fixture",
                                "runtime read a different dotenv file")
                self.assertEqual(selected.services["terminal"]["environment"]["REVIEW_MARKER"], "present")
                with patch.dict(os.environ, {"PROJECT": "explicit-project", "IMAGE_TAG": "chosen"}):
                    explicit = stack.Stack("plan")
                    explicit.validate_bindings()
                    self.assertEqual(explicit.project, "explicit-project")
                    self.assertEqual(explicit.images()["bot"], "tina/tina-bot:chosen")
            self.assertIn("IMAGE_TAG=fixture", env_file.read_text())


if __name__ == "__main__":
    unittest.main()
