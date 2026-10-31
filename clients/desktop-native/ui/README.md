# Webview UI

Plain-JS front end loaded by the Tauri shell — no bundler, no framework:

- `index.html` + `app.js` — main window (capture settings, meeting controls)
- `overlay.html` + `overlay.js` — the recording overlay, geometry in `overlay-utils.js`
- `subtitles.html` + `subtitles.js` — live captions
- `dictation.js` — dictation mode
- `audio/` — start/stop cue sounds

`*.test.mjs` run with `node --test`.
