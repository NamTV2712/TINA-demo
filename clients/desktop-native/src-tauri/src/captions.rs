//! Live captions for the active capture session.
//!
//! Desktop's gateway exposes `WS /ws`: subscribe to one meeting and receive
//! `transcript.v1` frames with confirmed and pending segments. This module keeps
//! a small rolling window in memory so the overlay and the floating subtitle
//! window can render near-real-time text without each opening its own socket.
//!
//! Captions are presentation only. The authoritative transcript stays in
//! Desktop, and a socket failure never affects audio capture.

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tungstenite::{client::IntoClientRequest, Message};

const GATEWAY: &str = "ws://127.0.0.1:8056/ws";
const READ_TIMEOUT: Duration = Duration::from_millis(800);
const RECONNECT: Duration = Duration::from_millis(1500);
const MAX_SEGMENTS: usize = 400;
static NEXT_SEGMENT_ID: AtomicU64 = AtomicU64::new(1);

pub const TRANSLATION_LANGUAGES: &[&str] = &["en", "vi", "ja", "ko", "zh-CN", "es", "fr", "de"];

pub fn supports_translation_language(language: &str) -> bool {
    TRANSLATION_LANGUAGES.contains(&language)
}

#[derive(Clone, Debug, Serialize)]
pub struct CaptionTranslation {
    pub target_language: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Segment {
    pub id: u64,
    #[serde(skip)]
    source_id: Option<String>,
    pub text: String,
    pub start: f64,
    pub end: f64,
    pub speaker: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation: Option<CaptionTranslation>,
}

pub struct Captions {
    stop: AtomicBool,
    connected: AtomicBool,
    error: Mutex<Option<String>>,
    segments: Mutex<Vec<Segment>>,
    pending: Mutex<Vec<Segment>>,
    target_language: Mutex<Option<String>>,
}

impl Captions {
    /// Subscribe to `meeting` (`tina-native-<uuid>`). Returns immediately; the
    /// socket is owned by a background thread until [`stop`](Self::stop).
    pub fn start(meeting: String) -> Arc<Self> {
        let state = Arc::new(Self {
            stop: AtomicBool::new(false),
            connected: AtomicBool::new(false),
            error: Mutex::new(None),
            segments: Mutex::new(Vec::new()),
            pending: Mutex::new(Vec::new()),
            target_language: Mutex::new(None),
        });
        let worker = state.clone();
        std::thread::Builder::new()
            .name("tina-live-captions".into())
            .spawn(move || worker.run(meeting))
            .expect("spawn captions worker");
        state
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }

    pub fn set_target_language(&self, language: Option<String>) {
        let mut target = self.target_language.lock().unwrap();
        if *target == language {
            return;
        }
        *target = language;
        for segment in self.segments.lock().unwrap().iter_mut() {
            segment.translation = None;
        }
    }

    pub fn set_translation(
        &self,
        id: u64,
        source_text: &str,
        target_language: &str,
        text: String,
    ) -> bool {
        if self.target_language.lock().unwrap().as_deref() != Some(target_language) {
            return false;
        }
        let mut segments = self.segments.lock().unwrap();
        let Some(segment) = segments
            .iter_mut()
            .find(|segment| segment.id == id && segment.text == source_text)
        else {
            return false;
        };
        segment.translation = Some(CaptionTranslation {
            target_language: target_language.to_string(),
            text,
        });
        true
    }

    /// Rolling snapshot for the UI. `limit` caps the confirmed lines returned.
    pub fn snapshot(&self, limit: usize) -> Value {
        let target_language = self.target_language.lock().unwrap().clone();
        let segments = self.segments.lock().unwrap();
        let start = segments.len().saturating_sub(limit.max(1));
        let pending = self
            .pending
            .lock()
            .unwrap()
            .iter()
            .map(|segment| segment.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        json!({
            "connected": self.connected.load(Ordering::Relaxed),
            "error": self.error.lock().unwrap().clone(),
            "segments": &segments[start..],
            "pending": pending,
            "target_language": target_language,
        })
    }

    fn run(self: Arc<Self>, meeting: String) {
        while !self.stop.load(Ordering::Relaxed) {
            let error = match self.session(&meeting) {
                Ok(()) if self.stop.load(Ordering::Relaxed) => break,
                // Desktop restarted or closed the socket; keep the subscription
                // alive instead of silently losing captions for the session.
                Ok(()) => "Live captions disconnected. Reconnecting…".to_string(),
                Err(error) => error,
            };
            self.connected.store(false, Ordering::Relaxed);
            if self.stop.load(Ordering::Relaxed) {
                break;
            }
            *self.error.lock().unwrap() = Some(error);
            std::thread::sleep(RECONNECT);
        }
        self.connected.store(false, Ordering::Relaxed);
    }

    fn session(&self, meeting: &str) -> Result<(), String> {
        let request = GATEWAY
            .into_client_request()
            .map_err(|_| "Invalid local live-caption endpoint.".to_string())?;
        let (mut socket, _) =
            crate::local_ws::connect_local(request, READ_TIMEOUT, Duration::from_secs(2))
                .map_err(|_| "TINA Desktop live captions are unavailable.".to_string())?;
        let subscribe = json!({
            "action": "subscribe",
            "meetings": [{"platform": "desktop", "native_id": meeting}],
        });
        socket
            .send(Message::text(subscribe.to_string()))
            .map_err(|_| "Could not subscribe to live captions.".to_string())?;
        self.connected.store(true, Ordering::Relaxed);
        *self.error.lock().unwrap() = None;
        loop {
            if self.stop.load(Ordering::Relaxed) {
                let _ = socket.close(None);
                return Ok(());
            }
            match socket.read() {
                Ok(Message::Text(text)) => self.ingest(text.as_str()),
                Ok(Message::Close(_)) => return Ok(()),
                Ok(_) => {}
                Err(tungstenite::Error::Io(error))
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::Interrupted
                    ) => {}
                Err(tungstenite::Error::ConnectionClosed) => return Ok(()),
                Err(error) => return Err(format!("Live captions paused: {error}")),
            }
        }
    }

