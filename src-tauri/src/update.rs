#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::State;

use crate::SharedState;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;
#[cfg(windows)]
const INSTALL_DIR_NAME: &str = "Agent Launcher ADE";
#[cfg(windows)]
const APP_EXE_NAME: &str = "agent-launcher.exe";
#[cfg(windows)]
const SIDECARS: [&str; 2] = ["conpty.dll", "OpenConsole.exe"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub version: String,
    pub current_built: u64,
    pub newest_built: u64,
    pub source: String,
    pub message: String,
}

#[cfg(windows)]
fn mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(windows)]
fn install_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::data_local_dir().unwrap_or_else(|| PathBuf::from(".")));
    base.join(INSTALL_DIR_NAME)
}

#[cfg(windows)]
fn search_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(custom) = std::env::var("AGENT_LAUNCHER_UPDATE_DIR") {
        if !custom.trim().is_empty() {
            roots.push(PathBuf::from(custom));
        }
    }
    roots.push(PathBuf::from(
        "D:\\dev\\agent-terminals\\build-cache\\agent-launcher-v2\\release",
    ));
    roots.push(PathBuf::from(
        "C:\\dev\\agent-terminals\\agent-launcher-v2\\src-tauri\\target\\release",
    ));
    roots
}

/// The freshest built `agent-launcher.exe` across the known build outputs. The
/// update copies that file straight over the installed one, so its timestamp is
/// what both sides of the comparison are measured against.
#[cfg(windows)]
fn newest_build() -> Option<(PathBuf, u64)> {
    let mut best: Option<(PathBuf, u64)> = None;
    for root in search_roots() {
        let exe = root.join(APP_EXE_NAME);
        if !exe.exists() {
            continue;
        }
        let built = mtime_ms(&exe);
        if best.as_ref().map(|(_, b)| built > *b).unwrap_or(true) {
            best = Some((exe, built));
        }
    }
    best
}

#[cfg(windows)]
fn running_exe() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from(APP_EXE_NAME))
}

/// What the running app counts as "the build I am on". Copy-Item preserves the
/// source timestamp, so after an update the installed exe carries exactly the
/// build time of the exe it was copied from and compares cleanly.
#[cfg(windows)]
fn baseline_built() -> u64 {
    let running = running_exe();
    let running_built = mtime_ms(&running);
    let installed_exe = install_dir().join(APP_EXE_NAME);
    if running == installed_exe || !installed_exe.exists() {
        return running_built;
    }
    let installed_built = mtime_ms(&installed_exe);
    if installed_built < running_built {
        installed_built
    } else {
        running_built
    }
}

#[cfg(windows)]
#[tauri::command(async)]
pub fn update_check() -> UpdateInfo {
    let current_built = baseline_built();
    let Some((source, newest_built)) = newest_build() else {
        return UpdateInfo {
            available: false,
            version: env!("CARGO_PKG_VERSION").to_string(),
            current_built,
            newest_built: 0,
            source: String::new(),
            message: "No build found to update from".to_string(),
        };
    };
    let available = newest_built > current_built.saturating_add(2000);
    UpdateInfo {
        available,
        version: env!("CARGO_PKG_VERSION").to_string(),
        current_built,
        newest_built,
        source: source.to_string_lossy().to_string(),
        message: if available {
            "Update found, installing now".to_string()
        } else {
            "You are on the latest build".to_string()
        },
    }
}

