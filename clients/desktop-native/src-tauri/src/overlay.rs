//! Floating meeting overlay.
//!
//! One always-on-top, non-focusable window carries the three Speakly-style
//! moments that must survive the main window being hidden:
//!
//! * **detect** — another app just took the microphone; record in one click.
//! * **record** — elapsed time, level, pause/stop and live captions.
//! * **ended**  — the meeting app released the mic; stop or keep recording.
//!
//! The window is cloned/positioned by Rust; the webview only polls state and
//! invokes actions. Detection is advisory and never starts capture by itself.

use crate::meeting::{self, DetectedApp};
use crate::{start_session, stop_session, Control, Sources};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow};

/// A meeting app must release the mic for this long before the reminder.
const RELEASE_SUSTAIN: Duration = Duration::from_secs(5);
/// Hover-free grace before the reminder self-dismisses ("keep recording").
const REMINDER_GRACE: Duration = Duration::from_secs(15);
/// A detect suggestion closes itself after this long.
const DETECT_AUTO_HIDE: Duration = Duration::from_secs(15);
/// Result Toast / AI summary display duration before auto-dismiss.
const RESULT_TOAST_DURATION: Duration = Duration::from_secs(6);
const TICK: Duration = Duration::from_millis(400);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    Hidden,
    Detect,
    Record,
    Ended,
    Result,
    Dictation,
}

pub struct OverlayState {
    mode: Mode,
    applied: Mode,
    dismissed: HashSet<String>,
    seen_app: bool,
    released_at: Option<Instant>,
    suppressed: bool,
    detect_since: Option<Instant>,
    result_until: Option<Instant>,
    was_recording: bool,
    pub payload: Value,
}

impl Default for OverlayState {
    fn default() -> Self {
        Self {
            mode: Mode::Hidden,
            applied: Mode::Hidden,
            dismissed: HashSet::new(),
            seen_app: false,
            released_at: None,
            suppressed: false,
            detect_since: None,
            result_until: None,
            was_recording: false,
            payload: json!({"mode": "hidden"}),
        }
    }
}

impl OverlayState {
    /// Suppress the suggestion for every currently detected session. A session
    /// id changes when the app reacquires the microphone, so the next call is
    /// offered again.
    pub(crate) fn dismiss(&mut self, apps: &[DetectedApp]) {
        for app in apps {
            self.dismissed.insert(app.session.clone());
        }
        self.detect_since = None;
    }
}

pub fn start(app: AppHandle, control: Arc<Control>) {
    for label in ["overlay", "subtitles"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.set_always_on_top(true);
            let _ = window.set_visible_on_all_workspaces(true);
        }
    }
    std::thread::Builder::new()
        .name("tina-overlay".into())
        .spawn(move || loop {
            tick(&app, &control);
            std::thread::sleep(TICK);
        })
        .expect("spawn overlay ticker");
}

fn tick(app: &AppHandle, control: &Arc<Control>) {
    let shared = control.shared.lock().unwrap().clone();
    let running = shared.running.load(Ordering::Relaxed);
    let recording = running && !shared.dictation;
    let apps = if recording || !running {
        meeting::snapshot()
    } else {
        Vec::new()
    };

    let mut state = control.overlay.lock().unwrap();
    state
        .dismissed
        .retain(|session| apps.iter().any(|app| &app.session == session));
    let is_dictation = running && shared.dictation;
    let mode = if is_dictation {
        Mode::Dictation
    } else {
        decide(&mut state, &apps, recording)
    };
    state.mode = mode;
    state.was_recording = recording;

    let grace_remaining_ms = state.released_at.map(|released| {
        (RELEASE_SUSTAIN + REMINDER_GRACE)
            .saturating_sub(released.elapsed())
            .as_millis() as u64
    });
    let status = crate::status(&shared);
    let sources = *control.sources.lock().unwrap();
    let source_mode = match (sources.microphone, sources.system_audio) {
        (true, true) => "both",
        (true, false) => "mic",
        (false, true) => "system",
        _ => "both",
    };
    let captions = shared.caption_snapshot(1);
    let last = captions["segments"]
        .as_array()
        .and_then(|items| items.last())
        .cloned()
        .unwrap_or(Value::Null);
    state.payload = json!({
        "mode": match mode {
            Mode::Hidden => "hidden",
            Mode::Detect => "detect",
            Mode::Record => "record",
            Mode::Ended => "ended",
            Mode::Result => "result",
            Mode::Dictation => "dictation",
        },
        "is_dictation": is_dictation,
        "apps": apps,
        "elapsed_ms": status.elapsed_ms,
        "paused": status.paused,
        "level": status.level,
        "error": status.error,
        "source_mode": source_mode,
        "microphone": sources.microphone,
        "system_audio": sources.system_audio,
        "grace_remaining_ms": grace_remaining_ms.filter(|_| mode == Mode::Ended),
        "subtitles": control.subtitles.load(Ordering::Relaxed),
        "caption": last["text"],
        "caption_speaker": last["speaker"],
        "pending": captions["pending"],
    });
    apply(app, &mut state);
    drop(state);

    let subtitles = control.subtitles.load(Ordering::Relaxed) && recording;
    if !recording {
        control.subtitles.store(false, Ordering::Relaxed);
    }
    set_subtitles(app, subtitles);
}

