use once_cell::sync::Lazy;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};

use crate::accounts;
use crate::paths;

const MAX_BUFFER: usize = 200_000;
// Trim the ring buffer in chunks rather than on every write, so fast output
// doesn't memmove 200KB per 8KB read.
const BUFFER_SLACK: usize = 64_000;

#[derive(Deserialize)]
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

#[derive(Serialize, Default)]
pub struct PtyCreateResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Default)]
pub struct PtyMeta {
    pub workspace_id: Option<String>,
    pub config_dir: Option<String>,
    pub cwd: String,
    pub session_id: Option<String>,
}

struct PtySession {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    meta: PtyMeta,
}

// A Claude terminal that prints a hard "limit reached" message triggers an
// automatic account swap. Matches only the hard wording — NOT promo banners
// ("If you hit your limit ...") or "Approaching ... limit" warnings.
static LIMIT_REACHED_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)(?:5-hour|weekly|session|usage|rate)\s+limit\s+reached|reached\s+your\s+(?:5-hour|weekly|session|usage|rate)\s+limit",
    )
    .expect("limit regex")
});

static ANSI_CSI_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").expect("ansi csi regex"));
static ANSI_OSC_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\x1b\][^\x07]*(?:\x07|\x1b\\)").expect("ansi osc regex"));
static CONTROL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[\x00-\x08\x0b-\x1f]").expect("control regex"));

/// Strip ANSI / VT control sequences so text read back over the control API (or
/// scanned for a usage-limit message) is plain.
pub fn strip_ansi(s: &str) -> String {
    let s = ANSI_OSC_RE.replace_all(s, "");
    let s = ANSI_CSI_RE.replace_all(&s, "");
    CONTROL_RE.replace_all(&s, "").to_string()
}

const AUTO_SWITCH_COOLDOWN: Duration = Duration::from_secs(5 * 60);

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
    buffers: Mutex<HashMap<String, String>>,
    limit_tails: Mutex<HashMap<String, String>>,
    last_auto_switch: Mutex<HashMap<String, Instant>>,
}

// The shell each terminal runs the agent CLI inside.
fn login_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

// Per-workspace Claude config dir. Deriving it here (not only in the renderer)
// guarantees a terminal can never fall back to the shared global ~/.claude just
// because it was created before the renderer resolved the workspace's dir.
// The 'default' workspace intentionally keeps the global config.
pub fn workspace_config_dir(workspace_id: &str) -> String {
    let dir = paths::workspace_config_dir(workspace_id);
    accounts::seed_config_dir(&dir);
    let as_str = dir.to_string_lossy().to_string();
    accounts::watch_config_dir(Some(&as_str));
    as_str
}

pub fn resolve_config_dir(
    workspace_id: Option<&str>,
    config_dir: Option<&str>,
) -> Option<String> {
    if let Some(dir) = config_dir {
        return Some(dir.to_string());
    }
    match workspace_id {
        Some(id) if id != "default" => Some(workspace_config_dir(id)),
        _ => None,
    }
}

// Terminal bytes arrive in arbitrary chunks, so a multi-byte UTF-8 character can
// straddle two reads. Carrying the incomplete tail over is what keeps box-
// drawing characters (Claude's prompt frame) from turning into replacement
// characters mid-render.
fn decode_chunk(pending: &mut Vec<u8>, chunk: &[u8]) -> String {
    pending.extend_from_slice(chunk);
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_string();
            pending.clear();
            out
        }
        Err(err) => {
            let valid_up_to = err.valid_up_to();
            let out = String::from_utf8_lossy(&pending[..valid_up_to]).to_string();
            match err.error_len() {
                // Genuinely invalid bytes: drop them so `pending` can't grow forever.
                Some(len) => {
                    let rest = pending[valid_up_to + len..].to_vec();
                    *pending = rest;
                    format!("{out}\u{fffd}")
                }
                // Truncated sequence at the end: keep it for the next read.
                None => {
                    let rest = pending[valid_up_to..].to_vec();
                    *pending = rest;
                    out
                }
            }
        }
    }
}

impl PtyManager {
    pub fn create(
        &self,
        app: &AppHandle,
        opts: PtyCreateOptions,
        control_port: u16,
        on_data: Channel<String>,
    ) -> PtyCreateResult {
        match self.try_create(app, opts, control_port, on_data) {
            Ok(pid) => PtyCreateResult {
                success: true,
                pid,
                error: None,
            },
            Err(e) => PtyCreateResult {
                success: false,
                pid: None,
                error: Some(e),
            },
        }
    }