#[cfg(windows)]
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Copies the new build over the installed app and restarts it.
///
/// This used to shell out to the NSIS installer with `/S`. That silently did
/// nothing: the installer aborts in silent mode when it cannot take over the
/// install folder, nothing was logged, and the app just closed and came back on
/// the old build. The install folder only ever holds the exe plus its two conpty
/// sidecars, so copying those files is the whole update, with the installer kept
/// only as a fallback and every step written to update.log.
#[cfg(windows)]
#[tauri::command(async)]
pub fn update_apply(app: tauri::AppHandle, state: State<'_, SharedState>) -> Result<(), String> {
    let Some((source, _built)) = newest_build() else {
        return Err("No build found to update from".to_string());
    };

    let dir = install_dir();
    let target_exe = dir.join(APP_EXE_NAME);
    let running = running_exe();
    let sidecar_src = source
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let relaunch = if target_exe.exists() { target_exe.clone() } else { running.clone() };
    let log_path = crate::files::log_path(&app);
    let installer = installer_for(&sidecar_src);
    let pid = std::process::id();

    let mut script = String::new();
    script.push_str("$ErrorActionPreference = 'Continue'\n");
    script.push_str(&format!("$log = {}\n", ps_quote(&log_path.to_string_lossy())));
    script.push_str("function Note($m) { Add-Content -Path $log -Value \"$([DateTimeOffset]::Now.ToUnixTimeMilliseconds()) update $m\" }\n");
    script.push_str(&format!("$target = {}\n", pid));
    script.push_str("for ($i = 0; $i -lt 300; $i++) {\n");
    script.push_str("  if (-not (Get-Process -Id $target -ErrorAction SilentlyContinue)) { break }\n");
    script.push_str("  Start-Sleep -Milliseconds 200\n");
    script.push_str("}\n");
    script.push_str("Start-Sleep -Milliseconds 600\n");
    script.push_str(&format!("$src = {}\n", ps_quote(&source.to_string_lossy())));
    script.push_str(&format!("$dir = {}\n", ps_quote(&dir.to_string_lossy())));
    script.push_str(&format!("$dst = {}\n", ps_quote(&target_exe.to_string_lossy())));
    script.push_str(&format!("$srcDir = {}\n", ps_quote(&sidecar_src.to_string_lossy())));
    script.push_str("if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }\n");
    script.push_str("$copied = $false\n");
    // The installed exe stays locked for a moment after the process dies, so the
    // copy retries instead of failing the whole update on the first attempt.
    script.push_str("for ($i = 0; $i -lt 40; $i++) {\n");
    script.push_str("  try { Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop; $copied = $true; break }\n");
    script.push_str("  catch { Start-Sleep -Milliseconds 500 }\n");
    script.push_str("}\n");
    script.push_str("if ($copied) { Note \"copied exe to $dst\" } else { Note 'exe copy failed, falling back to installer' }\n");
    script.push_str(&format!(
        "foreach ($f in @({})) {{\n",
        SIDECARS
            .iter()
            .map(|f| ps_quote(f))
            .collect::<Vec<_>>()
            .join(", ")
    ));
    script.push_str("  $from = Join-Path $srcDir $f\n");
    script.push_str("  if (Test-Path $from) { Copy-Item -LiteralPath $from -Destination (Join-Path $dir $f) -Force }\n");
    script.push_str("}\n");
    if let Some(inst) = &installer {
        script.push_str(&format!("$installer = {}\n", ps_quote(&inst.to_string_lossy())));
        script.push_str("if (-not $copied) {\n");
        script.push_str("  Note \"running installer $installer\"\n");
        script.push_str("  $p = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru\n");
        script.push_str("  Note \"installer exit $($p.ExitCode)\"\n");
        script.push_str("  if ($p.ExitCode -ne 0) { Note 'installer failed, app left on the old build' }\n");
        script.push_str("}\n");
    } else {
        script.push_str("if (-not $copied) { Note 'no installer fallback available' }\n");
    }
    script.push_str(&format!("$exe = {}\n", ps_quote(&relaunch.to_string_lossy())));
    // Only skip the relaunch when the old app somehow outlived the copy, so a
    // second window is never stacked on top of a still running one.
    script.push_str("$live = @(Get-Process -Name 'agent-launcher' -ErrorAction SilentlyContinue)\n");
    script.push_str("if ($live.Count -gt 0) { Note \"skipped relaunch, $($live.Count) still running\" }\n");
    script.push_str("elseif (Test-Path $exe) {\n");
    script.push_str("  Note \"relaunching $exe built $((Get-Item $exe).LastWriteTime)\"\n");
    script.push_str("  Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe)\n");
    script.push_str("} else { Note \"cannot relaunch, missing $exe\" }\n");

    let script_path = std::env::temp_dir().join(format!("agent-launcher-update-{}.ps1", pid));
    std::fs::write(&script_path, script).map_err(|e| e.to_string())?;

    crate::files::log_line(
        &app,
        &format!(
            "update apply source={} target={} relaunch={}",
            source.display(),
            target_exe.display(),
            relaunch.display()
        ),
    );

    std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
            &script_path.to_string_lossy(),
        ])
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .map_err(|e| e.to_string())?;

    crate::pty::kill_all(state.inner());
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        handle.exit(0);
    });
    Ok(())
}

#[cfg(windows)]
fn installer_for(root: &Path) -> Option<PathBuf> {
    let mut best: Option<(PathBuf, u64)> = None;
    let rd = std::fs::read_dir(root.join("bundle").join("nsis")).ok()?;
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if !name.ends_with(".exe") || !name.contains("setup") {
            continue;
        }
        let built = mtime_ms(&path);
        if best.as_ref().map(|(_, b)| built > *b).unwrap_or(true) {
            best = Some((path, built));
        }
    }
    best.map(|(p, _)| p)
}

#[cfg(not(windows))]
#[tauri::command(async)]
pub fn update_check() -> UpdateInfo {
    UpdateInfo {
        available: false,
        version: env!("CARGO_PKG_VERSION").to_string(),
        current_built: 0,
        newest_built: 0,
        source: String::new(),
        message: "Update by installing the newest .deb from GitHub Releases".to_string(),
    }
}

#[cfg(not(windows))]
#[tauri::command(async)]
pub fn update_apply(_app: tauri::AppHandle, _state: State<'_, SharedState>) -> Result<(), String> {
    Err("On Linux, download the newest .deb from GitHub Releases and run sudo apt install ./agent-launcher.deb".to_string())
}
