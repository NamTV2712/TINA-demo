mod model;

use axum::{
    extract::{DefaultBodyLimit, Multipart, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore};

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn elapsed(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}
fn bounded(value: f64) -> Option<f64> {
    (value.is_finite() && (0.0..=3_600_000.0).contains(&value)).then_some(value)
}

#[derive(Clone, Serialize)]
struct Sample {
    request_id: String,
    at_ms: u64,
    source: String,
    http_status: u16,
    audio_ms: Option<f64>,
    capture_ms: Option<f64>,
    queue_ms: Option<f64>,
    inference_ms: Option<f64>,
    total_ms: Option<f64>,
}
struct Metrics {
    started: u64,
    total: u64,
    errors: u64,
    recent: VecDeque<Sample>,
}
impl Metrics {
    fn record(&mut self, sample: Sample) {
        self.total += 1;
        self.errors += u64::from(sample.http_status >= 400);
        // Only IDs, timings and status cross the diagnostics seam, never recognized text.
        eprintln!("{}", json!({"event":"asr_request","sample":sample}));
        self.recent.push_front(sample);
        self.recent.truncate(100);
    }
    fn percentile(&self, field: fn(&Sample) -> Option<f64>) -> Value {
        let mut values: Vec<f64> = self.recent.iter().filter_map(field).collect();
        values.sort_by(f64::total_cmp);
        let p = |fraction: f64| {
            values.get(((values.len() as f64 * fraction).ceil() as usize).saturating_sub(1))
        };
        json!({"count":values.len(),"p50_ms":p(0.5),"p95_ms":p(0.95)})
    }
}
#[derive(Clone)]
struct AppState {
    sender: mpsc::Sender<Job>,
    admission: Arc<Semaphore>,
    metrics: Arc<Mutex<Metrics>>,
    active: Arc<AtomicUsize>,
    waiting: Arc<AtomicUsize>,
}
struct Job {
    audio: Vec<u8>,
    language: String,
    sample: Sample,
    received: Instant,
    queued: Instant,
    reply: oneshot::Sender<(StatusCode, Value, Sample)>,
    _permit: OwnedSemaphorePermit,
}

async fn status(State(state): State<AppState>) -> Json<Value> {
    let m = state.metrics.lock().unwrap();
    Json(json!({"version":"asr-status.v1","started_at_ms":m.started,
        "model":{"asr_model":"Qwen3-ASR-0.6B-INT8","alias":"custom","vad_model":"silero-vad",
            "device":"cpu","requested_device":"cpu"},
        "queue":{"active":state.active.load(Ordering::Relaxed),"waiting":state.waiting.load(Ordering::Relaxed),
            "capacity":4,"wait_limit_ms":10000},
        "requests":{"total":m.total,"errors":m.errors},
        "latency":{"audio_ms":m.percentile(|s|s.audio_ms),"capture_ms":m.percentile(|s|s.capture_ms),
            "queue_ms":m.percentile(|s|s.queue_ms),"inference_ms":m.percentile(|s|s.inference_ms),
            "total_ms":m.percentile(|s|s.total_ms)},"recent":m.recent}))
}

fn response(status: StatusCode, body: Value, sample: &Sample) -> Response {
    let mut response = (status, Json(body)).into_response();
    let h = response.headers_mut();
    h.insert("x-asr-request-id", sample.request_id.parse().unwrap());
    h.insert("cache-control", "no-store".parse().unwrap());
    let fields = [
        ("asr_queue", sample.queue_ms),
        ("asr_inference", sample.inference_ms),
        ("asr_total", sample.total_ms),
    ];
    let timing = fields
        .iter()
        .filter_map(|(k, v)| v.map(|ms| format!("{k};dur={ms:.3}")))
        .collect::<Vec<_>>()
        .join(", ");
    if !timing.is_empty() {
        h.insert("server-timing", timing.parse().unwrap());
    }
    response
}

async fn transcribe(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Response {
    let received = Instant::now();
    let header = |key| headers.get(key).and_then(|v| v.to_str().ok()).unwrap_or("");
    let mut sample = Sample {
        request_id: uuid::Uuid::parse_str(header("x-asr-request-id"))
            .unwrap_or_else(|_| uuid::Uuid::new_v4())
            .to_string(),
        at_ms: now(),
        source: match header("x-asr-source") {
            s @ ("extension" | "meeting-bot" | "dictation") => s,
            _ => "unknown",
        }
        .into(),
        http_status: 200,
        audio_ms: None,
        capture_ms: header("x-asr-capture-ms").parse().ok().and_then(bounded),
        queue_ms: None,
        inference_ms: None,
        total_ms: None,
    };
    let fail = |status: StatusCode, message: &str, mut s: Sample| {
        s.http_status = status.as_u16();
        s.total_ms = bounded(elapsed(received));
        state.metrics.lock().unwrap().record(s.clone());
        response(status, json!({"detail":message}), &s)
    };
    let mut audio = None;
    let mut language = String::new();
    let mut format = "json".to_owned();
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(_) => {
                return fail(
                    StatusCode::BAD_REQUEST,
                    "Invalid multipart recording",
                    sample,
                )
            }
        };
        let name = field.name().unwrap_or("").to_owned();
        if name == "file" {
            if audio.is_some() {
                return fail(StatusCode::BAD_REQUEST, "Provide one recording", sample);
            }
            match field.bytes().await {
                Ok(bytes) if bytes.len() <= 25 * 1024 * 1024 => audio = Some(bytes.to_vec()),
                _ => {
                    return fail(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "Recording exceeds 25 MiB",
                        sample,
                    )
                }
            }
        } else {
            let value = match field.bytes().await {
                Ok(bytes) if bytes.len() <= 4096 => String::from_utf8_lossy(&bytes).into_owned(),
                _ => {
                    return fail(
                        StatusCode::BAD_REQUEST,
                        "Invalid transcription option",
                        sample,
                    )
                }
            };
            match name.as_str() {
                "model" if value != "custom" && value != "Qwen3-ASR-0.6B-INT8" => {
                    return fail(
                        StatusCode::BAD_REQUEST,
                        "This endpoint serves Qwen3-ASR-0.6B INT8",
                        sample,
                    )
                }
                "language" => {
                    language = match value.trim() {
                        "vi" => "Vietnamese",
                        "en" => "English",
                        v => v,
                    }
                    .into()
                }
                "response_format" => format = value,
                _ => {} // OpenAI prompt is accepted; prior transcript is not a hotword list.
            }
        }
    }
    if !["json", "verbose_json", "text"].contains(&format.as_str()) {
        return fail(
            StatusCode::BAD_REQUEST,
            "Unsupported response format",
            sample,
        );
    }
    if language.len() > 64
        || !language
            .bytes()
            .all(|c| c.is_ascii_alphabetic() || c == b'-' || c == b' ')
    {
        return fail(StatusCode::BAD_REQUEST, "Invalid language hint", sample);
    }
    let Some(audio) = audio else {
        return fail(StatusCode::BAD_REQUEST, "Missing WAV recording", sample);
    };
    let Ok(permit) = state.admission.clone().try_acquire_owned() else {
        return fail(StatusCode::TOO_MANY_REQUESTS, "ASR queue is full", sample);
    };
    let (tx, rx) = oneshot::channel();
    let job = Job {
        audio,
        language,
        sample: sample.clone(),
        received,
        queued: Instant::now(),
        reply: tx,
        _permit: permit,
    };
    state.waiting.fetch_add(1, Ordering::Relaxed);
    if state.sender.try_send(job).is_err() {
        state.waiting.fetch_sub(1, Ordering::Relaxed);
        return fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "ASR worker unavailable",
            sample,
        );
    }
    match rx.await {
        Ok((status, body, timing)) => {
            if status != StatusCode::OK {
                return response(status, body, &timing);
            }
            if format == "text" {
                let mut r = response(status, body.clone(), &timing);
                *r.body_mut() =
                    axum::body::Body::from(body["text"].as_str().unwrap_or("").to_owned());
                r.headers_mut()
                    .insert("content-type", "text/plain; charset=utf-8".parse().unwrap());
                r
            } else {
                response(
                    status,
                    if format == "verbose_json" {
                        body
                    } else {
                        json!({"text":body["text"]})
                    },
                    &timing,
                )
            }
        }
        Err(_) => {
            sample.total_ms = bounded(elapsed(received));
            fail(
                StatusCode::SERVICE_UNAVAILABLE,
                "ASR worker stopped",
                sample,
            )
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let cache = root.join("deploy/transcription/models/sherpa");
    let directory = std::env::var_os("TINA_SHERPA_MODEL_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| cache.join("sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25"));
    let silero = std::env::var_os("TINA_SILERO_MODEL")
        .map(PathBuf::from)
        .unwrap_or_else(|| cache.join("silero_vad.onnx"));
    eprintln!("Loading Qwen INT8 + Silero on CPU (2 ASR threads)");
    let model = model::Model::load(&directory, &silero)?;
    let (sender, mut receiver) = mpsc::channel::<Job>(4);
    let state = AppState {
        sender,
        admission: Arc::new(Semaphore::new(4)),
        metrics: Arc::new(Mutex::new(Metrics {
            started: now(),
            total: 0,
            errors: 0,
            recent: VecDeque::new(),
        })),
        active: Arc::new(AtomicUsize::new(0)),
        waiting: Arc::new(AtomicUsize::new(0)),
    };
    let worker = state.clone();
    std::thread::spawn(move || {
        while let Some(mut job) = receiver.blocking_recv() {
            worker.waiting.fetch_sub(1, Ordering::Relaxed);
            job.sample.queue_ms = bounded(elapsed(job.queued));
            let (status, body) = if job.reply.is_closed() {
                (
                    StatusCode::from_u16(499).unwrap(),
                    json!({"detail":"Client disconnected before inference"}),
                )
            } else if job.queued.elapsed() > Duration::from_secs(10) {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    json!({"detail":"ASR queue wait expired"}),
                )
            } else {
                worker.active.store(1, Ordering::Relaxed);
                let result = model::read_wav(&job.audio);
                let result = match result {
                    Ok(pcm) => {
                        job.sample.audio_ms = bounded(pcm.len() as f64 / 16.0);
                        let started = Instant::now();
                        let result = model.transcribe(&pcm, &job.language).map(|(body, audio)| {
                            eprintln!("{}", json!({"event":"asr_audio", "request_id":job.sample.request_id, "audio":audio}));
                            body
                        });
                        job.sample.inference_ms = bounded(elapsed(started));
                        result.map_err(|_| (StatusCode::BAD_GATEWAY, "Sherpa inference failed"))
                    }
                    Err(_) => Err((
                        StatusCode::UNSUPPORTED_MEDIA_TYPE,
                        "Expected finite PCM WAV audio, 0–90 seconds",
                    )),
                };
                worker.active.store(0, Ordering::Relaxed);
                match result {
                    Ok(v) => (StatusCode::OK, v),
                    Err((s, m)) => (s, json!({"detail":m})),
                }
            };
            job.sample.http_status = status.as_u16();
            job.sample.total_ms = bounded(elapsed(job.received));
            worker.metrics.lock().unwrap().record(job.sample.clone());
            let _ = job.reply.send((status, body, job.sample));
        }
    });
    let app = Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({"status":"ok","device":"cpu",
        "models_loaded":["custom"],"vad_model":"silero-vad"}))
            }),
        )
        .route(
            "/v1/models",
            get(|| async {
                Json(json!({"object":"list","data":[{"id":"custom","object":"model"}]}))
            }),
        )
        .route("/status", get(status))
        .route("/v1/audio/transcriptions", post(transcribe))
        .layer(DefaultBodyLimit::max(26 * 1024 * 1024))
        .with_state(state);
    let port = std::env::var("TINA_SHERPA_PORT")
        .unwrap_or_else(|_| "18001".into())
        .parse::<u16>()?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    eprintln!("TINA native ASR ready at http://127.0.0.1:{port}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
