# clients — interface surfaces — extension · desktop · telegram · mcp

_Governed by `docs/docs/governance/architecture.mdx` (P1–P12). This folder owns one concern; its public surface is its `index`/contract; it may depend only on what the dependency-rules allow._

[desktop-native](desktop-native/) is the Tauri/Rust macOS microphone + system audio
capture client. It sends the existing `capture.v1` protocol to local Desktop; it does not
load an ASR model or replace the Terminal/Dashboard clients.

[`speech`](speech/) is the optional host-only "Hey TINA" wake-word pilot. `listen` and `file`
emit local diagnostics; opt-in `run` and `run-file` submit captured questions to the room
coordinator for STT, agent answers and shared meeting TTS.
