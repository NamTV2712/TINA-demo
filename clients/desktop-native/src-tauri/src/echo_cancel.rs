use crate::capture::CapturePcm;
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

#[cfg(feature = "speex-aec")]
#[derive(Default, Clone, Copy, Debug)]
pub(crate) struct EchoStats {
    pub processed_blocks: u64,
    pub residual_blocks: u64,
    pub bypassed_samples: u64,
    pub mic_clipped_samples: u64,
}

#[cfg(feature = "speex-aec")]
mod enabled {
    use super::*;
    use aec_rs_sys::{
        speex_echo_cancellation, speex_echo_ctl, speex_echo_state_destroy, speex_echo_state_init,
        speex_echo_state_reset, speex_preprocess_ctl, speex_preprocess_run,
        speex_preprocess_state_destroy, speex_preprocess_state_init, SPEEX_ECHO_SET_SAMPLING_RATE,
        SPEEX_PREPROCESS_SET_DENOISE, SPEEX_PREPROCESS_SET_ECHO_STATE,
        SPEEX_PREPROCESS_SET_NOISE_SUPPRESS,
    };
    use anyhow::{bail, Result};
    use std::{ffi::c_void, ptr::NonNull};

    const RATE: usize = 16_000;
    const FRAME: usize = 160; // 10 ms at 16 kHz.
    const FILTER: i32 = 4_800; // 300 ms far-end history.
    const PAIR_WAIT: Duration = Duration::from_millis(120);
    const REF_HISTORY: i64 = RATE as i64 * 2;

    #[derive(Default)]
    struct HighPass {
        previous_input: f32,
        previous_output: f32,
    }

    impl HighPass {
        fn sample(&mut self, input: f32) -> f32 {
            if !input.is_finite() {
                *self = Self::default();
                return 0.0;
            }
            let alpha = 1.0 / (1.0 + 2.0 * std::f32::consts::PI * 70.0 / RATE as f32);
            let output = alpha * (self.previous_output + input - self.previous_input);
            self.previous_input = input;
            self.previous_output = output;
            output
        }
    }

    struct Speex {
        echo: NonNull<aec_rs_sys::SpeexEchoState>,
        preprocessor: Option<NonNull<aec_rs_sys::SpeexPreprocessState>>,
        high_pass: Option<[HighPass; 2]>,
    }

    impl Speex {
        fn new(residual_suppression: bool, mic_cleanup: bool) -> Result<Self> {
            let state = NonNull::new(unsafe { speex_echo_state_init(FRAME as i32, FILTER) })
                .ok_or_else(|| anyhow::anyhow!("Speex AEC state initialization failed"))?;
            if !Self::set_rate(state) {
                unsafe {
                    speex_echo_state_destroy(state.as_ptr());
                }
                bail!("Speex AEC rejected the 16 kHz sample rate");
            }
            let preprocessor = if residual_suppression {
                match Self::new_preprocessor(state, mic_cleanup) {
                    Ok(preprocessor) => Some(preprocessor),
                    Err(error) => {
                        unsafe { speex_echo_state_destroy(state.as_ptr()) };
                        return Err(error);
                    }
                }
            } else {
                None
            };
            Ok(Self {
                echo: state,
                preprocessor,
                high_pass: mic_cleanup.then(|| [HighPass::default(), HighPass::default()]),
            })
        }

        fn set_rate(state: NonNull<aec_rs_sys::SpeexEchoState>) -> bool {
            let mut rate = RATE as i32;
            unsafe {
                speex_echo_ctl(
                    state.as_ptr(),
                    SPEEX_ECHO_SET_SAMPLING_RATE as i32,
                    (&mut rate as *mut i32).cast::<c_void>(),
                ) == 0
            }
        }

        fn reset(&mut self) {
            if let Some(filters) = &mut self.high_pass {
                *filters = [HighPass::default(), HighPass::default()];
            }
            unsafe {
                speex_echo_state_reset(self.echo.as_ptr());
            }
            let _ = Self::set_rate(self.echo);
        }

