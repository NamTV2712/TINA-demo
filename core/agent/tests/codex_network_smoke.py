"""Real Codex sandbox proof; run explicitly inside an isolated worker image.

Bind this file read-only and use --tmpfs /tmp --tmpfs /work, the worker's normal
seccomp/no-new-privileges settings, and no production mounts or credentials.
The image must carry /etc/codex/requirements.toml. No model requests are made.
"""
from __future__ import annotations

import json
import os
import queue
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import ProxyHandler, build_opener

from llm.codex import CodexHarness


class Server:
    def __init__(self, work: Path, home: Path):
        self.messages = queue.Queue()
        self.sequence = 0
        self.proc = subprocess.Popen(
            CodexHarness()._argv(web_search="live", writable_roots=[str(work)]), cwd=work,
            env={"PATH": os.environ["PATH"], "HOME": str(home),
                 "CODEX_HOME": str(home), "OPENAI_API_KEY": "smoke-no-model"},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1,
        )
        threading.Thread(target=self._read, daemon=True).start()
        self.call("initialize", {
            "clientInfo": {"name": "tina-network-smoke", "version": "1"},
            "capabilities": {"experimentalApi": True},
        })

    def _read(self):
        for line in self.proc.stdout:
            self.messages.put(json.loads(line))
        self.messages.put(None)

    def call(self, method: str, params: dict):
        self.sequence += 1
        request_id = self.sequence
        self.proc.stdin.write(json.dumps({"id": request_id, "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            message = self.messages.get(timeout=max(0.01, deadline - time.monotonic()))
            assert message is not None, f"app-server exited during {method}"
            if message.get("id") == request_id:
                assert "error" not in message, f"app-server rejected {method}"
                return message.get("result") or {}
        raise AssertionError(f"app-server timed out during {method}")

    def command(self, work: Path, command: list[str], *, network=True, readonly=False):
        profile = "tina-readonly" if readonly else "tina-online" if network else "tina-offline"
        return self.call("command/exec", {
            "command": command, "cwd": str(work), "permissionProfile": profile, "timeoutMs": 30000,
        })

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5)


def check(server, work, name, code, **policy):
    result = server.command(work, ["python", "-c", code], **policy)
    assert result["exitCode"] == 0, name
    print(f"PASS {name}", flush=True)


def blocked_url(url):
    return f"""import urllib.request
try:
    urllib.request.urlopen({url!r}, timeout=5)
except OSError:
    pass
else:
    raise AssertionError('request escaped the network policy')
"""


def blocked_write(path):
    return f"""from pathlib import Path
try:
    Path({str(path)!r}).write_text('overwrite')
except OSError:
    pass
else:
    raise AssertionError('write escaped the filesystem policy')
"""


def main():
    os.environ["TINA_CODEX_AUTH_MODE"] = "api-key"
    with tempfile.TemporaryDirectory(prefix="codex-network-smoke-", dir="/work") as temporary:
        root = Path(temporary)
        work, home = root / "workspace", root / "home"
        work.mkdir()
        home.mkdir()
        # A repository/user config must not expand the administrator's managed allowlist.
        (home / "config.toml").write_text('''default_permissions = "smoke"
[permissions.tina-readonly.filesystem]
":root" = "read"
[permissions.tina-readonly.network]
enabled = false
[features]
network_proxy = true
[permissions.smoke.filesystem]
":root" = "read"
":workspace_roots" = "write"
[permissions.smoke.network]
enabled = true
[permissions.smoke.network.domains]
"*" = "allow"
''')
        outside, viewer = root / "outside.txt", root / "viewer" / "note.md"
        viewer.parent.mkdir()
        outside.write_text("keep")
        viewer.write_text("keep")
        subprocess.run(["git", "init", "-q", str(work)], check=True, capture_output=True)
        (work / ".codex").mkdir()
        (work / ".codex" / "config").write_text("keep")

        class LocalHandler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                self.send_response(200)
                self.end_headers()

        local = ThreadingHTTPServer(('0.0.0.0', 0), LocalHandler)
        threading.Thread(target=local.serve_forever, daemon=True).start()
        loopback_url = f'http://127.0.0.1:{local.server_port}'
        private_url = f'http://{socket.gethostbyname(socket.gethostname())}:{local.server_port}'
        for url in (loopback_url, private_url):
            with build_opener(ProxyHandler({})).open(url, timeout=3) as response:
                assert response.status == 200, 'local fixture is not reachable outside the sandbox'
        server = Server(work, home)
        try:
            network = server.call("configRequirements/read", {})["requirements"]["network"]
            assert network["enabled"] is None and network["managedAllowedDomainsOnly"] is True
            assert network["allowLocalBinding"] is False and network["allowUpstreamProxy"] is False
            assert {"github.com", "api.github.com"}.issubset(network["allowedDomains"])
            assert "example.com" not in network["allowedDomains"]
            print("PASS managed network requirements", flush=True)
            check(server, work, "allowed GitHub HTTPS", '''import urllib.request, urllib.error
try:
    response = urllib.request.urlopen('https://api.github.com', timeout=12)
    assert response.status == 200
except urllib.error.HTTPError as error:
    assert error.code in (403, 429) and error.headers.get('X-GitHub-Request-Id')
''')
            remote = server.command(work, [
                "git", "ls-remote", "https://github.com/octocat/Hello-World.git", "HEAD",
            ])
            assert remote["exitCode"] == 0 and remote["stdout"].strip().endswith("HEAD"), "Git HTTPS"
            print("PASS Git HTTPS remote read", flush=True)
            check(server, work, "unallowlisted domain and user wildcard denied", blocked_url("https://example.com"))
            check(server, work, "reachable loopback server denied", blocked_url(loopback_url))
            check(server, work, "reachable private server denied", blocked_url(private_url))
            check(server, work, "direct socket proxy bypass denied", '''import socket
try:
    connection = socket.create_connection(('1.1.1.1', 443), timeout=3)
except OSError:
    pass
else:
    connection.close()
    raise AssertionError('direct socket escaped the proxy')
''')
            check(server, work, "proxy environment removal denied", '''import os, urllib.request
for key in list(os.environ):
    if key.lower().endswith('_proxy'):
        del os.environ[key]
try:
    urllib.request.urlopen('https://api.github.com', timeout=5)
except OSError:
    pass
else:
    raise AssertionError('direct HTTPS escaped the proxy')
''')
            check(server, work, "network-disabled turn denied", blocked_url("https://api.github.com"), network=False)
            check(server, work, "workspace write allowed", "from pathlib import Path; Path('note.md').write_text('note')")
            check(server, work, "outside workspace write denied", blocked_write(outside))
            check(server, work, "viewer mount write denied", blocked_write(viewer))
            check(server, work, "read-only turn write denied", blocked_write(work / "note.md"), readonly=True)
            for folder in (".git", ".codex"):
                check(server, work, f"{folder} metadata write denied", blocked_write(work / folder / "config"))
            check(server, work, "provider credential excluded from shell", "import os; assert 'OPENAI_API_KEY' not in os.environ")
            assert outside.read_text() == viewer.read_text() == "keep"
        finally:
            server.close()
            local.shutdown()
            local.server_close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAIL {error if isinstance(error, AssertionError) else type(error).__name__}", flush=True)
        raise SystemExit(1)
