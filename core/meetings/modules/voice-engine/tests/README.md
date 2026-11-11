# Voice engine tests

Channel isolation, ambiguous capture, quiet gating and timeout tests use fakes without microphone access. Native startup and real meeting acceptance are separate checks.

`test_kws_shadow.py` checks 64-to-80 ms buffering, per-channel isolation, identity/clock/sample-gap
resets, bounded streams/cooldown, busy/quiet gating, checksum rejection and atomic local installation.
Intermittent participant metadata must preserve continuous audio history; conflicting known IDs
must reset it. Tests also verify that missing ASR identity cannot erase a same-channel acoustic call.
Busy-state VAD tests require endpoint reports without a LISTENING transition or KWS rearm.
The bot TypeScript tests verify that KWS alone authorizes a caller, failures disable voice without affecting transcript, and Stop fences late events.
