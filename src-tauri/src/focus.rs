use std::sync::atomic::{AtomicBool, Ordering};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use tauri::{LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize};

const NORMAL_MIN_W: f64 = 1000.0;
const NORMAL_MIN_H: f64 = 660.0;
const FOCUS_MIN_W: f64 = 260.0;
const FOCUS_MIN_H: f64 = 200.0;
const APP_TITLE: &str = "Agent Launcher ADE";

struct Saved {
    pos: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    maximized: bool,
}

static SAVED: Lazy<Mutex<Option<Saved>>> = Lazy::new(|| Mutex::new(None));
static ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn focus_mode_active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_ui_zoom(app: tauri::AppHandle, factor: f64) -> Result<(), String> {
    let win = app.get_webview_window("main").ok_or("no main window")?;
    let f = factor.clamp(0.4, 3.0);
    win.set_zoom(f).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn focus_mode(
    app: tauri::AppHandle,
    on: bool,
    width: f64,
    height: f64,
    title: Option<String>,
) -> Result<(), String> {
    let win = app.get_webview_window("main").ok_or("no main window")?;

    if on {
        if !focus_mode_active() {
            let pos = win.outer_position().map_err(|e| e.to_string())?;
            let size = win.inner_size().map_err(|e| e.to_string())?;
            let maximized = win.is_maximized().unwrap_or(false);
            *SAVED.lock() = Some(Saved {
                pos,
                size,
                maximized,
            });
        }
        ACTIVE.store(true, Ordering::Relaxed);

        if win.is_maximized().unwrap_or(false) {
            let _ = win.unmaximize();
        }
        let _ = win.set_min_size(Some(LogicalSize::new(FOCUS_MIN_W, FOCUS_MIN_H)));

        let mut w = width.max(FOCUS_MIN_W);
        let mut h = height.max(FOCUS_MIN_H);
        let mut spot: Option<LogicalPosition<f64>> = None;
        if let Ok(Some(mon)) = win.current_monitor() {
            let scale = mon.scale_factor();
            let msize = mon.size().to_logical::<f64>(scale);
            let mpos = mon.position().to_logical::<f64>(scale);
            w = w.min(msize.width - 40.0);
            h = h.min(msize.height - 120.0);
            spot = Some(LogicalPosition::new(
                mpos.x + msize.width - w - 28.0,
                mpos.y + 60.0,
            ));
        }

        win.set_size(LogicalSize::new(w, h))
            .map_err(|e| e.to_string())?;
        if let Some(p) = spot {
            let _ = win.set_position(p);
        }
        let _ = win.set_always_on_top(true);
        if let Some(t) = title {
            let _ = win.set_title(&t);
        }
        let _ = win.set_focus();
    } else {
        ACTIVE.store(false, Ordering::Relaxed);
        let _ = win.set_always_on_top(false);
        let _ = win.set_title(APP_TITLE);
        let _ = win.set_min_size(Some(LogicalSize::new(NORMAL_MIN_W, NORMAL_MIN_H)));
        if let Some(s) = SAVED.lock().take() {
            let _ = win.set_size(s.size);
            let _ = win.set_position(s.pos);
            if s.maximized {
                let _ = win.maximize();
            }
        }
        let _ = win.set_focus();
    }

    Ok(())
}
