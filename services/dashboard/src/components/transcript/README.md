# Transcript review components

Owner-facing transcript display, revision diff and recording review. Check audio
measures bounded saved bot clips without inference; Refine flagged segments decodes
only clips with advisory RMS/clipping/quiet-frame/repetition flags. Filters compare
expected text revisions; checked items never expose Apply.

Retry failed segments mirrors Terminal's explicit job-ID-only start request. Failed
items show sanitized reasons; settled suggestions remain available across retries.

Refinement options mirrors Terminal's default-off Optimize quiet audio control and
original playback. Only new ASR jobs carry normalize_audio; Check audio and manual
retry retain their existing payloads. The selected proposal reports actual gain or
why preparation was skipped. No live capture or translation endpoint is changed.
