# discord/src — connector internals

- `index.ts` — process entry, config, wiring
- `discord-voice.ts` — the Gateway session and the voice (UDP + Opus + DAVE) transport
- `session.ts` / `session-manager.ts` — one live voice session per meeting
- `acts.ts` — meeting commands mapped onto voice actions
- `audio.ts` — Opus framing; `egress.ts` — drains captured audio to the ingest path
- `pipeline.ts` — per-speaker transcription pipeline; `ports.ts` — the interfaces it depends on
- `server.ts` — the runtime.v1 workload surface the control plane calls

`*.test.ts` sit next to the module they cover.
