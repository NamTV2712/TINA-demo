"""Real synthesis smoke; writes a shareable WAV and content-free metrics. No secrets in argv."""
import argparse
import array
import hashlib
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    token = os.environ.get("TTS_API_TOKEN", "")
    if not token:
        raise SystemExit("Set TTS_API_TOKEN in the environment")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    text = "Xin chào, tôi là TINA. Đây là bài kiểm tra giọng nói tiếng Việt."
    data = json.dumps({"model": "tts-1", "input": text, "voice": "auto", "response_format": "pcm"}).encode()
    start = time.monotonic()
    req = urllib.request.Request(args.url.rstrip("/") + "/v1/audio/speech", data=data,
        headers={"X-API-Key": token, "Content-Type": "application/json"})
    with opener.open(req, timeout=30) as response:
        pcm = response.read(24000 * 2 * 120 + 1)
        assert response.status == 200
        assert response.headers.get("X-Audio-Sample-Rate") == "24000"
    elapsed = time.monotonic() - start
    assert 0 < len(pcm) <= 24000 * 2 * 120 and len(pcm) % 2 == 0
    assert not pcm.startswith(b"RIFF")
    samples = array.array("h", pcm)
    if sys.byteorder != "little":
        samples.byteswap()
    rms = math.sqrt(sum(x*x for x in samples) / len(samples)) / 32768
    assert rms > 0.001, "Synthesized audio is silent"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(args.output), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(pcm)
    print(json.dumps({"http_status": 200, "synthesis_seconds": round(elapsed, 3),
        "audio_seconds": len(samples) / 24000, "rms": round(rms, 5),
        "sha256": hashlib.sha256(pcm).hexdigest(), "output": str(args.output)}))


if __name__ == "__main__":
    main()
