# TINA Transcript Viewer

The Chrome extension reads transcripts and can request a saved English translation overlay for Meeting Bot rows. It does not record audio, request microphone or tab-audio access, open the Desktop ingest WebSocket, or auto-start in meetings.

## Vietnamese to English

The compact **Review a meeting** disclosure is collapsed by default. Open it to select the
transcript source, meeting or language, or refresh the meeting list. The selected meeting is shown
in its collapsed summary, with a chevron indicating that the whole card opens the controls.
The Transcript heading shows the effective display language, including the original-only
Desktop archive view; translation progress and retry stay visible below it. Collapsing the controls
does not stop transcript polling or translation. Expanded controls scroll within a bounded area
so the transcript remains accessible on short panels. Original text and lightly tinted English
blocks use separate visual levels in both light and dark themes. Empty meeting lists do not
show a translation loading message. Connection/capture details remain in Settings.

The language dropdown inside **Review a meeting** defaults to **Song ngữ** and offers
**Tiếng Việt**, **English** and **Song ngữ**. The same owner-authorized
agent cache serves Terminal and extension; provider credentials remain on the server and the
saved Meeting model performs tool-less text translation. `meeting-translation.v2` groups
consecutive finalized fragments of the same speaker into one phrase. The live tail shows
**Đang gom câu…** until a sentence boundary or stable pause; stopping flushes it immediately.
Both clients render the same backend boundaries with one English result per phrase.
Existing Desktop archive rows keep the original-only view. Reload the extension after upgrading.

The original transcript remains visible when an English phrase is pending or unavailable.
Provider failures back off automatically; **Thử lại** explicitly retries. Edits invalidate only
the corresponding phrase. Reading above the live edge preserves the scroll anchor.
Translation inference advances while a translated view is open; closing all views pauses
new calls. Reopening resumes missing segments without regenerating cached translations.

## Transcript sources

- **Meeting Bot · TINA Terminal** lists meetings the signed-in TINA account may read through the Meeting Bot API gateway. Select a row to view exact-row snapshots, including drafts and accepted transcript edits. **Open Terminal** opens that meeting in TINA Terminal. **Open Dashboard** uses the configured Dashboard URL.
- **Desktop archive · Dashboard** lists saved Desktop journal meetings through the Desktop API gateway. It opens the same transcript review page served by that Desktop gateway. It does not merge Desktop SQLite data into Meeting API/PostgreSQL.

Both lists use existing read endpoints. The extension sends the API key in the `X-API-Key` header, refuses redirects, and clears a transcript when the server denies access. It stores the key and endpoint settings in `chrome.storage.local`. Transcript snapshots are polled every 1.5 seconds while selected; transient failures retry after 3 seconds.

## Settings

The settings page keeps the existing configuration fields:

- **API key** — account key used for Bot reads and optional Desktop authorization.
- **Deployment** — retained deployment profile.
- **API gateway override** — Desktop archive API, normally `http://127.0.0.1:8056`.
- **Meeting Bot API gateway** — Bot transcript API, default Compose port `http://127.0.0.1:18056`.
- **TINA Terminal URL** — meeting destination, default Compose port `http://127.0.0.1:13000`.
- **Dashboard override** — optional Bot meeting destination, normally `http://127.0.0.1:13001`.
- **Capture server, Language, Auto-start** — retained for compatibility and shown inactive. This extension build cannot use these settings to capture audio.

Existing values are preserved when the extension is upgraded. The repository defaults match a standard local Compose deployment; per-user endpoint overrides in Chrome storage remain intact. For the `tina-production` OrbStack project, set the Bot gateway to `http://127.0.0.1:28056` and Terminal to `http://127.0.0.1:23000`. This build grants HTTP access to loopback hosts; a remote HTTPS host needs a matching host permission in the manifest.

## Build and install

```bash
node build.mjs
```

In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `clients/extension/dist`. The manifest grants only storage, tabs, side-panel, and loopback HTTP access. It includes no meeting-site content scripts, tab-capture, microphone, offscreen, or ingest-WebSocket permissions.
