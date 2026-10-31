"""Fresh local installation only; reuse Compose resolution and the existing deploy/ASR flows."""
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import sys
import tempfile

import stack


def prepare(project):
    if sys.version_info < (3, 10):
        raise stack.StackError("Python 3.10 or newer is required for the tina CLI.")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", project):
        raise stack.StackError("Use a project name of 1–63 lowercase letters, digits, underscores or hyphens.")
    path = Path(os.environ.get("ENV_FILE") or stack.HERE / ".env").expanduser()
    if not path.is_absolute():
        path = stack.HERE / path
    if path.exists() or path.is_symlink():
        raise stack.StackError("Configuration already exists; kept unchanged. Use tina doctor, tina deploy or tina asr configure with the same ENV_FILE. For a separate installation, select a new ENV_FILE and --project.")
    if not path.parent.is_dir():
        raise stack.StackError("ENV_FILE parent directory must already exist.")
    for tool in ("docker", "git", "bash", "openssl"):
        if not shutil.which(tool):
            raise stack.StackError(f"Missing {tool}. Install it first; on macOS, start OrbStack (or Docker Desktop) before retrying.")
    if os.environ.get("DOCKER_HOST"):
        raise stack.StackError("Use DOCKER_CONTEXT for setup; unset DOCKER_HOST to avoid an ambiguous daemon.")
    context = os.environ.get("DOCKER_CONTEXT") or stack.run(
        ["docker", "context", "show"], capture=True).stdout.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", context):
        raise stack.StackError("Cannot resolve a supported Docker context. Set DOCKER_CONTEXT explicitly.")
    endpoint = stack.run(["docker", "context", "inspect", context, "--format",
                          "{{.Endpoints.docker.Host}}"], capture=True).stdout.strip()
    if not endpoint.startswith("unix://"):
        raise stack.StackError("Setup supports a local Docker socket on macOS/Linux; remote daemons need an operator-managed deployment.")
    template = (stack.HERE / ".env.example").read_text()
    compose = (stack.HERE / "docker-compose.yml").read_text()
    # A fresh install must not inherit another deployment's ports, secrets or override chain.
    keys = set(re.findall(r"^([A-Z][A-Z0-9_]*)=", template, re.M))
    keys.update(re.findall(r"\$\{([A-Z][A-Z0-9_]*)", compose))
    keys.update({"PROJECT", "COMPOSE_PROJECT", "COMPOSE_FILE", "COMPOSE_PROFILES",
                 "COMPOSE_PATH_SEPARATOR", "COMPOSE_ENV_FILES", "BUILDX_BUILDER", "ALLOW_CONFIG_CHANGE"})
    env = {key: value for key, value in os.environ.items() if key not in keys}
    env.update(ENV_FILE=str(path), DOCKER_CONTEXT=context, PROJECT=project,
               COMPOSE_PROJECT_NAME=project, IMAGE_TAG=project, COMPOSE_PROFILES="",
               COMPOSE_FILE=str(stack.HERE / "docker-compose.yml"))
    selected = stack.Stack("plan", env=env)
    selected.preflight()
    guard_fresh(selected)
    return selected


def guard_fresh(selected):
    containers = stack.run(["docker", "ps", "-aq", "--filter",
                            "label=com.docker.compose.project=" + selected.project],
                           env=selected.env, capture=True).stdout.strip()
    if containers:
        raise stack.StackError("Project already has containers; choose a new --project. No resources were changed.")
    resources = [("volume", spec.get("name")) for spec in selected.config.get("volumes", {}).values()]
    resources += [("network", spec.get("name")) for spec in selected.config.get("networks", {}).values()]
    if any(spec.get("external") for spec in selected.config.get("volumes", {}).values()):
        raise stack.StackError("Fresh setup must not use imported/external volumes.")
    for kind, name in resources:
        if name and stack.run(["docker", kind, "inspect", name], env=selected.env,
                              capture=True, check=False).returncode == 0:
            raise stack.StackError(f"Project already has a {kind}; choose a new --project. Existing data was retained.")
    for spec in selected.services.values():
        for port in spec.get("ports", []):
            if not port.get("published"):
                continue
            host, number = port.get("host_ip") or "127.0.0.1", int(port["published"])
            if host != "127.0.0.1":
                raise stack.StackError("Fresh setup requires loopback-only published ports.")
            try:
                with socket.socket() as listener:
                    listener.bind((host, number))
            except OSError:
                raise stack.StackError(f"Port {number} is in use. Setup did not stop its owner or change any resources.") from None


def create(selected):
    guard_fresh(selected)
    values = {key: selected.env[key] for key in (
        "COMPOSE_PROJECT_NAME", "DOCKER_CONTEXT", "COMPOSE_FILE", "COMPOSE_PROFILES", "IMAGE_TAG")}
    for key in ("ADMIN_TOKEN", "INTERNAL_API_SECRET", "TINA_FLOWS_API_KEY", "TINA_FLOWS_TIMELINE_KEY",
                "TINA_DISPATCH_SIGNING_KEY", "NEXTAUTH_SECRET", "DB_PASSWORD", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY"):
        values[key] = secrets.token_hex(32)
    text = (stack.HERE / ".env.example").read_text()
    for key, value in values.items():
        line = key + "='" + value.replace("'", "\\'") + "'"
        if re.search(r"^" + key + "=", text, re.M):
            text = re.sub(r"^" + key + r"=.*$", lambda _: line, text, flags=re.M)
        else:
            text += "\n" + line + "\n"
    # Link a complete mode-0600 file atomically; never follow or overwrite a raced-in path.
    with tempfile.NamedTemporaryFile(mode="w", dir=selected.env_file.parent, prefix=".tina-setup-",
                                     encoding="utf-8") as temporary:
        temporary.write(text)
        temporary.flush()
        os.fsync(temporary.fileno())
        os.link(temporary.name, selected.env_file)
    resolved = stack.Stack("build", env=selected.env)
    resolved.preflight()
    guard_fresh(resolved)
    return resolved
