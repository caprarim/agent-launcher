use std::cell::RefCell;
use std::sync::mpsc::channel;

use tauri::Manager;
use wry::dpi::{LogicalPosition, LogicalSize};
use wry::{Rect, WebView, WebViewBuilder};

thread_local! {
    static VIEW: RefCell<Option<WebView>> = const { RefCell::new(None) };
}

#[cfg(target_os = "linux")]
fn positioning_supported() -> bool {
    use gtk::glib::object::ObjectExt;
    gtk::gdk::Display::default()
        .map(|d| d.type_().name().contains("X11"))
        .unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
fn positioning_supported() -> bool {
    true
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect {
        position: LogicalPosition::new(x, y).into(),
        size: LogicalSize::new(w.max(1.0), h.max(1.0)).into(),
    }
}

fn on_main<F, T>(app: &tauri::AppHandle, f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn browser_show(
    app: tauri::AppHandle,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let handle = app.clone();
    on_main(&app, move || {
        if !positioning_supported() {
            return Err("unsupported-display".into());
        }
        let window = handle
            .get_webview_window("main")
            .ok_or("no main window")?;
        let bounds = rect(x, y, w, h);
        VIEW.with(|cell| {
            let mut slot = cell.borrow_mut();
            if let Some(view) = slot.as_ref() {
                view.set_bounds(bounds).map_err(|e| e.to_string())?;
                view.set_visible(true).map_err(|e| e.to_string())?;
                return Ok(());
            }
            let view = WebViewBuilder::new()
                .with_url(&url)
                .with_bounds(bounds)
                .build_as_child(&window)
                .map_err(|e| e.to_string())?;
            *slot = Some(view);
            Ok(())
        })
    })
}

#[tauri::command]
pub fn browser_navigate(app: tauri::AppHandle, url: String) -> Result<(), String> {
    on_main(&app, move || {
        VIEW.with(|cell| match cell.borrow().as_ref() {
            Some(view) => view.load_url(&url).map_err(|e| e.to_string()),
            None => Err("browser not open".into()),
        })
    })
}

#[tauri::command]
pub fn browser_hide(app: tauri::AppHandle) -> Result<(), String> {
    on_main(&app, move || {
        VIEW.with(|cell| {
            if let Some(view) = cell.borrow().as_ref() {
                let _ = view.set_visible(false);
            }
            Ok(())
        })
    })
}

#[tauri::command]
pub fn browser_close(app: tauri::AppHandle) -> Result<(), String> {
    on_main(&app, move || {
        VIEW.with(|cell| {
            cell.borrow_mut().take();
            Ok(())
        })
    })
}

#[tauri::command]
pub fn browser_nav_action(app: tauri::AppHandle, action: String) -> Result<(), String> {
    let js = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        _ => return Err("unknown action".into()),
    };
    on_main(&app, move || {
        VIEW.with(|cell| match cell.borrow().as_ref() {
            Some(view) => view.evaluate_script(js).map_err(|e| e.to_string()),
            None => Err("browser not open".into()),
        })
    })
}