        fn cancel(&mut self, mic: &[f32; FRAME], far: &[f32; FRAME]) -> [f32; FRAME] {
            let (mic, far) = if let Some(filters) = &mut self.high_pass {
                // Filter both inputs equally so the AEC reference stays consistent with the mic.
                (
                    mic.map(|sample| to_i16(filters[0].sample(sample))),
                    far.map(|sample| to_i16(filters[1].sample(sample))),
                )
            } else {
                (mic.map(to_i16), far.map(to_i16))
            };
            let mut out = [0_i16; FRAME];
            unsafe {
                speex_echo_cancellation(
                    self.echo.as_ptr(),
                    mic.as_ptr(),
                    far.as_ptr(),
                    out.as_mut_ptr(),
                );
                if let Some(preprocessor) = self.preprocessor {
                    speex_preprocess_run(preprocessor.as_ptr(), out.as_mut_ptr());
                }
            }
            out.map(|sample| sample as f32 / 32768.0)
        }

        fn new_preprocessor(
            echo: NonNull<aec_rs_sys::SpeexEchoState>,
            mic_cleanup: bool,
        ) -> Result<NonNull<aec_rs_sys::SpeexPreprocessState>> {
            let state =
                NonNull::new(unsafe { speex_preprocess_state_init(FRAME as i32, RATE as i32) })
                    .ok_or_else(|| {
                        anyhow::anyhow!("Speex residual suppressor initialization failed")
                    })?;
            // Limit noise attenuation to 3 dB to avoid aggressively suppressing quiet speech.
            let configured = [
                (SPEEX_PREPROCESS_SET_DENOISE, i32::from(mic_cleanup)),
                (SPEEX_PREPROCESS_SET_NOISE_SUPPRESS, -3),
                // AGC/VAD stay disabled by default; fixed-point Speex has no AGC control.
            ]
            .into_iter()
            .all(|(request, mut value)| unsafe {
                speex_preprocess_ctl(
                    state.as_ptr(),
                    request as i32,
                    (&mut value as *mut i32).cast(),
                ) == 0
            }) && unsafe {
                speex_preprocess_ctl(
                    state.as_ptr(),
                    SPEEX_PREPROCESS_SET_ECHO_STATE as i32,
                    echo.as_ptr().cast::<c_void>(),
                ) == 0
            };
            if !configured {
                unsafe { speex_preprocess_state_destroy(state.as_ptr()) };
                bail!("Speex residual suppressor configuration failed");
            }
            Ok(state)
        }

        fn has_residual_suppression(&self) -> bool {
            self.preprocessor.is_some()
        }
    }

    impl Drop for Speex {
        fn drop(&mut self) {
            unsafe {
                if let Some(preprocessor) = self.preprocessor {
                    speex_preprocess_state_destroy(preprocessor.as_ptr());
                }
                speex_echo_state_destroy(self.echo.as_ptr());
            }
        }
    }

    fn to_i16(value: f32) -> i16 {
        let value = value.clamp(-1.0, 1.0) as f64;
        if value < 0.0 {
            (value * 32768.0).round().max(-32768.0) as i16
        } else {
            (value * 32767.0).round().min(32767.0) as i16
        }
    }

    struct Block {
        mic: [f32; FRAME],
        far: [f32; FRAME],
        mic_valid: [bool; FRAME],
        far_valid: [bool; FRAME],
        mic_index: [u64; FRAME],
        mic_seen: Option<Instant>,
        overlap: bool,
    }

    impl Block {
        fn new() -> Self {
            Self {
                mic: [0.0; FRAME],
                far: [0.0; FRAME],
                mic_valid: [false; FRAME],
                far_valid: [false; FRAME],
                mic_index: [0; FRAME],
                mic_seen: None,
                overlap: false,
            }
        }
        fn has_mic(&self) -> bool {
            self.mic_valid.iter().any(|value| *value)
        }
    }

    /// Uses the system-output channel as far-end reference and processes only aligned mic blocks.
    /// If the reference is late or missing, the original mic samples pass through unchanged.
    pub struct EchoAligner {
        speex: Speex,
        blocks: BTreeMap<i64, Block>,
        last_processed: Option<i64>,
        latest_far_sample: Option<i64>,
        stats: EchoStats,
    }

    impl EchoAligner {
        pub fn new(enabled: bool, mic_cleanup: bool) -> Result<Self> {
            Ok(Self {
                speex: Speex::new(enabled, enabled && mic_cleanup)?,
                blocks: BTreeMap::new(),
                last_processed: None,
                latest_far_sample: None,
                stats: EchoStats::default(),
            })
        }

