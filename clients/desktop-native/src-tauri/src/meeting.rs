//! Detect other applications that are using the microphone.
//!
//! macOS 14.4+ exposes CoreAudio *process* objects: every client process that
//! currently has an active input stream. Reading `kAudioProcessPropertyIsRunningInput`
//! needs no TCC grant and no audio samples — it is presence metadata only. The list
//! is filtered to known meeting applications (and browsers, where Google Meet and
//! similar run) and gated behind a sustain window so short device tests and
//! teardown blips do not raise a popup.
//!
//! This is deliberately advisory. Detection never starts capture on its own; the
//! user must confirm in the floating overlay.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How long a process must hold the mic before it is surfaced.
const SUSTAIN: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(1500);

/// Mirrors `identifier` in tauri.conf.json.
const OWN_BUNDLE: &str = "local.tina.capture";

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct DetectedApp {
    /// Stable per acquisition, so dismissing one call does not silence the next.
    pub session: String,
    pub bundle_id: String,
    pub name: String,
    pub pid: i32,
}

static DETECTED: Mutex<Vec<DetectedApp>> = Mutex::new(Vec::new());

/// Sustained meeting applications, newest snapshot first (sorted by name).
pub fn snapshot() -> Vec<DetectedApp> {
    DETECTED.lock().unwrap().clone()
}

/// Start the process monitor. Safe to call once; a second call is a no-op.
pub fn start() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        std::thread::Builder::new()
            .name("tina-meeting-detect".into())
            .spawn(monitor)
            .expect("spawn meeting detector");
    });
}

fn monitor() {
    let mut presence: HashMap<String, (Instant, u64)> = HashMap::new();
    let mut last: Vec<DetectedApp> = Vec::new();
    loop {
        let mut next = HashMap::new();
        let mut sustained = Vec::new();
        let now_ms = epoch_ms();
        for (pid, bundle_id) in input_processes() {
            let Some(name) = app_name(&bundle_id) else {
                continue;
            };
            // This app's own capture must never raise a "meeting detected" popup.
            if bundle_id == OWN_BUNDLE {
                continue;
            }
            let key = format!("{bundle_id}:{pid}");
            let (first, started_ms) = *presence
                .entry(key.clone())
                .or_insert((Instant::now(), now_ms));
            next.insert(key, (first, started_ms));
            if first.elapsed() >= SUSTAIN {
                sustained.push(DetectedApp {
                    session: format!("{bundle_id}:{pid}:{started_ms}"),
                    bundle_id: bundle_id.clone(),
                    name: name.to_string(),
                    pid,
                });
            }
        }
        presence = next;
        sustained.sort_by(|a, b| a.name.cmp(&b.name).then(a.pid.cmp(&b.pid)));
        if last != sustained {
            if std::env::var_os("TINA_CAPTURE_DEBUG").is_some() {
                eprintln!(
                    "[detect] {}",
                    sustained
                        .iter()
                        .map(|a| format!("{}({})", a.name, a.pid))
                        .collect::<Vec<_>>()
                        .join(", ")
                );
            }
            *DETECTED.lock().unwrap() = sustained.clone();
            last = sustained;
        }
        std::thread::sleep(POLL);
    }
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Bundle ids that represent a meeting surface. Browsers are included because
/// Google Meet and similar products run in a tab; the popup is a suggestion and
/// can be dismissed.
fn app_name(bundle_id: &str) -> Option<&'static str> {
    APP_NAMES
        .iter()
        .find(|(id, _)| *id == bundle_id)
        .map(|(_, name)| *name)
}

const APP_NAMES: &[(&str, &str)] = &[
    ("us.zoom.xos", "Zoom"),
    ("us.zoom.xos.helper", "Zoom"),
    ("com.microsoft.teams2", "Microsoft Teams"),
    ("com.microsoft.teams", "Microsoft Teams"),
    ("com.cisco.webexmeetingsapp", "Webex"),
    ("com.webex.meetingmanager", "Webex"),
    ("com.apple.FaceTime", "FaceTime"),
    ("com.tinyspeck.slackmacgap", "Slack"),
    ("com.hnc.Discord", "Discord"),
    ("com.skype.skype", "Skype"),
    ("com.bluejeans.app.dmg", "BlueJeans"),
    ("com.logmein.gotomeeting", "GoTo Meeting"),
    ("com.loom.desktop", "Loom"),
    ("com.riverside.fm", "Riverside"),
    ("com.google.Chrome", "Google Chrome"),
    ("com.google.Chrome.beta", "Google Chrome"),
    ("com.google.Chrome.canary", "Google Chrome Canary"),
    ("org.chromium.Chromium", "Chromium"),
    ("com.apple.Safari", "Safari"),
    (
        "com.apple.SafariTechnologyPreview",
        "Safari Technology Preview",
    ),
    ("com.microsoft.edgemac", "Microsoft Edge"),
    ("com.brave.Browser", "Brave"),
    ("company.thebrowser.Browser", "Arc"),
    ("com.vivaldi.Vivaldi", "Vivaldi"),
    ("org.mozilla.firefox", "Firefox"),
    ("com.operasoftware.Opera", "Opera"),
];