    fn try_create(
        &self,
        app: &AppHandle,
        opts: PtyCreateOptions,
        control_port: u16,
        on_data: Channel<String>,
    ) -> Result<Option<u32>, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: opts.rows.max(1),
                cols: opts.cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let config_dir = resolve_config_dir(
            opts.workspace_id.as_deref(),
            opts.config_dir.as_deref(),
        );

        let cwd = if opts.cwd.trim().is_empty() {
            paths::home_dir().to_string_lossy().to_string()
        } else {
            opts.cwd.clone()
        };

        let mut cmd = CommandBuilder::new(login_shell());
        for (key, value) in std::env::vars() {
            cmd.env(key, value);
        }
        cmd.env("TERM", "xterm-256color");
        if let Some(dir) = &config_dir {
            cmd.env("CLAUDE_CONFIG_DIR", dir);
        }
        // Agents inside the terminal must talk to THIS instance's control API,
        // not whichever instance got the default port first.
        cmd.env("AGENT_LAUNCHER_PORT", control_port.to_string());
        cmd.cwd(&cwd);

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("could not start {}: {e}", login_shell()))?;
        // Holding the slave open would keep the pty from ever reporting EOF.
        drop(pair.slave);

        let pid = child.process_id();
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        // Claude terminals get a pinned session id so an account-switch restart
        // can resume THIS terminal's conversation. `--continue` can't: it resumes
        // the cwd's single most recent session, so several terminals in one
        // project all pile onto the same conversation and the rest are lost.
        let mut command = opts.command.clone();
        let mut session_id: Option<String> = None;
        let starts_with_claude = command == "claude" || command.starts_with("claude ");
        if opts.id.starts_with("claude-") && starts_with_claude && !command.contains("--session-id")
        {
            let id = uuid::Uuid::new_v4().to_string();
            command = format!("{command} --session-id {id}");
            session_id = Some(id);
        }

        let session = Arc::new(PtySession {
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            meta: PtyMeta {
                workspace_id: opts.workspace_id.clone(),
                config_dir: config_dir.clone(),
                cwd,
                session_id,
            },
        });

        self.sessions
            .lock()
            .unwrap()
            .insert(opts.id.clone(), session);
        self.buffers.lock().unwrap().insert(opts.id.clone(), String::new());

        self.spawn_reader(app, &opts.id, reader, on_data);
        self.spawn_exit_watcher(app, &opts.id);

        // A short delay before the CLI command so the shell has printed its
        // prompt; writing into it earlier loses the line on some shells.
        let write_id = opts.id.clone();
        let app_for_cmd = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            let state = crate::state(&app_for_cmd);
            let line = if cfg!(windows) {
                format!("{command}\r")
            } else {
                format!("{command}\n")
            };
            state.ptys.write(&write_id, &line);
        });

        Ok(pid)
    }

    // Terminal output is the app's hot path — five agents streaming at once is
    // normal. It goes back over a per-terminal Channel rather than app.emit:
    // an event is broadcast to every listener and re-dispatched by id in JS,
    // while a channel writes straight to the one xterm instance that wants it.
    fn spawn_reader(
        &self,
        app: &AppHandle,
        id: &str,
        mut reader: Box<dyn Read + Send>,
        on_data: Channel<String>,
    ) {
        let app = app.clone();
        let id = id.to_string();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut pending: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let text = decode_chunk(&mut pending, &buf[..n]);
                        if text.is_empty() {
                            continue;
                        }
                        let state = crate::state(&app);
                        state.ptys.append_output(&id, &text);
                        if id.starts_with("claude-") {
                            state.ptys.watch_for_usage_limit(&app, &id, &text);
                        }
                        if on_data.send(text).is_err() {
                            break; // the window went away
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    fn spawn_exit_watcher(&self, app: &AppHandle, id: &str) {
        let app = app.clone();
        let id = id.to_string();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(250));
            let state = crate::state(&app);
            let session = match state.ptys.sessions.lock().unwrap().get(&id).cloned() {
                Some(s) => s,
                None => return, // killed explicitly; pty:exit was already sent
            };
            let status = session.child.lock().unwrap().try_wait();
            match status {
                Ok(Some(exit)) => {
                    state.ptys.forget(&id);
                    let code = if exit.success() { 0 } else { 1 };
                    let _ = app.emit(
                        "pty:exit",
                        serde_json::json!({ "id": id, "exitCode": code }),
                    );
                    return;
                }
                Ok(None) => {}
                Err(_) => return,
            }
        });
    }

    fn append_output(&self, id: &str, data: &str) {
        let mut buffers = self.buffers.lock().unwrap();
        let entry = buffers.entry(id.to_string()).or_default();
        entry.push_str(data);
        if entry.len() > MAX_BUFFER + BUFFER_SLACK {
            let mut cut = entry.len() - MAX_BUFFER;
            while cut < entry.len() && !entry.is_char_boundary(cut) {
                cut += 1;
            }
            *entry = entry[cut..].to_string();
        }
    }

    // When a Claude terminal prints a "limit reached" message, swap to the other
    // stored account and restart the claude CLIs so they pick up the new tokens.
    fn watch_for_usage_limit(&self, app: &AppHandle, id: &str, data: &str) {
        let hit = {
            let mut tails = self.limit_tails.lock().unwrap();
            let tail = tails.entry(id.to_string()).or_default();
            tail.push_str(&strip_ansi(data));
            if tail.len() > 600 {
                let mut cut = tail.len() - 600;
                while cut < tail.len() && !tail.is_char_boundary(cut) {
                    cut += 1;
                }
                *tail = tail[cut..].to_string();
            }
            if LIMIT_REACHED_RE.is_match(tail) {
                tail.clear();
                true
            } else {
                false
            }
        };
        if !hit {
            return;
        }

        let meta = match self.meta(id) {
            Some(m) => m,
            None => return,
        };
        let ws_key = meta.workspace_id.clone().unwrap_or_else(|| "default".into());
        {
            let mut last = self.last_auto_switch.lock().unwrap();
            if let Some(at) = last.get(&ws_key) {
                if at.elapsed() < AUTO_SWITCH_COOLDOWN {
                    return;
                }
            }
            last.insert(ws_key, Instant::now());
        }

        let app = app.clone();
        std::thread::spawn(move || {
            crate::perform_account_switch(
                &app,
                "limit",
                meta.workspace_id.as_deref(),
                meta.config_dir.as_deref(),
            );
        });
    }

    pub fn write(&self, id: &str, data: &str) -> bool {
        let session = match self.sessions.lock().unwrap().get(id).cloned() {
            Some(s) => s,
            None => return false,
        };
        let mut writer = session.writer.lock().unwrap();
        writer.write_all(data.as_bytes()).is_ok() && writer.flush().is_ok()
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        if let Some(session) = self.sessions.lock().unwrap().get(id).cloned() {
            let _ = session.master.lock().unwrap().resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }

    pub fn kill(&self, id: &str) {
        let session = self.sessions.lock().unwrap().remove(id);
        if let Some(session) = session {
            let mut child = session.child.lock().unwrap();
            let _ = child.kill();
            let _ = child.wait();
        }
        self.limit_tails.lock().unwrap().remove(id);
    }

    pub fn kill_all(&self) {
        let ids: Vec<String> = self.sessions.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.kill(&id);
        }
    }

    fn forget(&self, id: &str) {
        self.sessions.lock().unwrap().remove(id);
        self.limit_tails.lock().unwrap().remove(id);
    }

    pub fn has(&self, id: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(id)
    }

    pub fn meta(&self, id: &str) -> Option<PtyMeta> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .map(|s| s.meta.clone())
    }

    pub fn has_buffer(&self, id: &str) -> bool {
        self.buffers.lock().unwrap().contains_key(id)
    }

    pub fn read_output(&self, id: &str, tail: Option<usize>) -> String {
        let buffers = self.buffers.lock().unwrap();
        let buf = match buffers.get(id) {
            Some(b) => b,
            None => return String::new(),
        };
        match tail {
            Some(n) if n > 0 && buf.len() > n => {
                let mut cut = buf.len() - n;
                while cut < buf.len() && !buf.is_char_boundary(cut) {
                    cut += 1;
                }
                buf[cut..].to_string()
            }
            _ => buf.clone(),
        }
    }

    pub fn drop_buffer(&self, id: &str) {
        self.buffers.lock().unwrap().remove(id);
    }

    // The command that brings a claude terminal back after an account switch.
    // Each terminal resumes ITS OWN conversation via its pinned session id;
    // `--session-id` (start fresh on the pinned id) is used when the terminal has
    // no session file yet. Terminals created before session pinning have no id
    // and keep the old `--continue` behaviour.
    pub fn claude_relaunch_command(&self, id: &str) -> String {
        let base = "claude --dangerously-skip-permissions";
        let meta = match self.meta(id) {
            Some(m) => m,
            None => return format!("{base} --continue"),
        };
        let session_id = match meta.session_id {
            Some(s) => s,
            None => return format!("{base} --continue"),
        };
        let cfg_dir = meta
            .config_dir
            .map(std::path::PathBuf::from)
            .unwrap_or_else(paths::claude_dir);
        let proj_slug: String = meta
            .cwd
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let session_file = cfg_dir
            .join("projects")
            .join(proj_slug)
            .join(format!("{session_id}.jsonl"));
        if session_file.exists() {
            format!("{base} --resume {session_id}")
        } else {
            format!("{base} --session-id {session_id}")
        }
    }
}
