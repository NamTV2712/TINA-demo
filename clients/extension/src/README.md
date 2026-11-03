# Extension source

- `viewer.ts` — transcript-first panel, source/meeting selection, transcript polling, translation orchestration, settings and destination links. The display-language dropdown defaults to **Song ngữ**; its state is separate from the retained capture-language setting.
- `bot-transcript.ts` — authenticated Bot and Desktop transcript list/snapshot readers; exact meeting identity validation, cancellation and retry.
- `transcript-feed.ts` — transcript turn renderer with scroll/text-selection preservation and one original/English pair per backend phrase in translated modes.
- `translation.ts` — authenticated `meeting-translation.v2` reads/advances through the Bot gateway, cancellation and retry; projects backend groups only when visible source members still match. Provider keys never enter the extension.
- `translation.test.ts` — grouped projection, stale-source rejection and authenticated shared-cache client checks.
- `viewer-background.ts` — opens the Chrome side panel when the toolbar icon is clicked. It has no capture or network handlers.
- `sidepanel.html` — viewer/settings UI, the three-option transcript-language dropdown, translation status and retry control.

`build.mjs` bundles only the viewer and its side-panel launcher. The older capture implementation files remain in the checkout for compatibility with existing source-level diagnostics, but the extension build and manifest do not ship or grant access to them.

Run `pnpm --dir clients/extension typecheck` and `pnpm --dir clients/extension test` from
the repository root. Build with `pnpm --dir clients/extension build`, then reload the installed
extension in `chrome://extensions`. See the [installation guide](../README.md).
