# Genspark Speakly: REA notes and TINA mapping

Date: 2026-10-20

## Target and evidence

- Installed app: `/Applications/Genspark Speakly.app`, UI version `1.5.4809`; ASAR SHA-256 `7c3ffb9793ac62d69c68f3288259ab385002eb6555ec8bb3c32c05641861a25c`.
- `ev_2228f98a0175d58fee9fa9cf569d4250b4f85e745353ffe6cf2b233f8b617c82` — REA package inventory. Record-and-continue found four ASAR integrity mismatches in unpacked `sherpa-onnx-darwin-arm64` native libraries. Those library bytes are marked observed-untrusted. Separately, macOS `codesign --verify --deep --strict` passed for the installed app bundle.
- `ev_f4ca92844bb1d28e819d99ba054fda98380931d89514bd733cc9f6f86cdfbf47` — REA JavaScript analysis of a byte-identical copy of `app.asar` (same SHA-256). It parsed 33,363 JS files, with 22 parse failures. The semantic graph is partial and hit its 100,000-node ceiling; native add-on bindings were listed but not resolved. This does not establish which ASR model is active or prove runtime reachability.
- Exact-literal feature traces did not match in the partial graph. That is an analysis coverage limit, not evidence that the feature is absent. No speech was sent to Speakly and no account/backend API was inspected.

## Runtime UI observations

- Home says to hold `Fn` to dictate and release it to transcribe; double-pressing `Fn` opens Agent Mode.
- Shortcuts also lists optional hands-free dictation and screen-aware dictation, plus a Writing Style connection.
- The navigation exposes Dictionary, Meeting Notes, Live Translation, and Clipboard. Dictionary separates auto-added and manually added transcription terms.
- Screen-aware dictation is a distinct feature. TINA's implementation below does not read screen content.

## TINA implementation boundary

TINA Terminal already streams partial dictation into its composer using repeated 2.5-second STT windows and LocalAgreement-2 (`clients/terminal/src/ui-kit/micDictation.ts`). TINA Capture already sends audio to local TINA Desktop and displays transcript segments. The missing central workflow was a system-wide hold-to-talk trigger and insertion into the currently focused app.

The new TINA Capture dictation path holds `Control+Option+S`, captures microphone-only audio through the existing Desktop/selected-ASR pipeline, waits for transcript stabilization, writes the text to the system clipboard, and sends `Command+V`. It does not read screen contents. Automatic paste checks macOS Accessibility trust; if unavailable, the transcript remains in the clipboard for manual paste. The clipboard's previous contents are replaced.

## Remaining limits

- Speakly's active model/provider and its server behavior remain unknown from this local artifact analysis.
- The full JS graph was truncated, and its exact global-shortcut-to-ASR-to-paste path was not statically reconstructed.
- The built TINA hotkey/audio/paste flow was not exercised with live microphone input or Accessibility permission. Audio uses TINA's selected transcription endpoint, which may be external depending on configuration.