        pub fn reset_epoch(&mut self, residual_suppression: bool, mic_cleanup: bool) -> Result<()> {
            let stats = self.stats;
            *self = Self::new(residual_suppression, mic_cleanup)?;
            self.stats = stats;
            Ok(())
        }

        pub fn push_reference(&mut self, frame: &CapturePcm) {
            self.insert(frame, false);
            let end = abs_sample(frame.timestamp_ms) + frame.samples.len() as i64;
            self.latest_far_sample = Some(self.latest_far_sample.map_or(end, |old| old.max(end)));
            self.prune();
        }

        pub fn push_microphone(&mut self, frame: &CapturePcm) {
            self.stats.mic_clipped_samples += frame
                .samples
                .iter()
                .filter(|sample| sample.abs() >= 32767.0 / 32768.0)
                .count() as u64;
            self.insert(frame, true);
        }

        pub fn drain(&mut self, now: Instant, force: bool) -> Vec<CapturePcm> {
            let keys: Vec<i64> = self
                .blocks
                .iter()
                .filter_map(|(key, block)| block.has_mic().then_some(*key))
                .collect();
            let mut output = Vec::new();
            for key in keys {
                let Some(block) = self.blocks.get(&key) else {
                    continue;
                };
                let expired = force
                    || block
                        .mic_seen
                        .is_some_and(|at| now.duration_since(at) >= PAIR_WAIT);
                let contiguous =
                    (1..FRAME).all(|i| block.mic_index[i] == block.mic_index[0] + i as u64);
                if block.mic_valid.iter().all(|v| *v)
                    && block.far_valid.iter().all(|v| *v)
                    && contiguous
                    && !block.overlap
                {
                    let mic = block.mic;
                    let far = block.far;
                    let source_sample = block.mic_index[0];
                    if self.last_processed.is_some_and(|last| last + 1 != key) {
                        self.speex.reset();
                    }
                    let cleaned = self.speex.cancel(&mic, &far);
                    if self.speex.has_residual_suppression() {
                        self.stats.residual_blocks += 1;
                    }
                    output.push(CapturePcm {
                        channel: 1000,
                        name: "You",
                        timestamp_ms: key as f64 * FRAME as f64 * 1000.0 / RATE as f64,
                        start_sample: Some(source_sample),
                        samples: cleaned.to_vec(),
                    });
                    self.stats.processed_blocks += 1;
                    self.last_processed = Some(key);
                    self.blocks.remove(&key);
                } else if expired {
                    let raw = pass_mic_block(key, block);
                    self.stats.bypassed_samples += raw
                        .iter()
                        .map(|frame| frame.samples.len() as u64)
                        .sum::<u64>();
                    self.speex.reset();
                    self.last_processed = None;
                    output.extend(raw);
                    self.blocks.remove(&key);
                } else {
                    break;
                }
            }
            output
        }

        pub fn stats(&self) -> EchoStats {
            self.stats
        }

        fn insert(&mut self, frame: &CapturePcm, microphone: bool) {
            let start = abs_sample(frame.timestamp_ms);
            let mut offset = 0;
            while offset < frame.samples.len() {
                let absolute = start + offset as i64;
                let key = absolute.div_euclid(FRAME as i64);
                let position = absolute.rem_euclid(FRAME as i64) as usize;
                let count = (FRAME - position).min(frame.samples.len() - offset);
                let block = self.blocks.entry(key).or_insert_with(Block::new);
                let positions = position..position + count;
                if microphone {
                    if block.mic_valid[positions.clone()].iter().any(|v| *v) {
                        block.overlap = true;
                    }
                    block.mic[positions.clone()]
                        .copy_from_slice(&frame.samples[offset..offset + count]);
                    block.mic_valid[positions.clone()].fill(true);
                    if let Some(index) = frame.start_sample {
                        for i in 0..count {
                            block.mic_index[position + i] = index + offset as u64 + i as u64;
                        }
                    } else {
                        block.overlap = true;
                    }
                    block.mic_seen.get_or_insert_with(Instant::now);
                } else {
                    if block.far_valid[positions.clone()].iter().any(|v| *v) {
                        block.overlap = true;
                    }
                    block.far[positions.clone()]
                        .copy_from_slice(&frame.samples[offset..offset + count]);
                    block.far_valid[positions].fill(true);
                }
                offset += count;
            }
        }

