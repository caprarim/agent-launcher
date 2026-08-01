pub mod accounts;
pub mod control;
pub mod fsops;
pub mod namer;
pub mod paths;
pub mod ptys;

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_dialog::DialogExt;

use fsops::{FsReadDirResult, FsReadFileResult, FsWatchers, FsWriteFileResult};
use ptys::{PtyCreateOptions, PtyCreateResult, PtyManager};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AgentInstance {
    pub id: String,
    #[serde(rename = "type")]
    pub agent_type: String,
    pub name: String,
    pub command: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub cwd: String,
    #[serde(rename = "workspaceId", default)]
    pub workspace_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub platform: String,
    pub home_dir: String,
    pub default_project_path: String,
    // xterm's Windows-conpty heuristics only matter on Windows; the Tauri build
    // targets Linux, where the field is inert.
    pub win_build_number: u32,
}

#[derive(Default)]
pub struct AppState {
    pub ptys: PtyManager,
    // Source of truth for the agent list lives in the renderer and is synced here
    // so the control API can answer GET /agents without touching the UI.
    pub agents: Mutex<Vec<AgentInstance>>,
    pub pending_adds: Mutex<HashMap<String, Sender<AgentInstance>>>,
    pub fs_watchers: FsWatchers,
    pub control_port: AtomicU16,
    add_counter: AtomicU64,
}

impl AppState {
    pub fn next_add_counter(&self) -> u64 {
        self.add_counter.fetch_add(1, Ordering::Relaxed)
    }

    pub fn port(&self) -> u16 {
        self.control_port.load(Ordering::Relaxed)
    }
}

pub fn state(app: &AppHandle) -> State<'_, AppState> {
    app.state::<AppState>()
}

// ── PTY ───────────────────────────────────────────────────────────────────────

#[tauri::command]
fn pty_create(app: AppHandle, opts: PtyCreateOptions) -> PtyCreateResult {
    let handle = app.clone();
    let app_state = state(&app);
    let port = app_state.port();
    app_state.ptys.create(&handle, opts, port)
}

#[tauri::command]
fn pty_write(state: State<'_, AppState>, id: String, data: String) {
    state.ptys.write(&id, &data);
}

#[tauri::command]
fn pty_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) {
    state.ptys.resize(&id, cols, rows);
}

#[tauri::command]
fn pty_kill(state: State<'_, AppState>, id: String) {
    state.ptys.kill(&id);
}

// ── Directory picker ──────────────────────────────────────────────────────────

#[tauri::command]
fn pick_directory(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Select Project Directory")
        .blocking_pick_folder()
        .and_then(|folder| folder.into_path().ok())
        .map(|path| path.to_string_lossy().to_string())
}

// ── File system ───────────────────────────────────────────────────────────────

#[tauri::command]
fn fs_read_dir(dir_path: String) -> FsReadDirResult {
    fsops::read_dir(&dir_path)
}

#[tauri::command]
fn fs_read_file(file_path: String) -> FsReadFileResult {
    fsops::read_file(&file_path)
}

#[tauri::command]
fn fs_write_file(file_path: String, content: String) -> FsWriteFileResult {
    fsops::write_file(&file_path, &content)
}

#[tauri::command]
fn fs_watch(app: AppHandle, file_path: String) {
    let handle = app.clone();
    state(&app).fs_watchers.watch(&handle, &file_path);
}

#[tauri::command]
fn fs_unwatch(state: State<'_, AppState>, file_path: String) {
    state.fs_watchers.unwatch(&file_path);
}

// ── Control API bridge ────────────────────────────────────────────────────────

#[tauri::command]
fn sync_agents(state: State<'_, AppState>, agents: Vec<AgentInstance>) {
    *state.agents.lock().unwrap() = agents;
}

#[tauri::command]
fn control_add_agent_result(state: State<'_, AppState>, request_id: String, agent: AgentInstance) {
    let sender = state.pending_adds.lock().unwrap().remove(&request_id);
    if let Some(sender) = sender {
        let _ = sender.send(agent);
    }
}

#[tauri::command]
fn control_port(state: State<'_, AppState>) -> u16 {
    state.port()
}

// ── Claude account switching ──────────────────────────────────────────────────

