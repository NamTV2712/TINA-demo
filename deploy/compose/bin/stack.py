#!/usr/bin/env python3
"""Source-build entrypoint. Compose owns dotenv/interpolation; never source/eval .env."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent.parent
ROOT = HERE.parent.parent
SOURCE_ACTIONS = {"all", "build", "bot", "plan"}


class StackError(RuntimeError):
    pass


def run(args, *, env=None, capture=False, check=True):
    result = subprocess.run(args, cwd=HERE, env=env, text=True,
                            capture_output=capture, check=False)
    if check and result.returncode:
        # Config/env output may contain credentials; never include it in an exception.
        raise StackError(f"Command failed ({result.returncode}): {shlex.join(args)}")
    return result


def _dotenvx_env_source(path: Path, env: dict[str, str]) -> tuple[Path, tempfile.TemporaryDirectory | None]:
    encrypted = any(
        line.partition("=")[2].strip().strip("\"'").startswith("encrypted:")
        for line in path.read_text().splitlines()
        if "=" in line and not line.lstrip().startswith("#")
    )
    if not encrypted:
        return path, None

    dotenvx = env.get("DOTENVX_BIN") or shutil.which("dotenvx")
    if not dotenvx:
        raise StackError("This env file is Dotenvx-encrypted; install dotenvx and provide its private key.")
    explicit_key = env.get("DOTENVX_KEY_FILE")
    explicit_path = Path(explicit_key).expanduser() if explicit_key else None
    if explicit_path and not explicit_path.is_absolute():
        explicit_path = ROOT / explicit_path
    key_file = explicit_path if explicit_path else next(
        (candidate for candidate in (path.parent / ".env.keys", ROOT / ".env.keys") if candidate.is_file()),
        None,
    )
    if explicit_key and not key_file.is_file():
        raise StackError("DOTENVX_KEY_FILE does not exist; no encrypted env values were read.")
    command = [dotenvx, "decrypt", "--stdout", "-f", str(path)]
    if key_file:
        command += ["-fk", str(key_file)]
    try:
        plaintext = run(command, env=env, capture=True).stdout
    except StackError:
        raise StackError("Dotenvx could not decrypt the selected env file; check its matching private key.") from None

    # Compose's service env_file reader cannot decrypt Dotenvx values itself.
    temporary = tempfile.TemporaryDirectory(prefix="tina-dotenvx-")
    decrypted = Path(temporary.name) / path.name
    decrypted.write_text(plaintext, encoding="utf-8")
    decrypted.chmod(0o600)
    return decrypted, temporary


def json_rows(text):
    if not text.strip():
        return []
    if text.lstrip().startswith("["):
        return json.loads(text)
    return [json.loads(line) for line in text.splitlines() if line.strip()]


class Stack:
    def __init__(self, action, *, env=None):
        self.env = dict(os.environ if env is None else env)
        if action in SOURCE_ACTIONS:
            self.env.setdefault("IMAGE_TAG", "dev")
        self.env_file = Path(self.env.get("ENV_FILE") or ".env")
        if not self.env_file.is_absolute():
            self.env_file = HERE / self.env_file
        # plan/doctor must not create a file. A fresh-install preview reads the template.
        source = self.env_file if self.env_file.exists() else HERE / ".env.example"
        self._dotenvx_temp = None
        compose_env_file, self._dotenvx_temp = _dotenvx_env_source(source, self.env)
        self.env["TINA_COMPOSE_ENV_FILE"] = str(compose_env_file)
        project = self.env.get("PROJECT") or self.env.get("COMPOSE_PROJECT")
        if project:
            self.env["COMPOSE_PROJECT_NAME"] = project
        base = ["docker", "compose", "--project-directory", str(HERE),
                "--env-file", str(compose_env_file)]
        interpolation = run([*base, "config", "--environment"], env=self.env, capture=True)
        values = dict(line.split("=", 1) for line in interpolation.stdout.splitlines() if "=" in line)
        # Global Docker context may change while a long build runs. Pin it once,
        # including Buildx, so builds, image checks and activation use one daemon.
        if not self.env.get("DOCKER_CONTEXT") and not self.env.get("DOCKER_HOST"):
            self.env["DOCKER_CONTEXT"] = values.get("DOCKER_CONTEXT") or run(
                ["docker", "context", "show"], env=self.env, capture=True).stdout.strip()
        self.context = self.env.get("DOCKER_CONTEXT") or "default"
        if not self.context:
            raise StackError("Cannot resolve Docker context.")
        self.builder = self.env.pop("BUILDX_BUILDER", None) or self.context
        # Compose's Buildx subprocess also needs the global flag; environment-only
        # context selection can leave Bake on the globally selected daemon.
        if self.env.get("DOCKER_CONTEXT"):
            base = ["docker", "--context=" + self.context, *base[1:]]
        # Explicit --profile replaces COMPOSE_PROFILES in some Compose versions.
        # Carry selected profiles explicitly before adding build-only for config inspection.
        for profile in values.get("COMPOSE_PROFILES", "").split(","):
            if profile.strip() and profile.strip() != "build-only":
                base += ["--profile", profile.strip()]
        separator = values.get("COMPOSE_PATH_SEPARATOR") or os.pathsep
        if values.get("COMPOSE_FILE"):
            files = values["COMPOSE_FILE"].split(separator)
        else:
            files = ["docker-compose.yml"]
            if (HERE / "docker-compose.override.yml").exists():
                files.append("docker-compose.override.yml")
        self.files = [str((HERE / file).resolve()) for file in files]
        # Pin the selected chain, including its project directory, on every subsequent command.
        self.base = base
        for file in self.files:
            self.base += ["-f", file]
        initial = self.compose("--profile", "build-only", "config", "--format", "json", capture=True)
        self.config = json.loads(initial.stdout)
        self.project = self.config["name"]
        self.env["COMPOSE_PROJECT_NAME"] = self.project
        self.base += ["-p", self.project]
        # Re-resolve after pinning: internal network/workspace names must follow the same project.
        self.config = json.loads(self.compose("--profile", "build-only", "config",
                                             "--format", "json", capture=True).stdout)
        self.services = {name: spec for name, spec in self.config["services"].items()
                         if "build-only" not in spec.get("profiles", [])}
        self.runtime = self.services["runtime"].get("environment", {})

    def compose(self, *args, capture=False, check=True):
        return run([*self.base, *args], env=self.env, capture=capture, check=check)

    def validate_bindings(self):
        expected = self.config["networks"]["tina"]["name"]
        if self.runtime.get("DOCKER_NETWORK") != expected:
            raise StackError("Runtime DOCKER_NETWORK differs from the selected Compose network.")
        api = self.services["agent-api"]
        for mount in api.get("volumes", []):
            if mount["target"] == "/workspaces" and mount["type"] == "volume":
                expected = self.config["volumes"][mount["source"]]["name"]
                actual = api.get("environment", {}).get("TINA_WORKSPACE_MOUNT_SOURCE")
                if actual != expected:
                    raise StackError("Agent workspace backing differs from the selected Compose volume.")
        worker = self.config["services"]["agent-worker"]["image"]
        if worker != self.runtime.get("AGENT_WORKER_IMAGE"):
            raise StackError("Agent worker build image differs from Runtime AGENT_WORKER_IMAGE.")

    def guard_existing_config(self):
        ids = run(["docker", "ps", "-aq", "--filter",
                   f"label=com.docker.compose.project={self.project}"],
                  env=self.env, capture=True).stdout.split()
        if not ids:
            return
        containers = json.loads(run(["docker", "inspect", *ids], env=self.env, capture=True).stdout)
        chains = {tuple(str(Path(file).resolve()) for file in
                        item["Config"]["Labels"].get("com.docker.compose.project.config_files", "").split(",")
                        if file)
                  for item in containers}
        if chains != {tuple(self.files)} and self.env.get("ALLOW_CONFIG_CHANGE") != "1":
            raise StackError(
                "Selected Compose files differ from the existing deployment. Preserve its override "
                "chain with COMPOSE_FILE, or set ALLOW_CONFIG_CHANGE=1 for an intentional configuration "
                "change. No containers were changed.")
        excluded = {item["Config"]["Labels"].get("com.docker.compose.service") for item in containers
                    if item.get("State", {}).get("Running")}
        excluded -= set(self.services) | {"agent-worker", None}
        if excluded and self.env.get("ALLOW_CONFIG_CHANGE") != "1":
            raise StackError("Running services excluded by selected profiles: " + ", ".join(sorted(excluded))
                             + ". Preserve COMPOSE_PROFILES or explicitly set ALLOW_CONFIG_CHANGE=1.")

    def preflight(self):
        version = run(["docker", "version", "--format", "{{.Server.Version}}"],
                      env=self.env, capture=True).stdout.strip().lstrip("v")
        if not version or not version.split(".")[0].isdigit() or int(version.split(".")[0]) < 26:
            raise StackError("Docker engine >=26 is required for workspace volume subpaths.")
        self.validate_bindings()

    def validate_admin(self):
        token = self.services["admin-api"].get("environment", {}).get("ADMIN_API_TOKEN", "")
        # Keep the deployment entrypoint aligned with the actual service declaration.
        declaration = json.loads((ROOT / "core/identity/services/admin-api/src/admin_api/config.v1.json").read_text())
        entry = next(key for key in declaration["keys"] if key["key"] == "ADMIN_API_TOKEN")
        if not token.strip() or token.strip() in entry.get("forbidden_values", []):
            raise StackError("ADMIN_TOKEN is missing or a published placeholder; configure a private secret.")
        return token

    def images(self):
        return {"bot": self.runtime["BROWSER_IMAGE"],
                "agent-worker": self.runtime["AGENT_WORKER_IMAGE"]}

    def check_images(self, *, bot_only=False):
        missing = []
        images = self.images()
        if not bot_only:
            images.update({name: spec["image"] for name, spec in self.services.items() if spec.get("image")})
        for name, image in images.items():
            if bot_only and name != "bot":
                continue
            if run(["docker", "image", "inspect", image], env=self.env, capture=True, check=False).returncode:
                missing.append(f"{name} ({image})")
        if missing:
            raise StackError("Required images missing: " + ", ".join(missing))

    def build_bot(self):
        if self.builder != self.context:
            raise StackError("BUILDX_BUILDER must match the selected Docker context for local source builds.")
        image = self.images()["bot"]
        requested = self.env.get("BOT_IMAGE")
        if requested and requested != image:
            raise StackError("BOT_IMAGE differs from resolved BROWSER_IMAGE; configure the latter instead.")
        run(["docker", "build", "-f", str(ROOT / "core/meetings/modules/join/Dockerfile.env"),
             "-t", "tina/meet-join-env:dev", str(ROOT / "core/meetings/modules/join")], env=self.env)
        sha = run(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"],
                  capture=True, check=False).stdout.strip() or "unknown"
        run(["docker", "build", "-t", image, "--build-arg", f"TINA_IMAGE_VERSION={sha}",
             "-f", str(ROOT / "core/meetings/services/bot/Dockerfile"), str(ROOT)], env=self.env)

    def build(self):
        # Build-only workers and ALL enabled service images precede any up/recreate.
        self.build_bot()
        names = [name for name, spec in self.services.items() if spec.get("build")]
        self.compose("build", *names, "agent-worker")
        # Fresh hosts also need registry-provided infrastructure images before up.
        self.compose("pull", "--ignore-buildable")
        self.check_images()

    def readiness(self, services=None):
        rows = json_rows(self.compose("ps", "-a", "--format", "json", capture=True).stdout)
        completed = {name for spec in self.services.values()
                     for name, dep in spec.get("depends_on", {}).items()
                     if dep.get("condition") == "service_completed_successfully"}
        failures = []
        for name, spec in self.services.items():
            if services is not None and name not in services:
                continue
            instances = [row for row in rows if row.get("Service") == name]
            if not instances:
                failures.append(f"{name}: missing")
                continue
            for row in instances:
                state = row.get("State", "")
                if name in completed:
                    ok = state == "exited" and row.get("ExitCode") == 0
                else:
                    ok = state == "running"
                    if spec.get("healthcheck") and not spec["healthcheck"].get("disable"):
                        ok = ok and row.get("Health") == "healthy"
                if not ok:
                    failures.append(f"{name}: {state}/{row.get('Health') or row.get('ExitCode', '')}")
        if failures:
            raise StackError("Services not ready: " + ", ".join(failures))

    def endpoint(self, service, target):
        for port in self.services[service].get("ports", []):
            if int(port["target"]) == target and port.get("published"):
                host = port.get("host_ip") or "127.0.0.1"
                if host in ("0.0.0.0", "::"):
                    host = "127.0.0.1"
                if ":" in host:
                    host = f"[{host}]"
                return f"http://{host}:{port['published']}"
        raise StackError(f"No published port for {service}:{target}.")

    def provision_key(self, email=None):
        env = dict(self.env, ADMIN_TOKEN=self.validate_admin(),
                   ADMIN_API_URL=self.endpoint("admin-api", 8001),
                   EMAIL=email or self.env.get("EMAIL", "self-host@tina.test"),
                   SCOPES=self.env.get("SCOPES", "bot,tx"))
        for attempt in range(3):
            result = run([str(HERE / "bin/provision-token")], env=env, capture=True, check=False)
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()
            if attempt < 2:
                time.sleep(1)
        raise StackError("API key provisioning failed; the deployment is not verified. Check admin-api.")

    def capabilities(self):
        stt = self.services["meeting-api"].get("environment", {})
        state = "endpoint configured" if stt.get("TRANSCRIPTION_SERVICE_URL") else "no deployment endpoint"
        print(f"STT: {state}; effective user/global backends must be tested in Settings → Models.")
        print("Agent: user model/subscription credentials are checked in Settings → Models.")
        print("Host services: Desktop, native Capture, extension, ASR, diarization and alignment are managed separately.")

    def plan_data(self):
        self.validate_bindings()
        return {"project": self.project, "docker_context": self.context,
                          "env_file": str(self.env_file),
                          "compose_files": self.files, "services": list(self.services),
                          "images": self.images(),
                          "volumes": {key: value.get("name") for key, value in self.config.get("volumes", {}).items()},
                          "order": ["bootstrap", "preflight", "build bot/services/worker",
                                    "check images", "up --no-build --pull never --wait",
                                    "check readiness", "provision access"]}

    def plan(self):
        print(json.dumps(self.plan_data(), indent=2))
        self.capabilities()

    def activate(self):
        self.compose("up", "-d", "--no-build", "--pull", "never", "--wait",
                     "--wait-timeout", self.env.get("WAIT_TIMEOUT", "180"))
        self.readiness()

    def access(self):
        key = self.provision_key()
        print(f"Terminal UI: {self.endpoint('terminal', 3000)}")
        print(f"API gateway: {self.endpoint('gateway', 8000)}")
        if "dashboard" in self.services:
            print(f"Dashboard: {self.endpoint('dashboard', 3000)}")
        print(f"API key: {key}")

    def probe(self):
        env = dict(self.env)
        env.setdefault("GATEWAY_URL", self.endpoint("gateway", 8000))
        if not env.get("TINA_API_KEY"):
            env["TINA_API_KEY"] = self.provision_key("probe@example.test")
        env.setdefault("PROBE_MODE", "mock" if "mock" in self.images()["bot"] else "real")
        env["PROBE_SWEEP_CMD"] = shlex.join([*self.base, "logs", "--tail=40"])
        # One scoped sweep; do not gather unrelated deployments' bot logs.
        env["PROBE_SWEEP_CMD"] += (
            "\nfor c in $(docker ps -aq --filter "
            + shlex.quote("network=" + self.config["networks"]["tina"]["name"])
            + " --filter name=tina-mtg | head -3); do docker logs --tail=30 \"$c\"; done")
        run(["bash", str(ROOT / "scripts/probe/journey.sh")], env=env)


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "plan"
    if action in {"all", "build"}:
        run(["bash", str(HERE / "mint-dev-env.sh"), os.environ.get("ENV_FILE") or ".env"])
    stack = Stack(action)
    if action == "plan":
        stack.plan()
    elif action in {"all", "build", "bot"}:
        stack.preflight()
        stack.guard_existing_config()
        if action == "bot":
            stack.build_bot()
            stack.check_images(bot_only=True)
            return
        stack.validate_admin()
        stack.build()
        if action == "all":
            try:
                stack.activate()
                stack.access()
            except StackError:
                print("Deployment incomplete; inspect make ps/logs. Existing data volumes were retained.", file=sys.stderr)
                raise
            stack.capabilities()
            print(f"TINA Compose ready: {stack.project}")
    elif action == "doctor":
        stack.preflight()
        stack.guard_existing_config()
        stack.check_images()
        stack.readiness()
        stack.capabilities()
        print(f"Compose services ready: {stack.project}; audio/AI acceptance not exercised.")
    elif action == "access":
        stack.access()
    elif action == "token":
        print(stack.provision_key())
    elif action == "check-images":
        stack.check_images(bot_only=True)
    elif action == "preflight":
        stack.preflight()
    elif action == "capabilities":
        stack.capabilities()
    elif action == "project":
        print(stack.project)
    elif action == "probe":
        stack.guard_existing_config()
        stack.probe()
    elif action in {"down", "destroy"}:
        stack.validate_bindings()
        stack.guard_existing_config()
        if action == "destroy" and stack.env.get("DESTROY") != "yes":
            raise StackError("Refusing to delete volumes. Explicitly set DESTROY=yes.")
        stack.compose("down", *(["-v"] if action == "destroy" else []), "--remove-orphans")
    elif action in {"ps", "logs", "compose"}:
        args = {"ps": ["ps"], "logs": ["logs", "-f"]}.get(action, sys.argv[2:])
        if action == "compose" and args and args[0] in {"up", "down", "build", "run"}:
            stack.validate_bindings()
            stack.guard_existing_config()
        stack.compose(*args)
    else:
        raise StackError(f"Unknown stack action: {action}")


if __name__ == "__main__":
    try:
        main()
    except (StackError, KeyError, ValueError, OSError) as error:
        print(f"✗ {error}", file=sys.stderr)
        sys.exit(1)
