"""Loopback-only MFA forced alignment worker for short owner-requested transcript jobs."""
import asyncio
import hashlib
import io
import os
from functools import lru_cache
from pathlib import Path
import re
import secrets
import signal
import shutil
import subprocess
import tempfile
import wave

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile

app = FastAPI()
lock = asyncio.Lock()
MAX_SECONDS = 30
MAX_BYTES = MAX_SECONDS * 16000 * 2 + 4096
TOKEN_RE = re.compile(r"\s+")


def settings():
    return {
        "conda": os.getenv("MFA_CONDA_EXE", "conda"),
        "prefix": os.getenv("MFA_CONDA_PREFIX", ""),
        "root": os.getenv("MFA_ROOT_DIR", ""),
        "dictionary": os.getenv("MFA_DICTIONARY", ""),
        "acoustic": os.getenv("MFA_ACOUSTIC_MODEL", ""),
        "token": os.getenv("TINA_ALIGNMENT_TOKEN", ""),
    }


@lru_cache(maxsize=1)
def model_id():
    cfg = settings()
    digest = hashlib.sha256()
    for name in (cfg["dictionary"], cfg["acoustic"]):
        path = Path(name)
        digest.update(path.name.encode())
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
    return f"mfa-{os.getenv('MFA_VERSION', '3.3.4')}:{os.getenv('MFA_MODEL_VERSION', 'vietnamese_mfa-3.0.0')}:{digest.hexdigest()}"


def parse_alignment(output: dict, text: str, duration_ms: float, audio: bytes) -> dict:
    """Keep source tokens intact and reject timestamps for MFA unknown-phone spans."""
    tokens = TOKEN_RE.sub(" ", text.strip()).split() if text.strip() else []
    tiers = output.get("tiers", {})
    word_entries = (tiers.get("words") or {}).get("entries", [])
    phone_entries = (tiers.get("phones") or {}).get("entries", [])
    words = []
    if len(word_entries) == len(tokens):
        for index, (token, entry) in enumerate(zip(tokens, word_entries)):
            try:
                start, end = float(entry[0]) * 1000, float(entry[1]) * 1000
            except (TypeError, ValueError, IndexError):
                start, end = 0, 0
            has_unknown_phone = any(
                phone[2] == "spn" and float(phone[0]) < end / 1000 and float(phone[1]) > start / 1000
                for phone in phone_entries if isinstance(phone, (list, tuple)) and len(phone) >= 3
            )
            valid = (not has_unknown_phone and 0 <= start < end <= duration_ms + 1)
            words.append({"index": index, "text": token,
                          "start_ms": round(start, 2) if valid else None,
                          "end_ms": round(end, 2) if valid else None,
                          "aligned": bool(valid)})
    else:
        words = [{"index": i, "text": token, "start_ms": None, "end_ms": None, "aligned": False}
                 for i, token in enumerate(tokens)]
    return {"model": model_id(), "audio_sha256": hashlib.sha256(audio).hexdigest(),
            "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "duration_ms": duration_ms, "words": words}


def align(audio: bytes, text: str) -> dict:
    return align_many([(audio, text)])[0]


def _run_mfa(command, env, timeout=600):
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, start_new_session=True) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except BaseException:
            # Conda and MFA spawn children; stop the group before deleting their scratch files.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate()
            raise
        return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def align_many(items: list[tuple[bytes, str]]) -> list[dict]:
    cfg = settings()
    with tempfile.TemporaryDirectory(prefix="tina-mfa-align-") as tmp:
        root = Path(tmp)
        corpus, output = root / f"corpus-{root.name}", root / "aligned"
        corpus.mkdir()
        mfa_root = Path(cfg["root"]).resolve()
        mfa_cache = mfa_root / corpus.name
        durations = []
        for index, (audio, text) in enumerate(items):
            stem = f"segment-{index:03d}"
            (corpus / f"{stem}.wav").write_bytes(audio)
            (corpus / f"{stem}.lab").write_text(" ".join(TOKEN_RE.sub(" ", text.strip()).split()), encoding="utf-8")
            with wave.open(io.BytesIO(audio), "rb") as wav:
                durations.append(wav.getnframes() * 1000 / 16000)
        command = [cfg["conda"], "run", "--no-capture-output", "--prefix", cfg["prefix"], "mfa", "align",
                   str(corpus), cfg["dictionary"], cfg["acoustic"], str(output),
                   "--output_format", "json", "--num_jobs", "1", "--single_speaker",
                   "--no_use_mp", "--no_tokenization", "--clean", "--final_clean", "--overwrite", "--quiet"]
        env = dict(os.environ, MFA_ROOT_DIR=cfg["root"])
        try:
            result = _run_mfa(command, env)
            if result.returncode or any(not (output / f"segment-{i:03d}.json").is_file() for i in range(len(items))):
                raise RuntimeError("MFA alignment failed")
            import json
            return [parse_alignment(json.loads((output / f"segment-{i:03d}.json").read_text(encoding="utf-8")), text,
                                    durations[i], audio) for i, (audio, text) in enumerate(items)]
        finally:
            if mfa_cache.parent == mfa_root and mfa_cache.name.startswith("corpus-tina-mfa-align-"):
                shutil.rmtree(mfa_cache, ignore_errors=True)


