use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl, Window};

const LABEL: &str = "dockbrowser";

fn find(window: &Window) -> Option<tauri::Webview> {
    window.webviews().into_iter().find(|w| w.label() == LABEL)
}

fn parse(url: &str) -> Result<tauri::Url, String> {
    url.parse::<tauri::Url>().map_err(|e| e.to_string())
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
    let window = app.get_window("main").ok_or("no main window")?;
    let w = w.max(1.0);
    let h = h.max(1.0);
    if let Some(view) = find(&window) {
        view.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        view.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
        let _ = view.show();
        return Ok(());
    }
    let target = parse(&url)?;
    let builder = tauri::webview::WebviewBuilder::new(LABEL, WebviewUrl::External(target));
    window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn browser_navigate(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let window = app.get_window("main").ok_or("no main window")?;
    let mut view = find(&window).ok_or("browser not open")?;
    let target = parse(&url)?;
    view.navigate(target).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_hide(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_window("main").ok_or("no main window")?;
    if let Some(view) = find(&window) {
        let _ = view.hide();
        let _ = view.set_size(LogicalSize::new(1.0, 1.0));
        let _ = view.set_position(LogicalPosition::new(-4000.0, -4000.0));
    }
    Ok(())
}

#[tauri::command]
pub fn browser_close(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_window("main").ok_or("no main window")?;
    if let Some(view) = find(&window) {
        let _ = view.close();
    }
    Ok(())
}

#[tauri::command]
pub fn browser_nav_action(app: tauri::AppHandle, action: String) -> Result<(), String> {
    let window = app.get_window("main").ok_or("no main window")?;
    let view = find(&window).ok_or("browser not open")?;
    let js = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        _ => return Err("unknown action".into()),
    };
    view.eval(js).map_err(|e| e.to_string())
}