fn decide(state: &mut OverlayState, apps: &[DetectedApp], recording: bool) -> Mode {
    let now = Instant::now();
    if recording {
        state.detect_since = None;
        if !apps.is_empty() {
            state.seen_app = true;
            state.suppressed = false;
            state.released_at = None;
        } else if state.seen_app && state.released_at.is_none() && !state.suppressed {
            state.released_at = Some(now);
        }
        if state.seen_app && !state.suppressed {
            match state.released_at {
                Some(released) if released.elapsed() >= RELEASE_SUSTAIN + REMINDER_GRACE => {
                    // Grace expired: continue recording until the app returns.
                    state.suppressed = true;
                    state.released_at = None;
                    Mode::Record
                }
                Some(released) if released.elapsed() >= RELEASE_SUSTAIN => Mode::Ended,
                _ => Mode::Record,
            }
        } else {
            Mode::Record
        }
    } else {
        state.seen_app = false;
        state.released_at = None;
        state.suppressed = false;

        // If recording just finished, keep overlay alive with Result Toast
        if state.was_recording {
            state.result_until = Some(now + RESULT_TOAST_DURATION);
        }

        if let Some(until) = state.result_until {
            if now < until {
                return Mode::Result;
            } else {
                state.result_until = None;
            }
        }

        if apps.is_empty()
            || apps
                .iter()
                .all(|app| state.dismissed.contains(&app.session))
        {
            state.detect_since = None;
            Mode::Hidden
        } else {
            let since = *state.detect_since.get_or_insert(now);
            if since.elapsed() >= DETECT_AUTO_HIDE {
                for app in apps {
                    state.dismissed.insert(app.session.clone());
                }
                state.detect_since = None;
                Mode::Hidden
            } else {
                Mode::Detect
            }
        }
    }
}

fn apply(app: &AppHandle, state: &mut OverlayState) {
    let Some(window) = app.get_webview_window("overlay") else {
        return;
    };
    if state.mode == Mode::Hidden {
        if state.applied != Mode::Hidden {
            let _ = window.hide();
        }
        state.applied = Mode::Hidden;
        return;
    }
    let (width, height) = match state.mode {
        Mode::Detect => (460.0, 138.0),
        Mode::Record => (420.0, 152.0),
        Mode::Ended => (460.0, 168.0),
        Mode::Result => (460.0, 168.0),
        Mode::Dictation => (240.0, 56.0),
        Mode::Hidden => unreachable!(),
    };
    if state.mode != state.applied {
        let _ = window.set_size(LogicalSize::new(width, height));
        if state.mode == Mode::Dictation {
            place_bottom_center(&window);
        } else if state.applied == Mode::Hidden {
            if let Ok(Some(monitor)) = window.primary_monitor() {
                let logical = monitor.size().to_logical::<f64>(monitor.scale_factor());
                let x = (logical.width - width - 18.0).max(18.0);
                let _ = window.set_position(LogicalPosition::new(x, 44.0));
            }
        }
        let _ = window.show();
        state.applied = state.mode;
    } else if !window.is_visible().unwrap_or(true) {
        let _ = window.show();
    }
}

pub(crate) fn set_subtitles(app: &AppHandle, on: bool) {
    let Some(window) = app.get_webview_window("subtitles") else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    if on && !visible {
        place_bottom_center(&window);
        let _ = window.show();
    } else if !on && visible {
        let _ = window.hide();
    }
}

