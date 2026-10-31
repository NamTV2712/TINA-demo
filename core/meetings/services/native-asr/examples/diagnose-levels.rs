// Local, opt-in comparison using existing WAVs; never opens capture hardware.
include!("../src/model.rs");

fn vad_ms(model: &Model, pcm: &[f32]) -> f64 {
    model.vad.reset();
    for chunk in pcm.chunks(512) {
        model.vad.accept_waveform(chunk);
    }
    model.vad.flush();
    let mut samples = 0;
    while let Some(segment) = model.vad.front() {
        samples += segment.samples().len();
        model.vad.pop();
    }
    samples as f64 / 16.0
}

fn main() -> Result<()> {
    let manifest = std::env::args()
        .nth(1)
        .context("Usage: diagnose-levels CASES.json")?;
    let cases: Vec<Value> = serde_json::from_slice(&std::fs::read(manifest)?)?;
    let cache = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../deploy/transcription/models/sherpa");
    let model = Model::load(
        &cache.join("sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25"),
        &cache.join("silero_vad.onnx"),
    )?;
    for case in cases {
        let pcm = read_wav(&std::fs::read(
            case["path"].as_str().context("Missing WAV path")?,
        )?)?;
        let raw_vad_ms = vad_ms(&model, &pcm);
        let (result, audio) = model.transcribe(&pcm, "auto")?;
        assert!((1.0..=40.0).contains(&audio.gain));
        assert!((result["duration"].as_f64().unwrap() - pcm.len() as f64 / 16000.0).abs() < 1e-9);
        if case["role"] == "silence" || case["role"] == "control" {
            assert!(
                result["text"].as_str().unwrap().is_empty(),
                "Control produced text: {}",
                case["id"]
            );
        }
        let direct = if case["direct"] == true {
            let stream = model.recognizer.create_stream();
            stream.accept_waveform(16000, &pcm);
            model.recognizer.decode(&stream);
            Some(stream.get_result().context("No direct ASR result")?.text)
        } else {
            None
        };
        println!(
            "{}",
            json!({"case":case,"audio":audio,"raw_vad_ms":raw_vad_ms,
            "result":result,"direct_text":direct})
        );
    }
    Ok(())
}
