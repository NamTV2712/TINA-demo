# Terminal Google Meet review — 2026-10-31

## Result

The Terminal request defects, misleading join states, and Vexa-style Google Meet refusal retry are
deployed locally. The hotfix is live-verified: TINA recognized Google's `CreateMeetingDevice` 403
and retried three times within the lobby budget. Google refused all three attempts, so admission
still did not succeed; this is not a complete fix for persistent Google-side refusal.

## Source comparison and fixes

- Compared Terminal's launch actions and Dashboard's `parse-meeting-input.ts` / `join-modal.tsx`
  with the local Vexa reference checkout. Dashboard identifies Google Meet by native code and lets
  Meeting API construct its destination. Terminal instead forwarded pasted input as `meeting_url`,
  including a bare code that Meeting API rejects because it requires an HTTPS URL.
- Terminal's shared `meetingId.ts` now constructs Meet destinations from native IDs. The sidebar,
  Today input, resend, meeting preparation and Agent cookbook use the same helper. Scheme-less
  Meet links work; look-alike hosts are rejected. Other platforms retain passcode/deployment URLs.
- Requested, joining, waiting and stopping sessions no longer receive the header's `Live` label.
  The time label also avoids calling these pre-active states live.
- Compared the Chromium launcher, launch arguments and Google join driver with Vexa. Their
  substantive launch behavior already matches; bulk replacement is not a supported remedy.
- Found a product-page redirect during the live admission wait. The Google admission loop now
  terminates with a typed `join_failure` when redirected to `workspace.google.com/products/meet`,
  even when stale waiting-room DOM remains. Its final message uses the existing navigation-failure
  taxonomy, so a redirect is not attributed to host denial.
- Ported Vexa PR #1921's response-aware Meet refusal handling: watch the two relevant RPCs for
  HTTP 403, recognize the refusal copy, retry only that typed refusal up to three times within the
  existing lobby budget, and classify repeated refusal as exogenous platform evidence. Host denial,
  lobby timeout, redirect, and other join errors are not retried.

## Latest Vexa join parity

Compared TINA with Vexa `main` at `31122f96c285535873808c5b59969c562084f0c8` (PR #1921); this
was the only commit beyond the local Vexa checkout. TINA now has the same Google Meet refusal
signals, bounded retry behavior, typed terminal reason, and the refusal test is included in the
default `@tina/join` test command. The other reviewed platform join/admission flows retain their
Vexa behavior. TINA also keeps its additional Workspace redirect detection and its distinct
`join_failure` classification for generic Google block pages.

The code is not a byte-for-byte fork: TINA has its own `@tina/*` contracts and capture bridge. The
authenticated-session join path exists, but this deployment remains in guest mode: `BOT_AUTHENTICATED`
is false and no userdata S3 session is provisioned.

## Controlled live observations through Orca

Created one test Meet room with the already signed-in Google account. The host entered without
granting mic/camera permission; both remained off. No invitations were sent.

| Run | Entry point | Observation |
| --- | --- | --- |
| 24 | Terminal Today, bare Meet code | Request accepted; stored destination was canonical HTTPS; Bot reached `awaiting_admission`. Host showed only itself, with no admission request. Bot display subsequently showed the Google Workspace Meet product page. Stopped through Terminal. |
| 25 | Dashboard join form, same room | Reproduced `awaiting_admission` without a request visible to host. Stopped through Dashboard. |
| 26 | Terminal resend, updated Bot redirect guard | Detected the redirect and exited `join_failure` after 71,767 ms total, including 61,929 ms in the nominal lobby state, rather than continuing the 900,000 ms lobby budget. |
| 27 | Terminal Today, new owner-created test room, Vexa refusal hotfix | Spawned the rebuilt Bot image. Google returned `CreateMeetingDevice` HTTP 403 on all three knocks; TINA retried twice and exited in about 34 seconds. Meeting API stored `awaiting_admission_rejected` with `attribution=exogenous_platform` and `google_meet_join_refused`; the host never received an admission request. |

Google page logs include HTTP 403 and `DisconnectedError`, `EndCause=72`, `StartupCode=200`.
These observations do not identify Google's reason or prove the host rejected the Bot. Run 26's
first deployed diagnostic text was classified by the existing timing heuristic as host action;
the final image adds the existing `navigation failed` marker and a regression test to correct
classification for future runs. Run 27 is positive evidence for a Google-side refusal: it records
the exact RPC, three bounded knocks, and exogenous attribution. The new retry path works, but it
cannot override a refusal Google returns on every attempt. Historical evidence was preserved.

The test Bot runs are stopped/terminated, and the host left the test call. Terminal was refreshed
in the user's Orca tab. The Dashboard and all data volumes remain available.

## Validation and deployment

- Terminal focused suite: **87 passed across 8 files**, covering input normalization, resend,
  onboarding submit, header states, meeting store, cookbook and authenticated proxy behavior.
- Google refusal retry suite: **14 passed**; admission suite: **27 passed**; join CTA suite:
  **31 passed**; authenticated session suite: **13 passed**; join evidence suite: **112 passed**.
- Join and Bot TypeScript checks passed. The rebuilt Bot image `tina/tina-bot:dev` contains the
  hotfix; rollback image `tina/tina-bot:before-vexa-refusal-20261031` was retained.
- `@tina/join` isolation check passed. Its full package test script was interrupted during an
  existing high-volume admission-polling test; the focused refusal, admission, CTA and session
  suites above passed independently.
- Broader Terminal suite at the intermediate stage: **571 passed, 8 failed**. Remaining failures
  are in the existing Canvas default-view assertions and Routine UI/color assertions. Those files
  were not changed as part of the Meet fix. No whole-repository-green claim is made.
- Corrected incomplete proxy test requests by adding their real-world `Headers` member; production
  Next requests already provide that member.
- Terminal container now runs the rebuilt `tina/v012-terminal:dev` image. New Bot jobs resolve the
  rebuilt `tina/tina-bot:dev` image. Named Bot build `tina/tina-bot:vexa-refusal-20261031` and
  rollback tags remain available. The Runtime/Terminal/API stack was not restarted.
- Terminal returned HTTP 200 after recreation. Backend services and data volumes were not restarted.

## Remaining acceptance work

The next investigation is why this Google account/room received a persistent `CreateMeetingDevice`
403, and whether the existing authenticated Bot provisioning path avoids it. One TINA live run
does not establish a platform-wide success rate; it does establish that the hotfix now surfaces the
correct refusal instead of presenting it as an unanswered host-admission request.
