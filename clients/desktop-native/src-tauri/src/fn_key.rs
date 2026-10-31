use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use tauri::{AppHandle, Emitter};

const PENDING: u8 = 0;
const READY: u8 = 1;
const NEEDS_ACCESSIBILITY: u8 = 2;
const UNAVAILABLE: u8 = 3;
static STATUS: AtomicU8 = AtomicU8::new(PENDING);

struct MonitorState {
    app: AppHandle,
    pressed: AtomicBool,
}

type EventTapCallback = Option<
    unsafe extern "C" fn(
        *mut std::ffi::c_void,
        u32,
        *mut std::ffi::c_void,
        *mut std::ffi::c_void,
    ) -> *mut std::ffi::c_void,
>;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: u64,
        callback: EventTapCallback,
        user_info: *mut std::ffi::c_void,
    ) -> *mut std::ffi::c_void;
    fn CGEventTapEnable(tap: *mut std::ffi::c_void, enable: bool);
    fn CGEventGetFlags(event: *mut std::ffi::c_void) -> u64;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFMachPortCreateRunLoopSource(
        allocator: *const std::ffi::c_void,
        port: *mut std::ffi::c_void,
        order: isize,
    ) -> *mut std::ffi::c_void;
    fn CFRunLoopGetCurrent() -> *mut std::ffi::c_void;
    fn CFRunLoopAddSource(
        run_loop: *mut std::ffi::c_void,
        source: *mut std::ffi::c_void,
        mode: *const std::ffi::c_void,
    );
    fn CFRunLoopRun();
    fn CFRelease(value: *const std::ffi::c_void);
    static kCFRunLoopCommonModes: *const std::ffi::c_void;
}

pub fn start(app: AppHandle) {
    if let Err(error) = std::thread::Builder::new()
        .name("tina-fn-key-monitor".into())
        .spawn(move || run(app))
    {
        eprintln!("Could not start Fn key monitor: {error}");
        STATUS.store(UNAVAILABLE, Ordering::Relaxed);
    }
}

pub fn status() -> &'static str {
    match STATUS.load(Ordering::Relaxed) {
        READY => "ready",
        NEEDS_ACCESSIBILITY => "needs-accessibility",
        UNAVAILABLE => "unavailable",
        _ => "checking",
    }
}

fn announce(app: &AppHandle, status: u8) {
    STATUS.store(status, Ordering::Relaxed);
    let label = match status {
        READY => "ready",
        NEEDS_ACCESSIBILITY => "needs-accessibility",
        _ => "unavailable",
    };
    let _ = app.emit("fn-shortcut-status", label);
}

fn run(app: AppHandle) {
    if !unsafe { AXIsProcessTrusted() } {
        announce(&app, NEEDS_ACCESSIBILITY);
        return;
    }

    let state = Box::new(MonitorState {
        app: app.clone(),
        pressed: AtomicBool::new(false),
    });
    let user_info = Box::into_raw(state).cast();

    // Fn is exposed as a flag on macOS flag-changed events, not as a standalone key code.
    // Source: https://developer.apple.com/documentation/coregraphics/cgeventflags/masksecondaryfn
    let tap = unsafe { CGEventTapCreate(1, 0, 1, 1 << 12, Some(fn_event_tap), user_info) };
    if tap.is_null() {
        unsafe { drop(Box::from_raw(user_info.cast::<MonitorState>())) };
        announce(&app, UNAVAILABLE);
        return;
    }

    let source = unsafe { CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0) };
    let run_loop = unsafe { CFRunLoopGetCurrent() };
    if source.is_null() || run_loop.is_null() {
        if !source.is_null() {
            unsafe { CFRelease(source) };
        }
        unsafe {
            CFRelease(tap);
            drop(Box::from_raw(user_info.cast::<MonitorState>()));
        }
        announce(&app, UNAVAILABLE);
        return;
    }

    unsafe {
        CFRunLoopAddSource(run_loop, source, kCFRunLoopCommonModes);
        CGEventTapEnable(tap, true);
    }
    announce(&app, READY);
    unsafe { CFRunLoopRun() };

    unsafe {
        CFRelease(source);
        CFRelease(tap);
        drop(Box::from_raw(user_info.cast::<MonitorState>()));
    }
    announce(&app, UNAVAILABLE);
}

unsafe extern "C" fn fn_event_tap(
    _proxy: *mut std::ffi::c_void,
    event_type: u32,
    event: *mut std::ffi::c_void,
    user_info: *mut std::ffi::c_void,
) -> *mut std::ffi::c_void {
    const FLAGS_CHANGED: u32 = 12;
    const FN_FLAG: u64 = 1 << 23;

    if event_type == FLAGS_CHANGED && !user_info.is_null() {
        let state = unsafe { &*user_info.cast::<MonitorState>() };
        let pressed = unsafe { CGEventGetFlags(event) & FN_FLAG != 0 };
        if state.pressed.swap(pressed, Ordering::Relaxed) != pressed {
            let _ = state.app.emit("fn-shortcut-state", pressed);
        }
    }
    event
}
