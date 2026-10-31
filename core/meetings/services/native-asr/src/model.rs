use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use sherpa_onnx::{
    LinearResampler, OfflineQwen3ASRModelConfig, OfflineRecognizer, OfflineRecognizerConfig,
    VadModelConfig, VoiceActivityDetector,
};
use std::{io::Cursor, path::Path};

#[derive(serde::Serialize)]
pub struct AudioDiagnostics {
    input_rms: f64,
    input_peak: f32,
    gain: f32,
    vad_speech_ms: f64,
    vad_segments: usize,
}

fn quiet_gain(rms: f64, peak: f32) -> f32 {
    // Leave near-zero residue alone and cap gain so a click cannot clip the window.
    if rms > 0.0001 && rms < 0.01 && peak > 0.0 {
        (0.01 / rms).min(40.0).min(0.95 / f64::from(peak)).max(1.0) as f32
    } else {
        1.0
    }
}

pub struct Model {
    recognizer: OfflineRecognizer,
    vad: VoiceActivityDetector,
}

impl Model {
    pub fn load(directory: &Path, silero: &Path) -> Result<Self> {
        let file = |name: &str| -> Result<String> {
            let path = directory.join(name);
            if !path.exists() {
                bail!("Missing model file: {}", path.display());
            }
            Ok(path.to_string_lossy().into_owned())
        };
        let mut config = OfflineRecognizerConfig::default();
        config.model_config.qwen3_asr = OfflineQwen3ASRModelConfig {
            conv_frontend: Some(file("conv_frontend.onnx")?),
            encoder: Some(file("encoder.int8.onnx")?),
            decoder: Some(file("decoder.int8.onnx")?),
            tokenizer: Some(file("tokenizer")?),
            max_new_tokens: 256,
            ..Default::default()
        };
        config.model_config.tokens = Some(String::new());
        config.model_config.provider = Some("cpu".into());
        config.model_config.num_threads = 2;
        let recognizer = OfflineRecognizer::create(&config).context("Cannot load Qwen INT8")?;
        if !silero.is_file() {
            bail!("Missing Silero model: {}", silero.display());
        }
        let mut config = VadModelConfig::default();
        config.sample_rate = 16000;
        config.num_threads = 1;
        config.provider = Some("cpu".into());
        config.silero_vad.model = Some(silero.to_string_lossy().into_owned());
        config.silero_vad.threshold = 0.5;
        config.silero_vad.min_silence_duration = 0.35;
        config.silero_vad.min_speech_duration = 0.15;
        config.silero_vad.max_speech_duration = 8.0;
        config.silero_vad.window_size = 512;
        let vad = VoiceActivityDetector::create(&config, 100.0).context("Cannot load Silero")?;
        Ok(Self { recognizer, vad })
    }

    pub fn transcribe(&self, pcm: &[f32], language: &str) -> Result<(Value, AudioDiagnostics)> {
        let rms = if pcm.is_empty() {
            0.0
        } else {
            (pcm.iter().map(|&v| f64::from(v).powi(2)).sum::<f64>() / pcm.len() as f64).sqrt()
        };
        let peak = pcm.iter().copied().map(f32::abs).fold(0.0_f32, f32::max);
        let gain = quiet_gain(rms, peak);
        let mut diagnostics = AudioDiagnostics {
            input_rms: rms,
            input_peak: peak,
            gain,
            vad_speech_ms: 0.0,
            vad_segments: 0,
        };
        let boosted;
        let pcm = if gain > 1.0 {
            boosted = pcm.iter().map(|&v| v * gain).collect::<Vec<_>>();
            &boosted[..]
        } else {
            pcm
        };
        self.vad.reset();
        let duration = pcm.len() as f64 / 16000.0;
        let mut segments = Vec::new();
        // Keep VAD sample offsets: concatenating speech would destroy the original timeline.
        for chunk in pcm.chunks(512) {
            self.vad.accept_waveform(chunk);
        }
        self.vad.flush();
        while let Some(segment) = self.vad.front() {
            diagnostics.vad_segments += 1;
            diagnostics.vad_speech_ms += segment.samples().len() as f64 / 16.0;
            let stream = self.recognizer.create_stream();
            if !language.is_empty() && language != "auto" {
                stream.set_option("language", language);
            }
            stream.accept_waveform(16000, segment.samples());
            self.recognizer.decode(&stream);
            let result = stream
                .get_result()
                .context("Recognizer returned no result")?;
            let start = (segment.start() as f64 / 16000.0).max(0.0);
            let end = (start + segment.samples().len() as f64 / 16000.0).min(duration);
            let text = result.text.trim();
            if !text.is_empty() {
                segments.push(json!({"start":start,"end":end,"text":text}));
            }
            self.vad.pop();
        }
        let text = segments
            .iter()
            .filter_map(|s| s["text"].as_str())
            .collect::<Vec<_>>()
            .join(" ");
        Ok((
            json!({"task":"transcribe","language":if language.is_empty() {"unknown"} else {language},
            "duration":duration,"text":text,"segments":segments}),
            diagnostics,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::quiet_gain;

    #[test]
    fn quiet_gain_preserves_silence_residue_and_normal_levels() {
        for (rms, peak) in [
            (0.0, 0.0),
            (1.0 / 32768.0, 1.0 / 32768.0),
            (0.0001, 0.0005),
            (0.01, 0.1),
            (0.02, 0.2),
        ] {
            assert_eq!(quiet_gain(rms, peak), 1.0);
        }
    }

    #[test]
    fn quiet_gain_is_bounded_and_never_attenuates_transients() {
        assert_eq!(quiet_gain(0.0005, 0.005), 20.0);
        assert_eq!(quiet_gain(0.00011, 0.001), 40.0);
        let gain = quiet_gain(0.0005, 0.8);
        assert!((gain * 0.8 - 0.95).abs() < 0.000001);
        assert_eq!(quiet_gain(0.0005, 1.2), 1.0);
    }
}

pub fn read_wav(bytes: &[u8]) -> Result<Vec<f32>> {
    let mut reader =
        hound::WavReader::new(Cursor::new(bytes)).context("Expected a PCM WAV recording")?;
    let spec = reader.spec();
    if spec.channels == 0 || spec.channels > 8 || !(8000..=192000).contains(&spec.sample_rate) {
        bail!("Unsupported sample rate or channel count");
    }
    let seconds = reader.duration() as f64 / spec.sample_rate as f64;
    if seconds <= 0.0 || seconds > 90.0 {
        bail!("Audio must be between 0 and 90 seconds");
    }
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let scale = 2_f32.powi(i32::from(spec.bits_per_sample) - 1);
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / scale))
                .collect::<Result<_, _>>()?
        }
    };
    if samples.iter().any(|v| !v.is_finite()) {
        bail!("Non-finite audio samples");
    }
    let mono: Vec<f32> = samples
        .chunks_exact(spec.channels as usize)
        .map(|frame| frame.iter().sum::<f32>() / f32::from(spec.channels))
        .collect();
    if spec.sample_rate == 16000 {
        return Ok(mono);
    }
    let resampler =
        LinearResampler::create(spec.sample_rate as i32, 16000).context("Cannot resample audio")?;
    Ok(resampler.resample(&mono, true))
}
