mod accounts;
mod browser;
mod codex_usage;
mod control;
mod costs;
mod files;
mod focus;
mod groq;
mod notify;
mod ollama;
mod pty;
mod speech;
mod update;
mod usage;

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{Emitter, Manager};

pub struct AppState {
    pub ptys: Mutex<HashMap<String, pty::PtySession>>,
    pub agents: Mutex<Vec<control::AgentInstance>>,
    pub pending_adds: Mutex<HashMap<String, tokio::sync::oneshot::Sender<control::AgentInstance>>>,
    pub control_port: Mutex<u16>,
    pub recorder: speech::Recorder,
    pub tts: speech::TtsQueue,
}

impl AppState {
    fn new() -> Self {
        Self {
            ptys: Mutex::new(HashMap::new()),
            agents: Mutex::new(Vec::new()),
            pending_adds: Mutex::new(HashMap::new()),
            control_port: Mutex::new(4575),
            recorder: speech::Recorder::new(),
            tts: speech::TtsQueue::new(),
        }
    }
}

pub type SharedState = Arc<AppState>;

#[cfg(target_os = "linux")]
fn install_escape_hook(app: &tauri::AppHandle) {
    use gtk::prelude::*;
    let Some(win) = app.get_webview_window("main") else { return };
    let Ok(gtk_win) = win.gtk_window() else { return };
    let handle = app.clone();
    gtk_win.connect_key_press_event(move |_w, ev| {
        if ev.keyval() == gtk::gdk::keys::constants::Escape {
            let _ = handle.emit("hw-escape", ());
        }
        gtk::glib::Propagation::Proceed
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if std::env::var_os("GTK_IM_MODULE").is_none() {
            std::env::set_var("GTK_IM_MODULE", "gtk-im-context-simple");
        }
    }

    let state: SharedState = Arc::new(AppState::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![
            pty::pty_create,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_output,
            ollama::ollama_chat,
            ollama::ollama_cancel,
            ollama::ollama_tags,
            ollama::ollama_ensure,
            groq::groq_chat,
            groq::groq_cancel,
            groq::groq_key_present,
            groq::groq_key_set,
            speech::speak,
            speech::speak_stop,
            speech::voice_start,
            speech::voice_stop,
            speech::list_input_devices,
            speech::default_input_device,
            speech::ensure_workspace_config,
            accounts::list_accounts,
            accounts::create_account,
            files::debug_log,
            files::focus_main,
            notify::notify_agent_done,
            files::clipboard_image_file,
            files::list_dir,
            files::search_files,
            files::read_text_file,
            files::write_text_file,
            files::create_dir,
            files::home_dir,
            files::config_dir,
            files::open_external,
            costs::usage_costs,
            focus::set_ui_zoom,
            focus::focus_mode,
            browser::browser_show,
            browser::browser_navigate,
            browser::browser_hide,
            browser::browser_close,
            browser::browser_nav_action,
            update::update_check,
            update::update_apply,
            usage::usage_get,
            codex_usage::codex_usage_get,
        ])
        .setup(move |app| {
            speech::set_app(app.handle().clone());
            let handle2 = app.handle().clone();
            let st2 = state.clone();
            std::thread::spawn(move || pty::activity_monitor(handle2, st2));
            if let Some(w) = app.get_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
            #[cfg(target_os = "linux")]
            install_escape_hook(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if focus::focus_mode_active() {
                    api.prevent_close();
                    let _ = window.emit("focus-exit", ());
                    return;
                }
                let app = window.app_handle();
                if let Some(state) = app.try_state::<SharedState>() {
                    pty::kill_all(state.inner());
                }
                app.exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running agent launcher");
}
