# tests — agent-api (L1 + L2 of the validation pyramid)

`uv run pytest -q` (driven by `gate:python`).

| File | Level | Proves |
|---|---|---|
| `test_contracts_consumer.py` | L1 contract | transcript.v1 + workspace.v1 goldens validate by-path; meetings internals are un-importable |
| `test_core_run.py` | L2 unit | `core.run()` with **faked ports**: reads a transcript.v1 golden → emits the stub action → would-commit a workspace.v1-conformant entity |
| `test_config.py` | unit | `TINA_*` env validates + fails fast; secrets stay out of repr; worker `env` matches `runtime.v1` golden |
| `test_translation_groups.py` | unit | fragmented speech joins into phrases; speaker identity, pauses, sentence/size boundaries, source timestamps and stable group IDs are preserved |
| `test_meeting_translation.py` | API + unit | owner authorization, durable shared phrase cache, edit invalidation, lease deduplication/expiry, provider backoff/retry, live-tail buffering, stop flush, legacy cache separation, saved Meeting model and visible-only output |
| `fakes.py` | — | in-memory `WorkspacePort` / `RuntimePort` — the seam that makes L2 possible |
| `conftest.py` | — | loads transcript.v1 goldens by path (the spec, P8) |

Focused translation checks, from `core/agent`:

```bash
uv run pytest tests/test_meeting_translation.py tests/test_translation_groups.py -q
```

These tests fake provider calls and do not need API keys or consume inference quota. The broader
agent suite includes POSIX file locks and symlinks; run it on Linux/WSL or in the existing Docker
test environment when developing on Windows. Frontend behavior belongs to the Terminal canvas
and extension suites, not these backend tests.
