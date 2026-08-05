use std::io::{ErrorKind, Read, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::SharedState;

const MAX_BUFFER: usize = 200_000;
const BUSY_THRESHOLD: Duration = Duration::from_secs(5);
const QUIET_THRESHOLD: Duration = Duration::from_secs(5);
const WORK_MARKERS: [&str; 4] = [
    "esc to interrupt",
    "escape to interrupt",
    "ctrl+c to stop",
    "tokens ·",
];
const RECENT_WINDOW: usize = 4000;

pub struct PtySession {
    pub input: Sender<Vec<u8>>,
    pub master: Box<dyn MasterPty + Send>,
    pub child: Box<dyn Child + Send + Sync>,
    pub buffer: String,
    pub workspace_id: Option<String>,
    pub last_output: Instant,
    pub prev_output: Instant,
    pub busy_for: Duration,
    pub announced: bool,
    pub saw_work: bool,
    pub saw_input: bool,
    pub recent: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyCreateOptions {
    pub id: String,
    pub command: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub workspace_id: Option<String>,
    pub config_dir: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyCreateResult {
    pub success: bool,
    pub pid: Option<u32>,
    pub error: Option<String>,
    pub existing: bool,
}

#[cfg(windows)]
fn registry_path(root: &str, key: &str) -> String {
    let out = std::process::Command::new("reg")
        .args(["query", root, "/v", key])
        .output();
    if let Ok(out) = out {
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        for line in text.lines() {
            if let Some(idx) = line.to_lowercase().find("reg_") {
                let rest = &line[idx..];
                let mut parts = rest.splitn(2, char::is_whitespace);
                parts.next();
                if let Some(v) = parts.next() {
                    return v.trim().to_string();
                }
            }
        }
    }
    String::new()
}

#[cfg(windows)]
fn expand_vars(value: &str) -> String {
    let mut result = value.to_string();
    while let Some(start) = result.find('%') {
        if let Some(rel_end) = result[start + 1..].find('%') {
            let end = start + 1 + rel_end;
            let name = result[start + 1..end].to_string();
            let replacement = std::env::vars()
                .find(|(k, _)| k.eq_ignore_ascii_case(&name))
                .map(|(_, v)| v)
                .unwrap_or_else(|| format!("%{}%", name));
            if replacement.contains('%') && replacement[1..].contains('%') {
                result.replace_range(start..=end, &replacement.replace('%', ""));
            } else {
                result.replace_range(start..=end, &replacement);
            }
        } else {
            break;
        }
    }
    result
}

#[cfg(windows)]
pub fn merged_path() -> String {
    let machine = registry_path(
        "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
        "Path",
    );
    let user = registry_path("HKCU\\Environment", "Path");
    let current = std::env::var("Path").unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    let mut merged: Vec<String> = Vec::new();
    for chunk in [expand_vars(&machine), expand_vars(&user), current] {
        for dir in chunk.split(';') {
            let d = dir.trim();
            if d.is_empty() {
                continue;
            }
            let norm = d.to_lowercase().trim_end_matches('\\').to_string();
            if seen.insert(norm) {
                merged.push(d.to_string());
            }
        }
    }
    merged.join(";")
}

#[cfg(not(windows))]
pub fn merged_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    let mut merged: Vec<String> = Vec::new();
    for dir in current.split(':') {
        let d = dir.trim();
        if !d.is_empty() && seen.insert(d.trim_end_matches('/').to_string()) {
            merged.push(d.to_string());
        }
    }
    if let Some(home) = dirs::home_dir() {
        for extra in [".local/bin", ".npm-global/bin", ".bun/bin", ".cargo/bin"] {
            let p = home.join(extra);
            let s = p.to_string_lossy().to_string();
            if p.is_dir() && seen.insert(s.trim_end_matches('/').to_string()) {
                merged.push(s);
            }
        }
    }
    merged.join(":")
}

const PATH_VAR: &str = if cfg!(windows) { "Path" } else { "PATH" };

fn login_shell() -> (String, Vec<String>) {
    if cfg!(windows) {
        return ("cmd.exe".to_string(), Vec::new());
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    (shell, vec!["-l".to_string()])
}

#[tauri::command(async)]
pub fn pty_create(
    app: AppHandle,
    state: State<'_, SharedState>,
    opts: PtyCreateOptions,
) -> PtyCreateResult {
    if state.ptys.lock().contains_key(&opts.id) {
        return PtyCreateResult { success: true, pid: None, error: None, existing: true };
    }
    match create_inner(&app, state.inner(), opts) {
        Ok(pid) => PtyCreateResult { success: true, pid: Some(pid), error: None, existing: false },
        Err(e) => PtyCreateResult { success: false, pid: None, error: Some(e.to_string()), existing: false },
    }
}

fn create_inner(
    app: &AppHandle,
    state: &SharedState,
    opts: PtyCreateOptions,
) -> Result<u32, Box<dyn std::error::Error>> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: opts.rows.max(4),
        cols: opts.cols.max(20),
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let (shell, shell_args) = login_shell();
    let mut cmd = CommandBuilder::new(shell);
    for arg in shell_args {
        cmd.arg(arg);
    }
    let fallback_home = if cfg!(windows) { "C:\\" } else { "/" };
    let home = dirs::home_dir()
        .unwrap_or(PathBuf::from(fallback_home))
        .to_string_lossy()
        .to_string();
    let cwd = if opts.cwd.is_empty() || !PathBuf::from(&opts.cwd).is_dir() {
        home
    } else {
        opts.cwd.clone()
    };
    cmd.cwd(&cwd);
    cmd.env(PATH_VAR, merged_path());
    cmd.env("TERM", "xterm-256color");
    if let Some(dir) = &opts.config_dir {
        if !dir.is_empty() {
            cmd.env("CLAUDE_CONFIG_DIR", dir);
        }
    }

    let child = pair.slave.spawn_command(cmd)?;
    let pid = child.process_id().unwrap_or(0);
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;

    // A write to a ConPTY blocks whenever the child is not draining its input,
    // which a busy agent regularly is. Doing that write inline froze the whole
    // app: the command runs on the main thread and holds the one lock that
    // guards every session, so a single stuck terminal stopped all output,
    // all typing, and left newly added agents on a black screen. Each session
    // now owns a writer thread and commands only hand bytes to a channel.
    let (input_tx, input_rx) = channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(chunk) = input_rx.recv() {
            let mut rest: &[u8] = &chunk;
            let mut stalls = 0u32;
            while !rest.is_empty() {
                match writer.write(rest) {
                    Ok(0) => break,
                    Ok(n) => {
                        rest = &rest[n..];
                        stalls = 0;
                    }
                    Err(e) if e.kind() == ErrorKind::Interrupted => {}
                    Err(e) if e.kind() == ErrorKind::WouldBlock => {
                        stalls += 1;
                        if stalls > 600 {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
            let _ = writer.flush();
        }
    });

    let mut command = opts.command.clone();
    if command.starts_with("claude") && !command.contains("--session-id") {
        command = format!("{} --session-id {}", command, uuid::Uuid::new_v4());
    }

    let now = Instant::now();
    let session = PtySession {
        input: input_tx.clone(),
        master: pair.master,
        child,
        buffer: String::new(),
        workspace_id: opts.workspace_id.clone(),
        last_output: now,
        prev_output: now,
        busy_for: Duration::ZERO,
        announced: true,
        saw_work: false,
        saw_input: false,
        recent: String::new(),
    };
    state.ptys.lock().insert(opts.id.clone(), session);

    let id_reader = opts.id.clone();
    let app_reader = app.clone();
    let st_reader = state.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let cleaned = clean_output(&data);
                    {
                        let mut ptys = st_reader.ptys.lock();
                        if let Some(s) = ptys.get_mut(&id_reader) {
                            s.buffer.push_str(&data);
                            if s.buffer.len() > MAX_BUFFER {
                                let cut = s.buffer.len() - MAX_BUFFER;
                                let mut idx = cut;
                                while idx < s.buffer.len() && !s.buffer.is_char_boundary(idx) {
                                    idx += 1;
                                }
                                s.buffer.drain(..idx);
                            }
                            let now = Instant::now();
                            let gap = now.duration_since(s.last_output);
                            if gap < Duration::from_secs(2) {
                                s.busy_for += gap;
                            }
                            s.prev_output = s.last_output;
                            s.last_output = now;
                            if s.saw_input && s.busy_for >= BUSY_THRESHOLD {
                                s.saw_work = true;
                                s.announced = false;
                            }
                            s.recent.push_str(&cleaned);
                            if s.recent.len() > RECENT_WINDOW {
                                let cut = s.recent.len() - RECENT_WINDOW;
                                let mut idx = cut;
                                while idx < s.recent.len() && !s.recent.is_char_boundary(idx) {
                                    idx += 1;
                                }
                                s.recent.drain(..idx);
                            }
                            if contains_work_marker(&s.recent) {
                                s.saw_work = true;
                                s.announced = false;
                                s.recent.clear();
                            }
                        } else {
                            break;
                        }
                    }
                    let _ = app_reader.emit("pty-data", serde_json::json!({ "id": id_reader, "data": data }));
                }
                Err(_) => break,
            }
        }
        let _ = app_reader.emit("pty-exit", serde_json::json!({ "id": id_reader }));
        st_reader.ptys.lock().remove(&id_reader);
    });

    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        let _ = input_tx.send(format!("{}\r", command).into_bytes());
    });

    Ok(pid)
}