        fn prune(&mut self) {
            let Some(end) = self.latest_far_sample else {
                return;
            };
            let oldest = (end - REF_HISTORY).div_euclid(FRAME as i64);
            self.blocks
                .retain(|key, block| block.has_mic() || *key >= oldest);
        }
    }

    fn pass_mic_block(key: i64, block: &Block) -> Vec<CapturePcm> {
        let mut frames = Vec::new();
        let mut i = 0;
        while i < FRAME {
            if !block.mic_valid[i] {
                i += 1;
                continue;
            }
            let start = i;
            while i < FRAME
                && block.mic_valid[i]
                && (i == start || block.mic_index[i] == block.mic_index[i - 1] + 1)
            {
                i += 1;
            }
            frames.push(CapturePcm {
                channel: 1000,
                name: "You",
                timestamp_ms: (key * FRAME as i64 + start as i64) as f64 * 1000.0 / RATE as f64,
                start_sample: Some(block.mic_index[start]),
                samples: block.mic[start..i].to_vec(),
            });
        }
        frames
    }

    fn abs_sample(timestamp_ms: f64) -> i64 {
        (timestamp_ms * RATE as f64 / 1000.0).round() as i64
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn high_pass_removes_dc_and_rumble_but_preserves_speech_band() {
            fn gain(frequency: f32) -> f32 {
                let mut filter = HighPass::default();
                let mut before = 0.0;
                let mut after = 0.0;
                for i in 0..RATE {
                    let sample = 0.01
                        * (2.0 * std::f32::consts::PI * frequency * i as f32 / RATE as f32).sin();
                    let output = filter.sample(sample);
                    if i > RATE / 2 {
                        before += sample * sample;
                        after += output * output;
                    }
                }
                (after / before).sqrt()
            }
            assert!(gain(20.0) < 0.3);
            assert!(gain(250.0) > 0.94);
            let mut filter = HighPass::default();
            for _ in 0..RATE {
                filter.sample(0.1);
            }
            assert!(filter.sample(0.1).abs() < 0.00001);
            assert_eq!(filter.sample(f32::NAN), 0.0);
            assert!(filter.sample(0.01).is_finite());
        }

        #[test]
        fn cleanup_sets_actual_speex_controls_and_keeps_agc_and_vad_off() {
            use aec_rs_sys::{
                SPEEX_PREPROCESS_GET_DENOISE, SPEEX_PREPROCESS_GET_NOISE_SUPPRESS,
                SPEEX_PREPROCESS_GET_VAD,
            };
            for cleanup in [false, true] {
                let speex = Speex::new(true, cleanup).unwrap();
                for (request, expected) in [
                    (SPEEX_PREPROCESS_GET_DENOISE, i32::from(cleanup)),
                    (SPEEX_PREPROCESS_GET_NOISE_SUPPRESS, -3),
                    (SPEEX_PREPROCESS_GET_VAD, 0),
                ] {
                    let mut actual = -999_i32;
                    assert_eq!(
                        unsafe {
                            speex_preprocess_ctl(
                                speex.preprocessor.unwrap().as_ptr(),
                                request as i32,
                                (&mut actual as *mut i32).cast(),
                            )
                        },
                        0
                    );
                    assert_eq!(actual, expected);
                }
            }
            let linear = EchoAligner::new(false, true).unwrap();
            assert!(linear.speex.high_pass.is_none());
            assert!(linear.speex.preprocessor.is_none());
        }

        #[test]
        fn cleanup_reduces_stationary_noise_and_retains_quiet_voiced_signal() {
            let mut speex = Speex::new(true, true).unwrap();
            let mut random = 0x1234_5678_u32;
            let mut noise_in = 0.0;
            let mut noise_out = 0.0;
            let mut voice_in = 0.0;
            let mut voice_out = 0.0;
            for block in 0..500 {
                let mic = std::array::from_fn(|offset| {
                    random ^= random << 13;
                    random ^= random >> 17;
                    random ^= random << 5;
                    let noise = ((random >> 8) as f32 / 16_777_215.0 - 0.5) * 0.004;
                    let t = (block * FRAME + offset) as f32 / RATE as f32;
                    let voice = if block >= 300 {
                        0.008 * (2.0 * std::f32::consts::PI * 220.0 * t).sin()
                            + 0.004 * (2.0 * std::f32::consts::PI * 660.0 * t).sin()
                    } else {
                        0.0
                    };
                    noise + voice
                });
                let output = speex.cancel(&mic, &[0.0; FRAME]);
                assert!(output
                    .iter()
                    .all(|value| value.is_finite() && value.abs() <= 1.0));
                let input_energy = mic.iter().map(|sample| sample * sample).sum::<f32>();
                let output_energy = output.iter().map(|sample| sample * sample).sum::<f32>();
                if (200..300).contains(&block) {
                    noise_in += input_energy;
                    noise_out += output_energy;
                } else if block >= 310 {
                    voice_in += input_energy;
                    voice_out += output_energy;
                }
            }
            assert!(
                noise_out < noise_in * 0.8,
                "noise energy ratio {}",
                noise_out / noise_in
            );
            assert!(
                voice_out > voice_in * 0.25,
                "quiet voiced energy ratio {}",
                voice_out / voice_in
            );
        }

        #[test]
        fn cleanup_preserves_timeline_raw_input_and_fallback_across_pause() {
            let mut aec = EchoAligner::new(true, true).unwrap();
            let mic = frame(1000, 1000.0, Some(900), 0.02);
            aec.push_reference(&frame(999, 1000.0, None, 0.0));
            aec.push_microphone(&mic);
            let output = aec.drain(Instant::now(), false);
            assert_eq!(mic.samples, vec![0.02; FRAME]);
            assert_eq!(output.len(), 1);
            assert_eq!(output[0].start_sample, Some(900));
            assert_eq!(output[0].timestamp_ms, 1000.0);
            assert_eq!(output[0].samples.len(), FRAME);
            aec.push_microphone(&frame(1000, 1010.0, Some(1060), 0.04));
            aec.reset_epoch(true, true).unwrap();
            assert!(aec.drain(Instant::now(), true).is_empty());
            assert_eq!(aec.stats().processed_blocks, 1);
            aec.push_microphone(&frame(1000, 1020.0, Some(1220), 1.0));
            let fallback = aec.drain(Instant::now() + PAIR_WAIT, false);
            assert_eq!(fallback[0].samples, vec![1.0; FRAME]);
            assert_eq!(fallback[0].start_sample, Some(1220));
            assert_eq!(aec.stats().bypassed_samples, FRAME as u64);
            assert_eq!(aec.stats().mic_clipped_samples, FRAME as u64);
        }

        fn frame(channel: i32, timestamp_ms: f64, index: Option<u64>, value: f32) -> CapturePcm {
            CapturePcm {
                channel,
                name: if channel == 999 {
                    "System audio"
                } else {
                    "You"
                },
                timestamp_ms,
                start_sample: index,
                samples: vec![value; FRAME],
            }
        }

        fn delayed_echo_result(residual_suppression: bool, mic_cleanup: bool) -> (f32, EchoStats) {
            const FRAMES: usize = 500;
            const DELAY: usize = 320;
            let mut state = 0x1234_5678u32;
            let mut far = vec![0.0_f32; FRAMES * FRAME];
            for sample in &mut far {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                *sample = (((state >> 8) as f32 / 16_777_215.0) - 0.5) * 0.4;
            }

            let mut aec = EchoAligner::new(residual_suppression, mic_cleanup).unwrap();
            let mut input_energy = 0.0;
            let mut output_energy = 0.0;
            for block in 0..FRAMES {
                let start = block * FRAME;
                let timestamp_ms = 1_000.0 + block as f64 * 10.0;
                aec.push_reference(&CapturePcm {
                    channel: 999,
                    name: "System audio",
                    timestamp_ms,
                    start_sample: None,
                    samples: far[start..start + FRAME].to_vec(),
                });
                let mic: Vec<f32> = (start..start + FRAME)
                    .map(|i| {
                        if i >= DELAY {
                            far[i - DELAY] * 0.65
                        } else {
                            0.0
                        }
                    })
                    .collect();
                aec.push_microphone(&CapturePcm {
                    channel: 1000,
                    name: "You",
                    timestamp_ms,
                    start_sample: Some(start as u64),
                    samples: mic.clone(),
                });
                let output = aec.drain(Instant::now(), false);
                assert_eq!(output.len(), 1);
                if block >= 200 {
                    input_energy += mic.iter().map(|sample| sample * sample).sum::<f32>();
                    output_energy += output[0]
                        .samples
                        .iter()
                        .map(|sample| sample * sample)
                        .sum::<f32>();
                }
            }

            ((output_energy / input_energy).sqrt(), aec.stats())
        }

        #[test]
        fn aligned_reference_produces_same_length_sample_indexed_mic_frame() {
            let mut aec = EchoAligner::new(false, false).unwrap();
            aec.push_reference(&frame(999, 1000.0, None, 0.1));
            aec.push_microphone(&frame(1000, 1000.0, Some(0), 0.1));
            let output = aec.drain(Instant::now(), false);
            assert_eq!(output.len(), 1);
            assert_eq!(output[0].start_sample, Some(0));
            assert_eq!(output[0].samples.len(), FRAME);
            assert!(output[0].samples.iter().all(|sample| sample.is_finite()));
            assert_eq!(aec.stats().processed_blocks, 1);
        }

        #[test]
        fn missing_reference_bypasses_mic_without_losing_samples() {
            let mut aec = EchoAligner::new(false, false).unwrap();
            aec.push_microphone(&frame(1000, 1000.0, Some(0), 0.25));
            let output = aec.drain(Instant::now() + PAIR_WAIT, false);
            assert_eq!(output.len(), 1);
            assert!(output[0].samples.iter().all(|sample| *sample == 0.25));
            assert_eq!(aec.stats().bypassed_samples, FRAME as u64);
        }

        #[test]
        fn reduces_delayed_synthetic_far_end_echo() {
            let (residual_ratio, stats) = delayed_echo_result(false, false);
            assert!(
                residual_ratio < 0.5,
                "synthetic echo residual ratio {residual_ratio:.3}"
            );
            assert_eq!(stats.residual_blocks, 0);
        }

        #[test]
        fn optional_residual_suppression_runs_after_linear_aec() {
            let (residual_ratio, stats) = delayed_echo_result(true, false);
            assert!(
                residual_ratio < 0.5,
                "synthetic residual ratio {residual_ratio:.3}"
            );
            assert_eq!(stats.residual_blocks, 500);
        }

        #[test]
        fn cleanup_preserves_delayed_echo_cancellation() {
            let (residual_ratio, stats) = delayed_echo_result(true, true);
            assert!(
                residual_ratio < 0.5,
                "echo residual ratio {residual_ratio:.3}"
            );
            assert_eq!(stats.processed_blocks, 500);
            assert_eq!(stats.residual_blocks, 500);
        }

        #[test]
        fn cleanup_retains_near_end_voice_during_synthetic_double_talk() {
            let mut random = 0x1234_5678_u32;
            let far: Vec<f32> = (0..500 * FRAME)
                .map(|_| {
                    random ^= random << 13;
                    random ^= random >> 17;
                    random ^= random << 5;
                    ((random >> 8) as f32 / 16_777_215.0 - 0.5) * 0.4
                })
                .collect();
            let mut speex = Speex::new(true, true).unwrap();
            let mut sine = 0.0;
            let mut cosine = 0.0;
            let mut samples = 0;
            for block in 0..500 {
                let phase = |i: usize| 2.0 * std::f32::consts::PI * 440.0 * i as f32 / RATE as f32;
                let mic = std::array::from_fn(|offset| {
                    let i = block * FRAME + offset;
                    let echo = if i >= 320 { far[i - 320] * 0.65 } else { 0.0 };
                    echo + if block >= 300 {
                        0.02 * phase(i).sin()
                    } else {
                        0.0
                    }
                });
                let reference = std::array::from_fn(|offset| far[block * FRAME + offset]);
                let output = speex.cancel(&mic, &reference);
                if block >= 400 {
                    for (offset, sample) in output.iter().enumerate() {
                        sine += sample * phase(block * FRAME + offset).sin();
                        cosine += sample * phase(block * FRAME + offset).cos();
                        samples += 1;
                    }
                }
            }
            let retained_amplitude = 2.0 * (sine * sine + cosine * cosine).sqrt() / samples as f32;
            assert!(
                retained_amplitude > 0.01,
                "near-end amplitude {retained_amplitude}"
            );
        }
    }
}

#[cfg(feature = "speex-aec")]
pub use enabled::EchoAligner;