@app.get("/health")
def health():
    cfg = settings()
    if (not cfg["token"] or not cfg["prefix"] or not cfg["root"]
            or not Path(cfg["dictionary"]).is_file() or not Path(cfg["acoustic"]).is_file()):
        raise HTTPException(503, "Configure the MFA runtime, models, and worker token")
    return {"status": "ok", "runtime": "Montreal Forced Aligner", "busy": lock.locked(),
            "max_seconds": MAX_SECONDS, "model": model_id()}


@app.post("/align")
async def align_audio(file: UploadFile = File(...), text: str = Form(...), authorization: str = Header("")):
    token = settings()["token"]
    if not token or not secrets.compare_digest(authorization, "Bearer " + token):
        raise HTTPException(401, "Unauthorized")
    if not text.strip() or len(text) > 10000 or any(ord(char) < 32 and char not in "\t\r\n" for char in text):
        raise HTTPException(422, "Transcript text must contain 1–10000 printable characters")
    if lock.locked():
        raise HTTPException(409, "Alignment worker is busy")
    async with lock:
        audio = await file.read(MAX_BYTES + 1)
        await file.close()
        if len(audio) > MAX_BYTES:
            raise HTTPException(413, "Audio exceeds 30 seconds")
        try:
            with wave.open(io.BytesIO(audio), "rb") as wav:
                if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (16000, 1, 2) or not 0 < wav.getnframes() <= MAX_SECONDS * 16000:
                    raise ValueError("Expected mono 16 kHz PCM16 WAV, at most 30 seconds")
            return await asyncio.to_thread(align, audio, text)
        except (ValueError, wave.Error, EOFError) as exc:
            raise HTTPException(422, str(exc)) from exc
        except (OSError, subprocess.SubprocessError, RuntimeError):
            raise HTTPException(503, "MFA alignment failed; source transcript and audio are unchanged")


@app.post("/align-batch")
async def align_audio_batch(files: list[UploadFile] = File(...), texts: str = Form(...), authorization: str = Header("")):
    token = settings()["token"]
    if not token or not secrets.compare_digest(authorization, "Bearer " + token):
        raise HTTPException(401, "Unauthorized")
    import json
    try:
        text_items = json.loads(texts)
    except ValueError as exc:
        raise HTTPException(422, "Invalid alignment text list") from exc
    if not isinstance(text_items, list) or len(files) != len(text_items) or not 1 <= len(files) <= 20:
        raise HTTPException(422, "Send matching batches of 1–20 audio files and transcripts")
    if any(not isinstance(text, str) or not text.strip() or len(text) > 10000 or any(ord(char) < 32 and char not in "\t\r\n" for char in text) for text in text_items):
        raise HTTPException(422, "Each transcript must contain 1–10000 printable characters")
    if lock.locked():
        raise HTTPException(409, "Alignment worker is busy")
    async with lock:
        items = []
        total_bytes = 0
        total_duration = 0.0
        try:
            for upload in files:
                audio = await upload.read(MAX_BYTES + 1)
                await upload.close()
                total_bytes += len(audio)
                if len(audio) > MAX_BYTES or total_bytes > 20 * MAX_BYTES:
                    raise ValueError("Alignment batch exceeds its audio size limit")
                with wave.open(io.BytesIO(audio), "rb") as wav:
                    if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (16000, 1, 2) or not 0 < wav.getnframes() <= MAX_SECONDS * 16000:
                        raise ValueError("Expected mono 16 kHz PCM16 WAV, at most 30 seconds per segment")
                    total_duration += wav.getnframes() / 16000
                items.append((audio, text_items[len(items)]))
            if total_duration > 10 * 60:
                raise ValueError("Alignment batch exceeds 10 minutes of audio")
            return {"results": await asyncio.to_thread(align_many, items)}
        except (ValueError, wave.Error, EOFError) as exc:
            raise HTTPException(422, str(exc)) from exc
        except (OSError, subprocess.SubprocessError, RuntimeError):
            raise HTTPException(503, "MFA alignment failed; source transcript and audio are unchanged")
