# Extension source

- `viewer.ts` — transcript-first panel, source and meeting selection, read-only polling, settings and destination links.
- `bot-transcript.ts` — authenticated Bot and Desktop transcript list/snapshot readers; exact meeting identity validation, cancellation and retry.
- `transcript-feed.ts` — shared transcript turn renderer with scroll and text-selection preservation.
- `viewer-background.ts` — opens the Chrome side panel when the toolbar icon is clicked. It has no capture or network handlers.
- `sidepanel.html` — English viewer and settings UI.

`build.mjs` bundles only the viewer and its side-panel launcher. The older capture implementation files remain in the checkout for compatibility with existing source-level diagnostics, but the extension build and manifest do not ship or grant access to them.