fn contains_work_marker(recent: &str) -> bool {
    let mut norm = String::with_capacity(recent.len());
    let mut gap = false;
    for ch in recent.chars() {
        if ch.is_whitespace() {
            gap = true;
            continue;
        }
        if gap && !norm.is_empty() {
            norm.push(' ');
        }
        gap = false;
        for lc in ch.to_lowercase() {
            norm.push(lc);
        }
    }
    WORK_MARKERS.iter().any(|m| norm.contains(m))
}

#[tauri::command(async)]
pub fn pty_write(app: AppHandle, state: State<'_, SharedState>, id: String, data: String) -> bool {
    if data.len() <= 4 && data.chars().any(|c| c.is_control() && c != '\r' && c != '\n') {
        let hex: Vec<String> = data.bytes().map(|b| format!("{:02x}", b)).collect();
        crate::files::log_line(&app, &format!("pty_write {} bytes={}", id, hex.join(" ")));
    }
    let input = {
        let mut ptys = state.ptys.lock();
        let Some(s) = ptys.get_mut(&id) else { return false };
        if data.contains('\r') || data.contains('\n') {
            s.saw_input = true;
            s.busy_for = Duration::ZERO;
            s.announced = true;
            s.recent.clear();
        }
        s.input.clone()
    };
    input.send(data.into_bytes()).is_ok()
}

