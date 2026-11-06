# Local wake-word tests

Run `uv run --directory clients/speech pytest -q` from the repository root. Deterministic
tests need no microphone or downloaded model. Replay generated synthetic WAVs through the
real CLI/model separately, following the package README; never label them human validation.
