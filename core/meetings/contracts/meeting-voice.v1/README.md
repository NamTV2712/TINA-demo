# meeting-voice.v1

`VoiceReply` describes an owner-only validated TINA answer, its generated request ID, receipt state
and server timestamps. Durable meeting history is separate from participant `transcript.v1`; stopped,
failed or unconfirmed answers may contain unspoken text. Terminal and Extension render the same
history through `GET /meetings/{id}/voice-assistant`. Full answer text never enters diagnostics or
generic transcript/share payloads. Artifact deletion also deletes reply history.

Core-owned room voice policy, bounded question request, and bounded runtime diagnostics. Newly spawned capable Google Meet rooms with transcription enabled receive an explicit initial policy: LiveKit Agents selected, Voice assistant on, NS Low on, own-meeting transcript/general knowledge/explicit public web enabled, no documents. Existing saved room choices survive continuation; a room with no saved policy gets the new defaults on its next capable spawn. Request-model defaults and legacy reads remain conservative rather than reinterpreting old missing fields. Policy updates compare revision and increment it. Capability-authenticated bot routes bind meeting and active session; public GET/PUT is owner-scoped. Question requests may not supply documents or an owner identity. Active room state is ephemeral; original audio/transcripts are not rewritten.

New KWS-capable bots accept acoustic TINA ơi / hey TINA through LiveKit WakeWord 2.1.1.
`wake_variants` remains a revision-bound owner-approved list of at most eight exact ASR name aliases
for cleaning a captured question copy and compatibility with older ASR-addressed bots. It grants no
activation authority to ASR text in a new KWS bot. Raw/canonical transcript is unchanged.

`VoiceState.kws` optionally reports pinned engine/version, CPU, activation mode, off/starting/ready/
failed state, exactly the two retained model IDs and original observation time. Capability/session
checks and 15-second freshness apply. Settings services reports only active owned meeting sessions;
shared rooms, previous sessions and expired reports cannot establish readiness. Older bots may omit
this field and are shown as requiring a new bot rather than ready. No token, participant ID or audio
is accepted in this snapshot. `kws_unavailable` is an allowlisted failure diagnostic.

Settings services also returns `new_meeting_policy` from the same factory used when spawning a room.
Terminal displays these defaults without an active meeting; optional room overrides remain separate.

Completed playback may open a 15-second local follow-up window on the same channel and known
participant ID. It confers no extra source/account permissions. Missing identity, Stop, expiry,
policy change or failed playback requires a new wake. The bot reuses the existing answer request
shape and speaker header; private source-validated history marks completed clarifications so a
short follow-up can answer them. No transcript rows are rewritten.

Optional `VoiceReply.played_text` separates completed playback from the full generated proposal.
Interrupted (`stopped`) history forwards only a nonempty played prefix and clears pending
clarification state; replies without confirmed prefix are excluded. Source fingerprints, speaker,
session and policy gates still apply. Cards show whole completed sentences for known stopped
progress; legacy unknown playback remains explicitly uncertain. No partial-word claim is made.
Diagnostics include `waiting_turn_end` and `interrupted` for bounded pause waits and explicit stops.

## Owner diagnostics

Bot `VoiceState` optionally carries a `VoiceDiagnostic` with a UUID event ID, allowlisted reason
code, original observation timestamp, optional source channel/start and at most the first three
ASR words (64 characters). It never carries the full question. `heard_at_ms` preserves the age of
text across later phase changes. Older bots may omit diagnostics.

Meeting API binds every write to the active bot session and exposes diagnostics only via the
owner-scoped voice settings endpoint. State heartbeats expire after 15 seconds; the separate
`meeting:voice:{meeting}:diagnostic` key expires within 30 seconds of the original heard/observed
time. Retries of an event ID and delayed older observations cannot extend/replace a newer event.
Expired, departed or previous-session details are not returned. These fields never write to the
canonical/raw transcript, meeting JSONB, recordings or application diagnostic logs.

