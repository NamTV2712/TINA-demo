# canvas

Harnessed Meeting Canvas runtime for terminal-side generated React views.

Meeting Bot transcripts offer one language dropdown above search with **Tiếng Việt**,
**English** and **Song ngữ**; **Song ngữ** is selected by default.
English/bilingual requests the shared `meeting-translation.v2` overlay through the existing
authenticated proxy. Exact accepted source text is retained separately from display cleanup
so edits cannot attach a stale translation. Each pair preserves speaker/time and recording
playback. Backend-owned groups join source fragments into one original/English phrase.
The live tail shows **Đang gom câu…** until a sentence boundary or stable pause; stopping
the meeting flushes it immediately. Missing translations retain Vietnamese; errors expose
retry without stopping ASR. Editing any member invalidates its entire English phrase.
The meeting info rail starts collapsed to leave more space for paired paragraphs.

Translation files:

- `MeetingTranslation.tsx` owns the language selector, status/retry controls and cancellable overlay polling.
- `translationGroups.ts` projects backend phrase boundaries onto exact source IDs/text; it does not choose translation boundaries or call a model.
- `MeetingCanvasView.tsx` selects the display mode, applies phrase-aware search/speaker filtering and passes paired content to `LiveTranscriptEngine.tsx`.
- `types.ts` and `useMeeting.ts` retain exact accepted `sourceText` alongside display cleanup so stale English is rejected after edits.

Existing original/processed transcript switching is available in **Tiếng Việt** mode. Provider
failure affects the English overlay only. See the [canvas tests](__tests__/README.md) and
[backend contract](../../../../core/agent/contracts/meeting-translation.v2/README.md).

Public surface:
- `runtime.tsx` renders validated `views/meeting.tsx` source.
- `kit.tsx` exports the theme-locked `ui` component vocabulary.
- `useMeeting.ts` and `actions.ts` expose the live meeting feed and sanctioned side effects.

This folder may depend on terminal surfaces for existing meeting/workspace data seams, but generated
views may only use the injected harness globals and `ui.*` kit.
