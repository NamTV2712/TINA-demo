# extension/scripts

[`check-isolation.js`](check-isolation.js) — the brick's `gate:isolation` (P2) check.
It follows only the viewer entry points shipped by `build.mjs` and permits local imports,
builtins, and declared dependencies. Legacy capture source is not part of the extension bundle.