#[cfg(target_os = "macos")]
fn input_processes() -> Vec<(i32, String)> {
    macos::input_processes()
}

#[cfg(not(target_os = "macos"))]
fn input_processes() -> Vec<(i32, String)> {
    Vec::new()
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{c_void, CStr};

    type AudioObjectId = u32;
    type OSStatus = i32;

    const SYSTEM_OBJECT: AudioObjectId = 1;
    const SCOPE_GLOBAL: u32 = u32::from_be_bytes(*b"glob");
    const ELEMENT_MAIN: u32 = 0;
    const PROP_PROCESS_LIST: u32 = u32::from_be_bytes(*b"prs#");
    const PROP_PID: u32 = u32::from_be_bytes(*b"ppid");
    const PROP_BUNDLE: u32 = u32::from_be_bytes(*b"pbid");
    const PROP_RUNNING_INPUT: u32 = u32::from_be_bytes(*b"piri");
    const UTF8: u32 = 0x0800_0100;

    #[repr(C)]
    struct Address {
        selector: u32,
        scope: u32,
        element: u32,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    unsafe extern "C" {
        fn AudioObjectGetPropertyData(
            object: AudioObjectId,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            io_size: *mut u32,
            out: *mut c_void,
        ) -> OSStatus;
        fn AudioObjectGetPropertyDataSize(
            object: AudioObjectId,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            out_size: *mut u32,
        ) -> OSStatus;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringGetCString(
            value: *const c_void,
            buffer: *mut i8,
            size: isize,
            encoding: u32,
        ) -> u8;
        fn CFRelease(value: *const c_void);
    }

    fn address(selector: u32) -> Address {
        Address {
            selector,
            scope: SCOPE_GLOBAL,
            element: ELEMENT_MAIN,
        }
    }

    fn value<T: Copy>(object: AudioObjectId, selector: u32) -> Option<T> {
        let address = address(selector);
        let mut size = std::mem::size_of::<T>() as u32;
        let mut out = std::mem::MaybeUninit::<T>::uninit();
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                &address,
                0,
                std::ptr::null(),
                &mut size,
                out.as_mut_ptr().cast(),
            )
        };
        (status == 0 && size as usize == std::mem::size_of::<T>())
            .then(|| unsafe { out.assume_init() })
    }

    fn list(object: AudioObjectId, selector: u32) -> Vec<AudioObjectId> {
        let address = address(selector);
        let mut size = 0u32;
        let status = unsafe {
            AudioObjectGetPropertyDataSize(object, &address, 0, std::ptr::null(), &mut size)
        };
        if status != 0 || size < 4 {
            return Vec::new();
        }
        let mut items = vec![0u32; size as usize / 4];
        let mut written = size;
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                &address,
                0,
                std::ptr::null(),
                &mut written,
                items.as_mut_ptr().cast(),
            )
        };
        if status != 0 {
            return Vec::new();
        }
        items.truncate(written as usize / 4);
        items
    }

    fn bundle_id(object: AudioObjectId) -> Option<String> {
        let address = address(PROP_BUNDLE);
        let mut size = std::mem::size_of::<*const c_void>() as u32;
        let mut raw: *const c_void = std::ptr::null();
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                &address,
                0,
                std::ptr::null(),
                &mut size,
                (&mut raw as *mut *const c_void).cast(),
            )
        };
        if status != 0 || raw.is_null() {
            return None;
        }
        let mut buffer = [0i8; 512];
        let copied =
            unsafe { CFStringGetCString(raw, buffer.as_mut_ptr(), buffer.len() as isize, UTF8) };
        unsafe { CFRelease(raw) };
        if copied == 0 {
            return None;
        }
        Some(
            unsafe { CStr::from_ptr(buffer.as_ptr()) }
                .to_string_lossy()
                .into_owned(),
        )
    }

    pub(super) fn input_processes() -> Vec<(i32, String)> {
        let mut found = Vec::new();
        for object in list(SYSTEM_OBJECT, PROP_PROCESS_LIST) {
            let Some(pid) = value::<i32>(object, PROP_PID) else {
                continue;
            };
            let Some(running) = value::<u32>(object, PROP_RUNNING_INPUT) else {
                continue;
            };
            if running == 0 {
                continue;
            }
            if let Some(bundle) = bundle_id(object) {
                if !bundle.is_empty() {
                    found.push((pid, bundle));
                }
            }
        }
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_meeting_apps_are_named() {
        assert_eq!(app_name("us.zoom.xos"), Some("Zoom"));
        assert_eq!(app_name("com.apple.Safari"), Some("Safari"));
        assert_eq!(app_name("com.example.unknown"), None);
    }
}