The owner runtime response includes `session_active`, `heartbeat_fresh` and optional `diagnostic`.
No heartbeat is not interpreted as a listening bot. Terminal invalidates runtime on failed reads and after 15 seconds without a successful read, including a hanging poll; recovery preserves unsaved policy edits. `evidence_available` on the private answer
response distinguishes an insufficient-evidence fallback from a supported response; the source
and policy validation path remains authoritative.

Optional `VoiceState.audio` carries `AudioSnapshot` with at most 16 distinct `AudioChannel` numeric
rows. It is session-capability authenticated and returned only by the owner runtime endpoint.
Snapshots share the 15-second status expiry; original observation timestamps prevent a delayed
snapshot from appearing fresh. No frame payload, transcript, name or participant ID is accepted.
Queue latency is measured by the backend; an absent measurement stays null/absent. Sample-index
gaps/overlap are observations, not assertions about network loss. Older state producers remain valid.

## Optional conversation scope

Bot answer requests may include `X-Voice-Speaker-Key`, a 64-character SHA-256 of the transport
participant ID. The JSON question contract is unchanged. Unknown participant identity omits the
header and disables personal history; channel IDs and display names do not infer a person/account.
Meeting API scopes its private Redis history by meeting, bot session, policy revision and speaker
key. At most three turns live for 15 minutes; only completed playback receipts may enter the next
prompt. Agent revalidates all historical source fingerprints against currently approved sources.
Questions/history never enter public reply projections, transcript rows or diagnostic logs.

Room answer modes are separately authorized by `VoicePolicy.allow_general_knowledge` and
`allow_web_search` (both false for missing/legacy fields). Settings → Voice assistant → Room answers
edits the active owner's room with the existing revision check; a change cancels the current turn.
Meeting mode can request one round of at most two read-only lookups: recent transcript, keyword
search across the authorized transcript snapshot, and explicitly shared linked Markdown/Wiki.
The model cannot open arbitrary paths. Excerpts, output length and lookup counts are bounded;
all factual meeting claims retain source validation, verification and the final revocation check.

Public web requires a spoken `Tìm trên web về …`, `Tra cứu web về …`, or `Search the web for …`.
Only that explicit query is sent; transcript, documents and voice history are excluded. The configured
completion adapter must support native web search (currently OpenAI Responses); unsupported or
uncited results fail visibly. Standalone definitions or `Kiến thức chung: …` use an isolated general
completion, never a fallback for an unsupported meeting fact. General/web answers announce their
kind. Both modes still recheck room policy before releasing an answer, and neither writes Wiki.

`VoiceReply.answer_kind`, `reason`, `lookups` and `links` preserve a bounded explanation separately
from playback state. Failure reasons distinguish no approved sources, retrieval miss, insufficient
support, rejected/unavailable verification, LLM failure and disabled/unavailable web/general modes.
Public links come from provider citation metadata, are validated as HTTP(S) and displayed as links
in Terminal and Extension. They are not fabricated from model text. Existing replies default to
meeting/answered with no links. No model, audio window, canonical ASR row or source permission is
changed by these answer-mode additions.

`VoicePolicy.engine` is `tina` (default, including old records) or `livekit` (explicit one-meeting
self-hosted pilot). The owner changes it with the existing revision check and Stop fence. LiveKit
configuration/readiness is separate from TTS readiness. New bots advertise `X-TINA-Voice-Runtime:
livekit-v1`; old bots cannot silently run native voice under a selected pilot policy. The bot config
carries the scoped internal agent URL; no LiveKit server secret or owner API key reaches the bot.
Confirmed selected-ASR text goes through AgentSession's TINA LLM adapter and local VieNeu TTS
adapter over custom HTTP I/O. Actual heard-prefix/Stop receipts remain controlled by the bot,
not by SDK audio-delivery events. Source, session and caller fences remain unchanged.