    fn ingest(&self, text: &str) {
        let Ok(frame) = serde_json::from_str::<Value>(text) else {
            return;
        };
        if frame["type"] != "transcript" {
            return;
        }
        if let Some(items) = frame["confirmed"].as_array() {
            let mut segments = self.segments.lock().unwrap();
            for item in items {
                let Some(mut segment) = parse(item) else {
                    continue;
                };
                // Stable IDs keep simultaneous source channels distinct during speaker repaints.
                match segments
                    .iter_mut()
                    .find(|existing| match &segment.source_id {
                        Some(id) => existing.source_id.as_ref() == Some(id),
                        None => existing.source_id.is_none() && (existing.start - segment.start).abs() < 0.05,
                    })
                {
                    Some(existing) => {
                        segment.id = existing.id;
                        if existing.text == segment.text {
                            segment.translation = existing.translation.clone();
                        }
                        *existing = segment;
                    }
                    None => {
                        segment.id = NEXT_SEGMENT_ID.fetch_add(1, Ordering::Relaxed);
                        segments.push(segment);
                    }
                }
            }
            if segments.len() > MAX_SEGMENTS {
                let drop = segments.len() - MAX_SEGMENTS / 2;
                segments.drain(..drop);
            }
        }
        if let Some(items) = frame["pending"].as_array() {
            let mut pending = self.pending.lock().unwrap();
            pending.clear();
            pending.extend(items.iter().filter_map(parse));
        }
    }
}

fn parse(item: &Value) -> Option<Segment> {
    let text = item["text"].as_str()?.trim().to_string();
    if text.is_empty() {
        return None;
    }
    Some(Segment {
        id: 0,
        source_id: item["segment_id"].as_str().map(str::to_owned),
        text,
        start: item["start"].as_f64().unwrap_or(0.0),
        end: item["end"].as_f64().unwrap_or(0.0),
        speaker: item["speaker"]
            .as_str()
            .filter(|name| !name.is_empty())
            .unwrap_or("Audio")
            .to_string(),
        translation: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn captions() -> Captions {
        Captions {
            stop: AtomicBool::new(false),
            connected: AtomicBool::new(false),
            error: Mutex::new(None),
            segments: Mutex::new(Vec::new()),
            pending: Mutex::new(Vec::new()),
            target_language: Mutex::new(None),
        }
    }

    #[test]
    fn confirmed_segments_are_deduplicated_and_pending_is_replaced() {
        let captions = captions();
        captions.ingest(
            r#"{"type":"transcript","confirmed":[{"text":"hello","start":1.0,"end":1.5,"speaker":"You"}],"pending":[]}"#,
        );
        captions.ingest(
            r#"{"type":"transcript","confirmed":[{"text":"hello","start":1.0,"end":1.5,"speaker":"You"}],"pending":[]}"#,
        );
        captions.ingest(
            r#"{"type":"transcript","confirmed":[],"pending":[{"text":"wor","start":2.0,"end":2.5,"speaker":"You"}]}"#,
        );
        let snapshot = captions.snapshot(6);
        assert_eq!(snapshot["segments"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["pending"], "wor");
    }

    #[test]
    fn a_revised_segment_replaces_the_earlier_text() {
        let captions = captions();
        captions.ingest(
            r#"{"type":"transcript","confirmed":[{"text":"ship this wek","start":3.0,"end":4.0,"speaker":"You"}],"pending":[]}"#,
        );
        captions.ingest(
            r#"{"type":"transcript","confirmed":[{"text":"ship this week","start":3.02,"end":4.1,"speaker":"You"}],"pending":[]}"#,
        );
        let snapshot = captions.snapshot(6);
        let segments = snapshot["segments"].as_array().unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0]["text"], "ship this week");
        assert_eq!(segments[0]["end"], 4.1);
    }

    #[test]
    fn speaker_repaint_keeps_overlapping_sources_and_the_pending_draft() {
        let captions = captions();
        captions.ingest(r#"{"type":"transcript","confirmed":[{"segment_id":"mic","text":"local","start":1.0,"end":2.0,"speaker":"You"},{"segment_id":"remote","text":"remote","start":1.0,"end":2.0,"speaker":"Unknown speaker"}],"pending":[{"text":"forming","start":3.0,"speaker":"You"}]}"#);
        captions.ingest(r#"{"type":"transcript","confirmed":[{"segment_id":"remote","text":"remote","start":1.0,"end":2.0,"speaker":"An"}]}"#);
        let snapshot = captions.snapshot(6);
        let segments = snapshot["segments"].as_array().unwrap();
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0]["speaker"], "You");
        assert_eq!(segments[1]["speaker"], "An");
        assert_eq!(snapshot["pending"], "forming");
    }
}
