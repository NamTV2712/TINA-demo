# capture.v1 — extension/bot → desktop capture wire

The ONE serialization shared by both capture lanes (`gmeet-capture.v1`,
`mixed-capture.v1`). The **sender** stamps capture-time into every frame; the
**receiver NEVER restamps** (uses `ts` as-is, never `Date.now()`). Pure,
zero-dep, drift-gated — bot-captured and extension-captured fixtures are
byte-identical. This contract is the source of truth; the rest of this page is
the **validation index** — the one place that says where every piece is proven.

The codec lives in [`../index.ts`](../index.ts). Two frame kinds cross the seam:
a **binary audio frame** and a **text event frame**. (The `REC1` recording-chunk
frame also rides this same ingest WS, but it belongs to `recording.v1` and is
golden-pinned in `modules/recording` — it is NOT part of this contract.)

## Audio frame (binary) — `encodeAudioFrame` / `decodeAudioFrame`

Little-endian throughout. Two **backward-compatible** shapes, told apart by the
high bit of the leading Int32 `track`:

**Unnamed (mixed lane)** — high bit clear:

| offset | type        | field                                  |
|--------|-------------|----------------------------------------|
| 0      | Int32LE     | `track` (`speakerIndex`, ≥ 0)          |
| 4      | Float64LE   | `ts` (CAPTURE epoch ms)                |
| 12     | Float32LE…  | PCM samples (16 kHz mono), `n` floats  |

Header = **12 bytes**, then `4·n` PCM bytes.

**Named (gmeet lane)** — high bit (`0x80000000`) set on `track`:

| offset | type         | field                                              |
|--------|--------------|----------------------------------------------------|
| 0      | Int32LE      | `track | 0x80000000` (decode masks with `0x7fffffff`) |
| 4      | Float64LE    | `ts` (CAPTURE epoch ms)                            |
| 12     | Int32LE      | `nameLen` (UTF-8 byte length of the name)          |
| 16     | UTF-8 bytes  | `speakerName`, then **zero-padded to a 4-byte boundary** |
| 16+pad | Float32LE…   | PCM samples, `n` floats                            |

Header = **16 bytes** + `padded` name bytes (`padded = (nameLen + 3) & ~3`,
keeping the PCM 4-byte aligned), then `4·n` PCM bytes.

The high bit is **never** set by a real track id (`0..1002`), so a legacy
(unnamed) frame decodes unchanged — that is the back-compat rule. `gmeet` binds
the glow name HERE at the source; `mixed` omits it and names downstream from
hints. Decoded shape:
`{ speakerIndex, ts, samples: Float32Array, speakerName? }` (`speakerName`
present only on named frames).

Native Desktop reserves 999 for system audio and 1000 for the microphone. The
default `speex-aec` build enables AEC with residual suppression for dual-source
capture when sample-index.v1 is available; track 1002 carries the raw
mic for durable archive/recovery while track 1000 carries the derived
echo-cancelled signal to ASR. Aligned native blocks also use 70 Hz high-pass
filtering of mic/reference and mild Speex denoising (-3 dB maximum attenuation).
Neither operation drops samples or changes source sample indexes/timestamps;
track 1002 remains the unprocessed, resampled microphone and track 999 remains
the original resampled system mix. Desktop archives track 1002 but never transcribes
it during live capture or ASR recovery. `TINA_MIC_CLEANUP=0` restores AEC plus
residual-only processing. `TINA_SPEEX_AEC=0` disables the echo path; `TINA_SPEEX_RESIDUAL_SUPPRESSION=0`
keeps linear AEC only. Unsupported timestamps or DSP initialization failure use the
original microphone path. When AEC is disabled, existing channel routing is unchanged.

**PCM precision** — the wire stores Float32. The decoded `samples` are exactly
the input rounded to Float32 (bit-identical to `new Float32Array(input)`), not
the original Float64 literals.

## Event frame (text) — `encodeEvent` / `decodeEvent`

`JSON.stringify(MeetingEvent)` ⇄ `JSON.parse` with a shape guard. The envelope
(chat + lifecycle + the mixed lane's active-speaker hints all ride this one
JSON shape):

| field     | type   | meaning                                                              |
|-----------|--------|---------------------------------------------------------------------|
| `kind`    | string | `speaker-joined`·`speaker-left`·`active-speaker`·`caption`·`segment`·`lifecycle`·`track-lock`·`chat` |
| `ts`      | number | CAPTURE epoch ms                                                     |
| `speaker` | string?| active-speaker name / chat sender display name                      |
| `text`    | string?| caption / segment / chat text                                       |
| `detail`  | object?| e.g. active-speaker → `{ hint, isEnd, index }`                       |

`decodeEvent` returns `null` (never throws) when the JSON is malformed, or when
`kind` is not a string or `ts` is not a number.

