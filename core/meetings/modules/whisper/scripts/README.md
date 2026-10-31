# whisper/scripts

[`check-isolation.js`](check-isolation.js) — the brick's `gate:isolation` (P2)
check. `@tina/transcribe-whisper` uses only Node/Web globals, so it must import
nothing external.
