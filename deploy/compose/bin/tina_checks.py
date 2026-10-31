"""Allowlisted repository checks. Never invoke deployment or schema-sealing commands."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]
CHECKS = {
    "cli": ["uv", "run", "--frozen", "--offline", "--no-sync", "--project", "deploy/compose/tests",
            "pytest", "-p", "no:cacheprovider", "-q", "deploy/compose/tests/test_make_entrypoint.py",
            "deploy/compose/tests/test_tina_cli.py", "deploy/compose/tests/test_tina_checks.py",
            "deploy/compose/tests/test_tina_diagnostics.py", "deploy/compose/tests/test_tina_asr.py",
            "deploy/compose/tests/test_tina_setup.py",
            "deploy/compose/tests/probe_wiring_test.py",
            "deploy/compose/tests/flows_wiring_test.py"],
    "graph": ["node", "scripts/gates.mjs", "graph"],
    "dataflow": ["node", "scripts/gates.mjs", "dataflow"],
    "contracts": ["node", "scripts/gates.mjs", "contract-version"],
}


def stop(process):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def run_check(command, env):
    with subprocess.Popen(command, cwd=ROOT, env=env, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, text=True, start_new_session=True) as process:
        try:
            output, _ = process.communicate(timeout=300)
            return process.returncode, output
        except subprocess.TimeoutExpired:
            stop(process)
            output, _ = process.communicate()
            return 124, (output or "") + "\nCheck timed out after 300 seconds."
        except BaseException:
            stop(process)
            raise


def run_checks(name, clean):
    if name != "all" and name not in CHECKS:
        raise ValueError("Unknown repository check.")
    names = list(CHECKS) if name == "all" else [name]
    base = (Path.home() / "Library/Logs/TINA/checks" if sys.platform == "darwin"
            else Path.home() / ".local/state/tina/checks")
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory = Path(tempfile.mkdtemp(prefix=time.strftime("%Y%m%d-%H%M%S-"), dir=base))
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", UV_OFFLINE="1",
               npm_config_offline="true", npm_config_yes="false", NO_COLOR="1")
    # Do not let a prior Node/npm test setting alter which code the gate executes.
    env.pop("NODE_OPTIONS", None)
    results = []
    for check in names:
        print(f"Running {check}…", file=sys.stderr, flush=True)
        started = time.monotonic()
        try:
            code, output = run_check(CHECKS[check], env)
        except OSError:
            code, output = 127, f"Required tool unavailable: {CHECKS[check][0]}. Install the repo prerequisites."
        output = clean(output)
        path = directory / (check + ".log")
        with open(path, "x", opener=lambda p, flags: os.open(p, flags, 0o600)) as log:
            log.write(output)
        row = {"name": check, "status": "pass" if code == 0 else "fail", "exit_code": code,
               "duration_seconds": round(time.monotonic() - started, 2), "log_path": str(path)}
        if code:
            row["failure_tail"] = [line[:400] for line in output.splitlines()[-12:]]
        results.append(row)
        print(f"{check}: {row['status'].upper()} · {path}", file=sys.stderr, flush=True)
    return {"repository": str(ROOT), "passed": all(row["exit_code"] == 0 for row in results),
            "checks": results, "source_modified": False}
