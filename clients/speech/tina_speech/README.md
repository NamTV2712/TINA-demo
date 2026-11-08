# Local speech implementation

`cli` owns explicit capture/replay lifecycle. `wakeword` owns the bounded callback queue,
per-input detector, pre-roll and cooldown. `assets` performs explicit pinned installation
and offline validation. These modules import no TINA core domains and dispatch no requests.

`core/meetings/modules/voice-engine/tina_meeting_voice/model-assets.json` records the operator-downloaded Apache-2.0 model's provenance and hashes.