fn place_bottom_center(window: &WebviewWindow) {
    let Ok(Some(monitor)) = window.primary_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    let screen = monitor.size().to_logical::<f64>(scale);
    let size = window
        .outer_size()
        .map(|size| size.to_logical::<f64>(scale))
        .unwrap_or(LogicalSize::new(760.0, 200.0));
    let x = ((screen.width - size.width) / 2.0).max(12.0);
    let y = (screen.height - size.height - 90.0).max(48.0);
    let _ = window.set_position(LogicalPosition::new(x, y));
}

pub async fn action(action: String, app: AppHandle, control: Arc<Control>) -> Result<(), String> {
    match action.as_str() {
        "record" => {
            let Sources {
                microphone,
                system_audio,
            } = *control.sources.lock().unwrap();
            start_session(microphone, system_audio, false, false, None, app, control).await?;
            Ok(())
        }
        "dismiss" => {
            let apps = meeting::snapshot();
            let mut state = control.overlay.lock().unwrap();
            state.dismiss(&apps);
            Ok(())
        }
        "dictation-stop" | "stop" => {
            let result = stop_session(&control);
            set_subtitles(&app, false);
            result
        }
        "pause" => {
            control.shared.lock().unwrap().pause();
            Ok(())
        }
        "resume" => {
            control.shared.lock().unwrap().resume();
            Ok(())
        }
        "continue" => {
            let mut state = control.overlay.lock().unwrap();
            state.suppressed = true;
            state.released_at = None;
            Ok(())
        }
        "captions" => {
            let shared = control.shared.lock().unwrap().clone();
            if !shared.running.load(Ordering::Relaxed) || shared.dictation {
                return Ok(());
            }
            let next = !control.subtitles.load(Ordering::Relaxed);
            control.subtitles.store(next, Ordering::Relaxed);
            set_subtitles(&app, next);
            Ok(())
        }
        "source_both" => {
            let mut s = control.sources.lock().unwrap();
            s.microphone = true;
            s.system_audio = true;
            Ok(())
        }
        "source_mic" => {
            let mut s = control.sources.lock().unwrap();
            s.microphone = true;
            s.system_audio = false;
            Ok(())
        }
        "source_system" => {
            let mut s = control.sources.lock().unwrap();
            s.microphone = false;
            s.system_audio = true;
            Ok(())
        }
        "dismiss_result" => {
            let mut state = control.overlay.lock().unwrap();
            state.result_until = None;
            Ok(())
        }
        "open" => {
            let mut state = control.overlay.lock().unwrap();
            state.result_until = None;
            drop(state);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            Ok(())
        }
        _ => Err("Unknown overlay action".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(session: &str) -> DetectedApp {
        DetectedApp {
            session: session.to_string(),
            bundle_id: "us.zoom.xos".into(),
            name: "Zoom".into(),
            pid: 7,
        }
    }

    #[test]
    fn manual_recordings_never_show_the_end_reminder() {
        let mut state = OverlayState::default();
        assert_eq!(decide(&mut state, &[], true), Mode::Record);
        assert_eq!(decide(&mut state, &[], true), Mode::Record);
        assert_eq!(state.released_at, None);
    }

    #[test]
    fn a_meeting_release_becomes_a_reminder_after_the_sustain() {
        let mut state = OverlayState::default();
        assert_eq!(decide(&mut state, &[app("a")], true), Mode::Record);
        assert_eq!(decide(&mut state, &[], true), Mode::Record);
        state.released_at = Some(Instant::now() - RELEASE_SUSTAIN);
        assert_eq!(decide(&mut state, &[], true), Mode::Ended);
        state.suppressed = true;
        state.released_at = None;
        assert_eq!(decide(&mut state, &[], true), Mode::Record);
    }

    #[test]
    fn detection_hides_when_dismissed() {
        let mut state = OverlayState::default();
        assert_eq!(decide(&mut state, &[app("a")], false), Mode::Detect);
        state.dismissed.insert("a".into());
        assert_eq!(decide(&mut state, &[app("a")], false), Mode::Hidden);
    }

    #[test]
    fn stopping_recording_shows_result_toast_before_hiding() {
        let mut state = OverlayState::default();
        assert_eq!(decide(&mut state, &[], true), Mode::Record);
        state.was_recording = true;
        assert_eq!(decide(&mut state, &[], false), Mode::Result);
        state.was_recording = false;
        assert_eq!(decide(&mut state, &[], false), Mode::Result);
        state.result_until = Some(Instant::now() - Duration::from_secs(1));
        assert_eq!(decide(&mut state, &[], false), Mode::Hidden);
    }
}
