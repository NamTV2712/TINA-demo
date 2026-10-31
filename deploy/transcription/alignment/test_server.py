import hashlib
import io
import json
import os
import signal
import subprocess
import sys
import wave
from pathlib import Path
from types import SimpleNamespace

import pytest

import server
from server import model_id, parse_alignment


def test_oov_phone_is_unaligned_and_raw_token_surface_is_preserved(tmp_path, monkeypatch):
    dictionary = tmp_path / "vi.dict"
    acoustic = tmp_path / "vi.zip"
    dictionary.write_bytes(b"dictionary")
    acoustic.write_bytes(b"acoustic")
    monkeypatch.setenv("MFA_DICTIONARY", str(dictionary))
    monkeypatch.setenv("MFA_ACOUSTIC_MODEL", str(acoustic))
    model_id.cache_clear()
    audio, text = b"audio", "Sau hormone,"
    result = parse_alignment({"tiers": {
        "words": {"entries": [[0, .4, "sau"], [.4, 1, "hormone"]]},
        "phones": {"entries": [[0, .4, "s"], [.4, 1, "spn"]]},
    }}, text, 1000, audio)
    assert [w["text"] for w in result["words"]] == ["Sau", "hormone,"]
    assert result["words"][0]["aligned"] is True
    assert result["words"][1]["aligned"] is False
    assert result["words"][1]["start_ms"] is None
    assert result["audio_sha256"] == hashlib.sha256(audio).hexdigest()
    model_id.cache_clear()


@pytest.mark.parametrize("return_code", [0, 1])
def test_align_many_removes_request_cache_after_success_or_failure(tmp_path, monkeypatch, return_code):
    mfa_root = tmp_path / "mfa-root"
    mfa_root.mkdir()
    dictionary, acoustic = tmp_path / "vi.dict", tmp_path / "vi.zip"
    dictionary.write_bytes(b"dictionary")
    acoustic.write_bytes(b"acoustic")
    cfg = {"conda": "conda", "prefix": "env", "root": str(mfa_root),
           "dictionary": str(dictionary), "acoustic": str(acoustic)}
    monkeypatch.setattr(server, "settings", lambda: cfg)

    def run(command, **kwargs):
        corpus, output = Path(command[7]), Path(command[10])
        cache = mfa_root / corpus.name
        cache.mkdir()
        (cache / "cache.db").write_bytes(b"temporary")
        if not return_code:
            output.mkdir()
            (output / "segment-000.json").write_text(json.dumps({"tiers": {
                "words": {"entries": [[0, 0.5, "hello"]]},
            }}), encoding="utf-8")
        return SimpleNamespace(returncode=return_code)

    monkeypatch.setattr(server, "_run_mfa", lambda command, env: run(command))
    model_id.cache_clear()
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\0\0" * 16000)

    if return_code:
        with pytest.raises(RuntimeError, match="MFA alignment failed"):
            server.align_many([(buffer.getvalue(), "hello")])
    else:
        assert server.align_many([(buffer.getvalue(), "hello")])[0]["words"][0]["aligned"]
    assert list(mfa_root.iterdir()) == []
    model_id.cache_clear()


def test_mfa_timeout_stops_the_wrapper_and_its_descendant():
    command = [sys.executable, "-c",
               'import subprocess,sys,time; child=subprocess.Popen([sys.executable,"-c","import time; time.sleep(30)"]); '
               'print(child.pid,flush=True); time.sleep(30)']
    child_pid = None
    try:
        with pytest.raises(subprocess.TimeoutExpired) as caught:
            server._run_mfa(command, os.environ.copy(), timeout=1)
        child_pid = int(caught.value.output.strip())
        state = subprocess.run(["ps", "-p", str(child_pid), "-o", "stat="], capture_output=True, text=True).stdout.strip()
        assert not state or state.startswith("Z"), f"MFA descendant still running: {state}"
    finally:
        if child_pid:
            try:
                os.kill(child_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
