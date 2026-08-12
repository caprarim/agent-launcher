use serde::Serialize;
use std::io::Write as IoWrite;
use tauri::Manager;
use tauri_plugin_clipboard_manager::ClipboardExt;

pub fn log_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path()
        .app_config_dir()
        .map(|d| d.join("debug.log"))
        .unwrap_or_else(|_| std::path::PathBuf::from("debug.log"))
}

pub fn log_line(app: &tauri::AppHandle, line: &str) {
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("debug.log"))
        {
            let ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let _ = writeln!(f, "{} {}", ms, line);
        }
    }
}

#[tauri::command]
pub fn debug_log(app: tauri::AppHandle, line: String) {
    log_line(&app, &line);
}

#[tauri::command]
pub fn focus_main(app: tauri::AppHandle) {
    if let Some(w) = app.get_window("main") {
        if w.is_focused().unwrap_or(false) && !w.is_minimized().unwrap_or(false) {
            return;
        }
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn prune_pasted_images(dir: &std::path::Path, keep: usize) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<_> = rd
        .flatten()
        .filter(|e| e.path().extension().map(|x| x == "png").unwrap_or(false))
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by_key(|e| {
        e.metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
    });
    for e in files.iter().take(files.len() - keep) {
        let _ = std::fs::remove_file(e.path());
    }
}

#[tauri::command]
pub fn clipboard_image_file(app: tauri::AppHandle) -> Result<String, String> {
    let image = app.clipboard().read_image().map_err(|e| e.to_string())?;
    let width = image.width();
    let height = image.height();
    if width == 0 || height == 0 {
        return Err("clipboard image is empty".into());
    }
    let rgba = image.rgba().to_vec();

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("pasted-images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("paste-{}.png", stamp));

    let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(&rgba).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;

    prune_pasted_images(&dir, 20);
    Ok(path.to_string_lossy().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut out = Vec::new();
    let rd = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| {
        let p = e.path();
        (!p.is_dir(), e.file_name().to_string_lossy().to_lowercase())
    });
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let p = e.path();
        let is_dir = p.is_dir();
        if !is_dir {
            let big = e.metadata().map(|m| m.len() > 2_000_000).unwrap_or(false);
            if big {
                continue;
            }
        }
        out.push(DirEntry {
            name,
            path: p.to_string_lossy().to_string(),
            is_dir,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "no home directory".to_string())
}

#[tauri::command]
pub fn config_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_config_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
