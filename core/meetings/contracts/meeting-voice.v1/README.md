# meeting-voice.v1

`VoiceReply` describes an owner-only validated TINA answer, its generated request ID, receipt state
and server timestamps. Durable meeting history is separate from participant `transcript.v1`; stopped,
failed or unconfirmed answers may contain unspoken text. Terminal and Extension render the same
history through `GET /meetings/{id}/voice-assistant`. Full answer text never enters diagnostics or
generic transcript/share payloads. Artifact deletion also deletes reply history.

Core-owned room voice policy, bounded question request, and bounded runtime diagnostics. Newly spawned capable Google Meet rooms with transcription enabled receive an explicit initial policy: Voice assistant on, NS Low on, own-meeting transcript allowed, no documents. Existing saved room choices survive continuation; a room with no saved policy gets the new defaults on its next capable spawn. Request-model defaults and legacy reads remain conservative rather than reinterpreting old missing fields. Policy updates compare revision and increment it. Capability-authenticated bot routes bind meeting and active session; public GET/PUT is owner-scoped. Question requests may not supply documents or an owner identity. Active room state is ephemeral; original audio/transcripts are not rewritten.

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
