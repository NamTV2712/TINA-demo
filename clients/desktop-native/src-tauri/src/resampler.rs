use aec_rs_sys::spx_uint32_t;
use anyhow::{ensure, Context, Result};
use std::{ffi::c_void, ptr::NonNull};

// Reuse SpeexDSP: Sherpa's floating-point KissFFT symbols collide with Speex's fixed-point FFT.
extern "C" {
    fn speex_resampler_init(
        channels: spx_uint32_t,
        input_rate: spx_uint32_t,
        output_rate: spx_uint32_t,
        quality: i32,
        error: *mut i32,
    ) -> *mut c_void;
    fn speex_resampler_process_float(
        state: *mut c_void,
        channel: spx_uint32_t,
        input: *const f32,
        input_len: *mut spx_uint32_t,
        output: *mut f32,
        output_len: *mut spx_uint32_t,
    ) -> i32;
    fn speex_resampler_skip_zeros(state: *mut c_void) -> i32;
    fn speex_resampler_destroy(state: *mut c_void);
}

pub(crate) struct Resampler {
    state: NonNull<c_void>,
    input_rate: u32,
}

// Each source owns its resampler behind the capture lane's Mutex; calls require exclusive access.
unsafe impl Send for Resampler {}

impl Resampler {
    pub fn new(input_rate: u32) -> Result<Self> {
        ensure!(input_rate > 0, "Invalid capture sample rate");
        let mut error = 0;
        let state =
            NonNull::new(unsafe { speex_resampler_init(1, input_rate, 16_000, 5, &mut error) })
                .context("Cannot initialize capture resampler")?;
        let resampler = Self { state, input_rate };
        ensure!(
            error == 0,
            "Capture resampler initialization failed: {error}"
        );
        ensure!(
            unsafe { speex_resampler_skip_zeros(state.as_ptr()) } == 0,
            "Cannot align capture resampler"
        );
        Ok(resampler)
    }

    pub fn process(&mut self, input: &[f32]) -> Result<Vec<f32>> {
        ensure!(
            input.iter().all(|sample| sample.is_finite()),
            "Capture contains invalid audio samples"
        );
        let mut input_len = u32::try_from(input.len()).context("Capture packet is too large")?;
        let capacity = (u64::from(input_len) * 16_000).div_ceil(u64::from(self.input_rate)) + 1;
        let mut output_len =
            u32::try_from(capacity).context("Resampled capture packet is too large")?;
        let mut output = vec![0.0; output_len as usize];
        // Speex's float API uses PCM16 units, including in the fixed-point build.
        let scaled_input: Vec<f32> = input.iter().map(|sample| sample * 32768.0).collect();
        let error = unsafe {
            speex_resampler_process_float(
                self.state.as_ptr(),
                0,
                scaled_input.as_ptr(),
                &mut input_len,
                output.as_mut_ptr(),
                &mut output_len,
            )
        };
        ensure!(error == 0, "Capture resampling failed: {error}");
        ensure!(
            input_len as usize == input.len(),
            "Capture resampler did not consume all samples"
        );
        output.truncate(output_len as usize);
        for sample in &mut output {
            *sample /= 32768.0;
        }
        Ok(output)
    }
}

impl Drop for Resampler {
    fn drop(&mut self) {
        unsafe { speex_resampler_destroy(self.state.as_ptr()) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampling_is_continuous_across_packets_and_rejects_zero_rate() {
        assert!(Resampler::new(0).is_err());
        for rate in [16_000, 24_000, 44_100, 48_000] {
            let input: Vec<f32> = (0..rate)
                .map(|i| 0.01 * (i as f32 * 2.0 * std::f32::consts::PI * 440.0 / rate as f32).sin())
                .collect();
            let whole = Resampler::new(rate).unwrap().process(&input).unwrap();
            let mut resampler = Resampler::new(rate).unwrap();
            let packets: Vec<f32> = input
                .chunks(137)
                .flat_map(|packet| resampler.process(packet).unwrap())
                .collect();
            assert_eq!(
                whole, packets,
                "packet boundaries changed audio at {rate} Hz"
            );
            assert!((15_900..=16_001).contains(&whole.len()));
            assert!(whole
                .iter()
                .all(|sample| sample.is_finite() && sample.abs() < 0.02));
            let rms = (whole.iter().map(|sample| sample * sample).sum::<f32>()
                / whole.len() as f32)
                .sqrt();
            assert!(
                (0.006..0.008).contains(&rms),
                "quiet audio gain changed at {rate} Hz: {rms}"
            );
        }
        assert!(Resampler::new(48_000)
            .unwrap()
            .process(&[f32::NAN])
            .is_err());
    }
}