#[tauri::command(async)]
pub fn pty_resize(state: State<'_, SharedState>, id: String, cols: u16, rows: u16) {
    let ptys = state.ptys.lock();
    if let Some(s) = ptys.get(&id) {
        let _ = s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
}

#[tauri::command(async)]
pub fn pty_kill(state: State<'_, SharedState>, id: String) {
    let session = state.ptys.lock().remove(&id);
    if let Some(mut s) = session {
        let _ = s.child.kill();
    }
}

pub fn kill_all(state: &SharedState) {
    let sessions: Vec<PtySession> = {
        let mut ptys = state.ptys.lock();
        ptys.drain().map(|(_id, s)| s).collect()
    };
    for mut s in sessions {
        if let Some(pid) = s.child.process_id() {
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .creation_flags(0x0800_0000)
                    .output();
            }
            #[cfg(not(windows))]
            {
                let _ = std::process::Command::new("pkill")
                    .args(["-TERM", "-P", &pid.to_string()])
                    .output();
            }
        }
        let _ = s.child.kill();
    }
}

pub fn clean_output(raw: &str) -> String {
    let stripped = strip_ansi_escapes::strip(raw.as_bytes());
    String::from_utf8_lossy(&stripped).to_string()
}

#[tauri::command(async)]
pub fn pty_output(state: State<'_, SharedState>, id: String, tail: Option<usize>, raw: Option<bool>) -> String {
    let buffer = {
        let ptys = state.ptys.lock();
        let Some(s) = ptys.get(&id) else { return String::new() };
        s.buffer.clone()
    };
    let text = if raw.unwrap_or(false) { buffer } else { clean_output(&buffer) };
    let tail = tail.unwrap_or(4000);
    if text.len() > tail {
        let start = text.len() - tail;
        let mut idx = start;
        while idx < text.len() && !text.is_char_boundary(idx) {
            idx += 1;
        }
        text[idx..].to_string()
    } else {
        text
    }
}

fn tail_chars(text: &str, n: usize) -> &str {
    if text.len() <= n {
        return text;
    }
    let mut idx = text.len() - n;
    while idx < text.len() && !text.is_char_boundary(idx) {
        idx += 1;
    }
    &text[idx..]
}

pub fn activity_monitor(app: AppHandle, state: SharedState) {
    loop {
        std::thread::sleep(Duration::from_millis(300));
        let mut done: Vec<(String, String, bool)> = Vec::new();
        {
            let mut ptys = state.ptys.lock();
            for (id, s) in ptys.iter_mut() {
                if !s.announced && s.last_output.elapsed() >= QUIET_THRESHOLD {
                    s.announced = true;
                    s.busy_for = Duration::ZERO;
                    s.recent.clear();
                    done.push((id.clone(), tail_chars(&s.buffer, 12000).to_string(), s.saw_work));
                    s.saw_work = false;
                }
            }
        }
        let done: Vec<(String, String, bool)> = done
            .into_iter()
            .map(|(id, raw, worked)| (id, tail_chars(&clean_output(&raw), 3000).to_string(), worked))
            .collect();
        for (id, tail, worked) in done {
            crate::files::log_line(&app, &format!("agent-done emit id={} worked={}", id, worked));
            let _ = app.emit("agent-done", serde_json::json!({ "id": id, "tail": tail, "worked": worked }));
        }
    }
}
