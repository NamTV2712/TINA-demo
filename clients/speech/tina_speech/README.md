# Local speech implementation

`cli` owns explicit capture/replay lifecycle. `wakeword` owns the bounded callback queue,
per-input detector, pre-roll and cooldown. `assets` performs explicit pinned installation
and offline validation. These modules import no TINA core domains and dispatch no requests.

`model-assets.json` records the operator-downloaded Apache-2.0 model's provenance and hashes.

`coordinator` validates the anchored ASR wake prefix, including VieGem's unaccented `hay tina`
spelling, before accepting question text. Acoustic detection remains `HEY_TINA` and still runs
locally in the participant; this spelling adaptation does not broaden the allowed sources.
`capture` keeps a bounded 1200 ms continuation window after an already endpointed pre-roll so
a short pause after the wake cannot cause the following question to be discarded.