LiveKit Agents uses internal capability-only `POST /bots/voice/{meeting}/{session}/agent`
(`VoiceAgentQuestion`: context, plan, lookup). Context reserves the request and returns at most three
source-valid heard turns. The selected LLM plans at most two read-only queries; SDK function tools
execute only that plan. Final `VoiceQuestion.agent_context` must match the caller's actual completed
or stopped-prefix playback history; source references stay server-side. Query and completion budgets
are reserved atomically; Stop, policy/session changes and mismatched callers fence later operations.
Native TINA requests omit `agent_context` and keep their existing tool loop. `VoiceLookup.tool` also
accepts `search_web`, authorized only for an explicit public query and room web opt-in.

`VoiceReply.answer_kind=assistant` marks fixed server-owned identity, greeting, thanks, capability
and unsupported-action responses. These contain no meeting facts and grant no new sources.
Compound or unrecognized requests retain conservative meeting routing; public web remains explicit.
`verification` records up to two content-free codes: approved, numeric_mismatch, unsupported_claim,
contradiction, ambiguous, unavailable, repair_failed. A first rejected draft may be repaired once
against the same approved evidence and must pass numeric and semantic checks again. A provider
outage skips repair. Supported claims may include a separately validated short follow-up question.
Original drafts and reviewer prose are never persisted in this metadata. Source fingerprints,
policy/session/Stop fences and actual played-prefix history remain authoritative.

Voice retrieval may expose a bounded chunk of an authorized parent source, identified by a deterministic voice-chunk key. Source fingerprints include the parent fingerprint and the exact character range. Per-chunk timestamps retain the parent interval. Source references still use key/fingerprint; they grant no additional source authority.

VoiceReply.reason includes summary_pending for recap preparation that exceeded the bounded wait. The bot announces slow recap work once, then automatically plays the verified result in the same reserved turn. All background map/select/verify stages share a 120-second waiting budget; an expired run returns no partial facts or promise of later playback. Completed recaps retain answer_kind meeting and existing original-source references/verification. Transcript capture continues; another voice question requires stopping/correcting the active turn first.

Internal `GET /internal/meeting-voice/{meeting}/turn/{request}` returns `VoiceTurnPermit` to Agent API
only with the matching service secret and owner header. Its boolean confirms the current exclusive
reservation and active bot session, never an account identity derived from a speaker. Every recap
job checks it before and after inference. Source-policy revisions and fingerprints are checked
separately; Stop, replacement sessions/requests, departure and artifact deletion fence late results.
The room lease is 360 seconds; the bot's 330-second total budget leaves time for bounded playback.

The LiveKit agent protocol now allows at most two plans, two tools per plan and four attempted lookups total. VoiceLookup/VoiceLookupQuery add read_source_context, whose query must match ctx-[0-9a-f]{64} and appear in the same turn allowlist. VoiceReply.lookups holds at most four traces. The 30-second retrieval deadline skips unfinished work without discarding successful earlier queries; finalization waits for attempted/skipped tools and uses executed queries only. Native tool planning remains one round; recap preparation uses its separate protocol.

VoiceReply.source_refs is internal durable metadata (key/fingerprint only); public history strips it and derives source_count. VoiceSources returns up to 32 freshly authorized source quotes and an unavailable count. Source reads recheck current room sharing, linked documents, source fingerprints and artifact deletion; ended meetings remain owner-readable. Sources do not enter public transcript/share payloads.

Turn ownership remains exclusive per meeting. Admission may atomically replace a reservation only when its known bot session has been superseded; current and unrecognized reservations remain fenced. Retired playback is stopped without rewriting canonical transcript or source policy. No request/response schema changed for this recovery.

Agents also uses capability-authenticated `GET /bots/voice/{meeting}/{session}/turn/{request}?revision=...`
returning the same VoiceTurnPermit. No internal service secret or owner/provider key is needed.
It confirms the exact Redis reservation, active session and current LiveKit policy revision before
PCM synthesis, periodically while streaming and at completion. SDK Stop-cache loss after restart
cannot authorize an old or another meeting's request.