## Validation — golden-pinned, byte-identity

The vectors in [`golden/`](golden/) pin both directions of both frame kinds:
each carries the encoded **bytes (base64) + sha256 + len** AND the decoded
struct, so `encode(input)` is asserted byte-identical to the golden bytes AND
`decode(goldenBytes)` is asserted to round-trip back to the input struct.

| level | home | command | proves |
|-------|------|---------|--------|
| **contract** | `golden/generate.mjs` | `npx tsx src/contracts/golden/generate.mjs --check` | the committed vectors *are* what the codec emits (tamper-evident, reproducible) |
| **module** | `src/capture-v1-golden.test.ts` | `pnpm --filter @tina/capture-codec test` | `encode`/`decode` ≡ vectors (base64 + sha256 + len + struct round-trip) |
| **module** · REC1 framing | `src/recording-chunk.test.ts` | same `test` | the `recording.v1` `REC1` frame round-trips and is disambiguated from audio (recording.v1's delta, not capture.v1) |

Enforced in CI by `.github/workflows/gates.yml` → `pnpm test` (turbo runs each
package's `test` script, including this one).

## Definition of done

> capture.v1 is green when `pnpm --filter @tina/capture-codec test` passes — the
> golden test asserts byte-identity of every committed vector in both
> directions — and `npx tsx src/contracts/golden/generate.mjs --check` confirms
> the vectors still match the codec.

## Changing the wire

The vectors are the spec. To change a frame layout:

1. Edit the codec ([`../index.ts`](../index.ts)).
2. Regenerate: `npx tsx src/contracts/golden/generate.mjs` (rewrites the JSON).
3. Review the new `sha256`/`len`/`bytes` in the diff — they are the proof the
   change is intentional. `--check` fails in CI until the committed vectors
   match the codec again.

Because a published `.vN` is FROZEN, any wire change is either a new version or
a back-compat-only change (the high-bit named-frame flag is exactly such a
back-compat extension of the original unnamed layout).

## Optional indexed header extension

An ingest receiver may advertise `audio_timeline: "sample-index.v1"` in its ready message. Only then
new senders set track bit 30 and insert a little-endian Float64 safe integer `startSample` after the
capture timestamp. For a named indexed frame the header is track flags (4), epoch ms (8), start sample
(8), UTF-8 name byte length (4), padded UTF-8 name, then PCM. An unnamed indexed header is 20 bytes.
Both original byte layouts and their golden hashes remain unchanged. Receivers reject nonfinite
headers/PCM, fractional/negative indices, invalid PCM alignment and oversized frames.

Indices count 16 kHz source samples, including skipped transport ranges. They are scoped to the
capture session and logical source, not a speaker. A source context restart inside an Extension
session is rebased on its capture clock, preserving the missing interval. Native Capture counts
samples before its bounded send queue so queue drops are visible as holes. The AudioWorklet stamps
render-frame positions on the audio thread; the background relay never replaces those stamps with
send time. Old worklets/servers negotiate the legacy path rather than misreading a new header.

## Optional durable PCM acknowledgement — Desktop

A sender requests `audio_ack=sample-range.v1` and a stable `client_session` nonce in the ingest
URL. `ready` must echo `audio_ack: "sample-range.v1"` and a `capture_session` archive id before
the sender sends PCM. This mode requires indexed frames; the binary layout is unchanged.
Legacy senders that do not opt in retain the existing non-ACK behavior.

After the PCM insert commits with SQLite `synchronous=FULL`, Desktop sends:

```json
{"type":"audio-ack","capture_session":"archive-id","source":0,"start_sample":16000,"end_sample":17600}
```

The end is exclusive. An ACK covers exactly one sent frame, never a cumulative watermark across
Pause gaps or another source. The sender ignores foreign capture ids and unmatched ranges, retains
immutable unacknowledged frames, and replays them after a new negotiated handshake. Desktop maps
`(meeting, client_session)` to a persistent archive session. An exact range with identical Float32
PCM bytes and source capture timestamp is ACKed again without feeding ASR again. Conflicting or
partially overlapping ranges are rejected without ACK. A new client nonce starts a separate archive.

ACK means durable source PCM only. It does not guarantee ASR, speaker attribution, canonical text,
or meeting-memory completion. Pipeline RAM is scoped to each socket; journal range reads remain
available across socket/process restarts. The extension intentionally refuses a server lacking
this capability rather than starting capture with an unprotected PCM queue.

Validation: `clients/extension/src/pcm-replay.test.ts`, `session-lifecycle.test.mjs` and Desktop
`src/pcm-reconnect.test.ts` cover bounded retention, exact ACKs, lost ACK/reconnect, restart,
byte identity, source/session isolation, sample gaps and conflicting replays.
