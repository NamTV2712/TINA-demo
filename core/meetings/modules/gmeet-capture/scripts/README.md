# gmeet-capture/scripts

[`check-isolation.js`](check-isolation.js) — the brick's `gate:isolation` (P2) check.
`@tina/gmeet-capture` may import only `@tina/capture-codec` (the capture.v1 SSOT) + declared
devDeps — never another brick's internals, never node/Playwright (it's page code).
