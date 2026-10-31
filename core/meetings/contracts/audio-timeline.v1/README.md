# audio-timeline.v1

Owner: core/meetings. Producer: Desktop. `GET /transcripts/{platform}/{native}/audio-timeline` returns this metadata, without PCM or credentials. Access uses the same meeting read policy as transcripts, and a foreign browser Origin is refused.

Add `session`, `source`, `start_sample`, `end_sample` to read up to 30 seconds of PCM WAV. The receiver tries the authorized session in RAM, then the same meeting/session/source in SQLite. `X-TINA-Audio-Source` identifies memory/archive. Missing audio returns HTTP 409 with `missing: [{startSample,endSample}]`; no silence is invented. Legacy archive rows have null sample indices and remain available through their old timestamp-based playback path.

Source indices are logical channels: 1000 microphone, 999 system/mixed audio, other nonnegative values per capture track. Session UUIDs separate reconnects. A sample index is source-local, not a speaker identity or an epoch timestamp.

`overflow` in this metadata reports RAM retention eviction, which is normal once the ring fills. A live ASR working-window overflow is separately surfaced as a buffer fault; stored ranges can be recovered. `gap` means audio was not delivered for the range; the receiver does not infer whether it was pause, loss, or a legacy capture filter. Clock discontinuities preserve the sample-derived timeline and the original capture timestamp in the archive.