/// Exit every claude REPL in the workspace FIRST (Esc dismisses menus / stops
/// streaming, double Ctrl+C quits), and only swap the credential files once they
/// are gone. Swapping while claude was still alive let the dying process flush
/// its in-memory .claude.json / refreshed tokens over the freshly written files
/// — which is how a switch could land on a dead login.
pub fn perform_account_switch(
    app: &AppHandle,
    reason: &str,
    workspace_id: Option<&str>,
    config_dir: Option<&str>,
) -> accounts::SwitchResult {
    let state = state(app);
    // Re-derive the dir so a switch requested before the renderer learned the
    // workspace's configDir still stays scoped to that workspace instead of
    // rewriting the global ~/.claude shared by everything else.
    let dir = ptys::resolve_config_dir(workspace_id, config_dir);

    let notify = |res: accounts::SwitchResult| -> accounts::SwitchResult {
        let mut payload = serde_json::to_value(&res).unwrap_or_else(|_| json!({}));
        payload["reason"] = json!(reason);
        payload["workspaceId"] = json!(workspace_id);
        let _ = app.emit("account:switched", payload);
        res
    };

    // Bail before touching any terminal if the swap can't happen anyway.
    if let Some(blocked) = accounts::can_switch() {
        return notify(accounts::SwitchResult {
            ok: false,
            error: Some(blocked),
            ..Default::default()
        });
    }

    let claudes: Vec<String> = state
        .agents
        .lock()
        .unwrap()
        .iter()
        .filter(|agent| {
            agent.agent_type == "claude"
                && agent.workspace_id.as_deref() == workspace_id
                && state.ptys.has(&agent.id)
        })
        .map(|agent| agent.id.clone())
        .collect();

    for id in &claudes {
        state.ptys.write(id, "\x1b");
    }
    if !claudes.is_empty() {
        std::thread::sleep(Duration::from_millis(400));
        for id in &claudes {
            state.ptys.write(id, "\x03");
        }
        std::thread::sleep(Duration::from_millis(300));
        for id in &claudes {
            state.ptys.write(id, "\x03");
        }
        std::thread::sleep(Duration::from_millis(1800));
    }

    let res = accounts::switch_account(dir.as_deref());
    // Relaunch even if the swap failed — the REPLs were already exited, and each
    // terminal resumes its own conversation either way.
    for id in &claudes {
        let command = state.ptys.claude_relaunch_command(id);
        state.ptys.write(id, &format!("{command}\r"));
    }
    notify(res)
}

#[tauri::command]
fn account_switch(
    app: AppHandle,
    workspace_id: Option<String>,
    config_dir: Option<String>,
) -> accounts::SwitchResult {
    perform_account_switch(
        &app,
        "manual",
        workspace_id.as_deref(),
        config_dir.as_deref(),
    )
}

#[tauri::command]
fn account_current(config_dir: Option<String>) -> serde_json::Value {
    json!({ "email": accounts::current_email(config_dir.as_deref()) })
}

#[tauri::command]
fn workspace_ensure_config(workspace_id: String) -> String {
    ptys::workspace_config_dir(&workspace_id)
}

// ── Agent tab naming ──────────────────────────────────────────────────────────

// Returns the model's RAW reply. The renderer runs it through sanitizeTitle(),
// so the house style for a label is enforced in one place for every producer.
#[tauri::command]
async fn ai_name_agent(prompt: String, model_index: usize) -> Option<String> {
    namer::ask_model(model_index, &prompt).await
}

#[tauri::command]
fn ai_model_count() -> usize {
    namer::MODELS.len()
}

// ── Platform ──────────────────────────────────────────────────────────────────

#[tauri::command]
fn platform_info() -> PlatformInfo {
    PlatformInfo {
        platform: std::env::consts::OS.to_string(),
        home_dir: paths::home_dir().to_string_lossy().to_string(),
        default_project_path: paths::default_project_path(),
        win_build_number: 0,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            pty_create,
            pty_write,
            pty_resize,
            pty_kill,
            pick_directory,
            fs_read_dir,
            fs_read_file,
            fs_write_file,
            fs_watch,
            fs_unwatch,
            sync_agents,
            control_add_agent_result,
            control_port,
            account_switch,
            account_current,
            workspace_ensure_config,
            ai_name_agent,
            ai_model_count,
            platform_info,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Several launchers can run side by side: the first binds 4575 and
            // each extra instance takes the next free port. Every terminal's
            // environment carries AGENT_LAUNCHER_PORT set to ITS launcher's
            // actual port.
            let base_port: u16 = std::env::var("AGENT_LAUNCHER_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(4575);
            if let Some(port) = control::start(handle.clone(), base_port) {
                state(&handle).control_port.store(port, Ordering::Relaxed);
            }

            accounts::start_watching();
            println!("{}", namer::describe_namer());

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed) {
                let state = state(window.app_handle());
                state.ptys.kill_all();
                state.fs_watchers.clear();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Agent Launcher")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                state(app).ptys.kill_all();
            }
        });
}
