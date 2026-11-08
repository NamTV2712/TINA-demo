# LiveKit Agents pilot

Opt-in self-hosted room voice runtime. One LiveKit room and one AgentSession are allowed at a time.
The existing bot owns Google Meet capture, per-speaker KWS, selected ASR, turn ownership and microphone
playback receipts. Confirmed questions use custom HTTP I/O into Agents; PCM uses custom HTTP output
back to the existing bot microphone. This pilot does not publish raw meeting audio into LiveKit rooms
or add a second ASR/transcript writer.

Agents runs a custom LLM adapter calling TINA's capability-authenticated, policy-checked answer API
and a TTS adapter calling the existing local VieNeu service. LLM choice, read-only tools, source
verification and played-prefix history remain in TINA. The agent does not receive an owner API key or
access private workspaces. Its own chat context is isolated per request; only TINA's revalidated history
is used as evidence/context. This is an orchestration pilot, not a new model or a quality guarantee.
