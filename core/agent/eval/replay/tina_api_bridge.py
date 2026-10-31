#!/usr/bin/env python3
"""tina_api_bridge.py — TINA API → live-meeting-copilot integration (inbound watch → fire).

The real-source counterpart of ``replay_transcript.py``: instead of replaying a fixture, it sends a REAL
meeting request to a self-hosted TINA deployment and bridges its LIVE transcript into the copilot's wire.

    You start a Google Meet ─▶ self-hosted TINA bot joins + transcribes
                                         │  ws://localhost:18056/ws  (event: transcript.mutable)
                                         ▼
                               this bridge  ──XADD──▶  tc:meeting:{row_id}      (local redis)
                                   │  POST /agent/meeting/start
                                   ▼
                          agent-api ─▶ dispatch agent-meet-{row_id} ─▶ worker tails the stream → cards

A new transcript SOURCE is config, not a new copilot — the canonical Integration primitive.

    python tina_api_bridge.py --meeting-url https://meet.google.com/abc-defg-hij

Env: TINA_API_KEY (never logged), TINA_BASE_URL (default http://localhost:18056). Flags: --redis (dest, default the in-network redis),
--gateway, --meeting-id (required with --no-bot), --no-bot (don't send a bot, just consume an existing one),
--duration N (stop after N seconds), --idle-end N (end the meeting after N seconds with no new segment).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import time
import urllib.request

API_BASE = os.environ.get("TINA_BASE_URL", "http://localhost:18056").rstrip("/")
WS_BASE = API_BASE.replace("https://", "wss://").replace("http://", "ws://")
KEY = os.environ.get("TINA_API_KEY", "")


def parse_meeting(url: str) -> tuple[str, str]:
    m = re.search(r"meet\.google\.com/([a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3})", url)
    if m:
        return "google_meet", m.group(1)
    m = re.search(r"/meet/(\d+)", url)  # teams
    if m:
        return "teams", m.group(1)
    raise SystemExit(f"can't parse platform/native_id from {url!r}")


def _req(method: str, base: str, path: str, body: dict | None = None, *, key: str | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if key:
        headers["X-API-Key"] = key
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read().decode() or "{}"
    return json.loads(raw)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--meeting-url")
    ap.add_argument("--platform")
    ap.add_argument("--native-id")
    ap.add_argument("--redis", default="redis://redis:6379/0")
    ap.add_argument("--gateway", default=os.environ.get("TINA_GATEWAY_URL", "http://gateway:8000"))
    ap.add_argument("--meeting-id", default="", help="numeric meeting_id to use (required with --no-bot)")
    ap.add_argument("--bot-name", default="TINA EI")
    ap.add_argument("--language", default="en")
    ap.add_argument("--no-bot", action="store_true", help="don't send a bot — consume an existing one")
    ap.add_argument("--duration", type=int, default=0, help="stop after N seconds (0 = until the bot ends)")
    ap.add_argument("--idle-end", type=int, default=0, help="end the meeting after N idle seconds")
    ap.add_argument("--poll", type=float, default=3.0, help="REST transcript poll interval (seconds)")
    args = ap.parse_args()
    if not KEY:
        raise SystemExit("TINA_API_KEY not set")

    if args.meeting_url:
        platform, native_id = parse_meeting(args.meeting_url)
    elif args.platform and args.native_id:
        platform, native_id = args.platform, args.native_id
    else:
        raise SystemExit("need --meeting-url or --platform + --native-id")
    print(f"[bridge] meeting platform={platform} native_id={native_id}", flush=True)

    import redis as redislib

    r = redislib.from_url(args.redis, decode_responses=True)

    # 1) send the real TINA Cloud bot into the meeting
    meeting_id = args.meeting_id
    if not args.no_bot:
        try:
            res = _req("POST", API_BASE, "/bots", {
                "platform": platform, "native_meeting_id": native_id,
                "bot_name": args.bot_name, "language": args.language,
            }, key=KEY)
            meeting_id = str(res.get("id") or res.get("meeting_id") or meeting_id)
            print(f"[bridge] bot requested → status={res.get('status', res)}", flush=True)
        except Exception as e:  # already-joined / race — keep consuming
            print(f"[bridge] POST /bots note: {e}", flush=True)
    if not meeting_id.isdigit():
        raise SystemExit("a numeric --meeting-id (or a successful POST /bots) is required")
    stream = f"tc:meeting:{meeting_id}"

    # 2) fire the copilot dispatch (built through the ONE make_dispatch on the control plane)
    started = _req("POST", args.gateway, "/agent/meeting/start", {
        "meeting_id": meeting_id, "platform": platform, "native_id": native_id,
        "title": f"{platform} · {native_id}",
    }, key=KEY)
    print(f"[bridge] copilot dispatched → {started.get('unit_id')}", flush=True)

    # dedup: the REST transcript restates the whole meeting each poll; emit each segment once. ASR may
    # refine a segment's text after first sight — we take the first finalized version (clean growing feed).
    seen: set[str] = set()

    def emit(seg: dict) -> bool:
        text = (seg.get("text") or "").strip()
        if not text:
            return False
        key = str(seg.get("segment_id") or seg.get("absolute_start_time")
                  or round(float(seg.get("start") or 0.0), 2))
        if key in seen:
            return False
        seen.add(key)
        out = {
            "type": "transcription", "session_uid": meeting_id, "meeting_id": meeting_id,
            "native_meeting_id": native_id, "platform": platform,
            "segments": [{
                "speaker": seg.get("speaker") or "Speaker", "text": text,
                "start": float(seg.get("start") or 0.0), "end": float(seg.get("end") or 0.0),
                "completed": True, "language": seg.get("language", "en"), "segment_id": key,
            }],
        }
        r.xadd(stream, {"payload": json.dumps(out)})
        s = out["segments"][0]
        print(f"[seg {s['start']:7.1f}] {s['speaker'] or '?'}: {text[:64]}", flush=True)
        return True

    # 3) live: poll the REST transcript and fan NEW segments onto the wire. REST is the source of truth
    # (the /ws frame shape varies and ships mutable drafts); a few seconds' latency is well inside the
    # copilot's multi-segment beat. Bootstrap is just the first poll.
    print(f"[bridge] polling /transcripts/{platform}/{native_id} every {args.poll}s", flush=True)
    t0 = time.monotonic()
    last_seg = time.monotonic()
    try:
        while True:
            if args.duration and time.monotonic() - t0 > args.duration:
                print("[bridge] duration reached", flush=True)
                break
            if args.idle_end and time.monotonic() - last_seg > args.idle_end:
                print("[bridge] idle-end reached", flush=True)
                break
            try:
                d = _req("GET", API_BASE, f"/transcripts/{platform}/{native_id}", key=KEY)
                if sum(emit(s) for s in (d.get("segments") or [])):
                    last_seg = time.monotonic()
                if d.get("status") in ("completed", "failed", "stopped"):
                    print(f"[bridge] meeting ended on cloud (status={d.get('status')})", flush=True)
                    break
            except Exception as e:
                print(f"[bridge] poll error: {e}", flush=True)
            time.sleep(args.poll)
    finally:
        # 4) end the meeting on the wire → the worker reaps + the terminal flips to ended
        r.xadd(stream, {"payload": json.dumps({
            "type": "session_end", "meeting_id": meeting_id,
            "native_meeting_id": native_id, "platform": platform,
        })})
        print("[bridge] session_end", flush=True)


if __name__ == "__main__":
    main()
