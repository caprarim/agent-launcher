use std::path::PathBuf;

// Electron stored everything under `app.getPath('userData')`, which for this
// app resolves to <appData>/agent-terminals — %APPDATA%\agent-terminals on
// Windows, ~/.config/agent-terminals on Linux. The Tauri build deliberately
// keeps the exact same layout so a machine that already ran the Electron
// launcher finds its saved Claude account profiles and workspace configs.
pub fn app_data_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| home_dir().join(".config"))
        .join("agent-terminals")
}

pub fn user_data_dir() -> PathBuf {
    app_data_dir()
}

pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

pub fn claude_dir() -> PathBuf {
    home_dir().join(".claude")
}

pub fn claude_json() -> PathBuf {
    home_dir().join(".claude.json")
}

// Where a workspace that wants its own Claude login keeps that login.
pub fn workspace_config_dir(workspace_id: &str) -> PathBuf {
    user_data_dir().join("claude-workspaces").join(workspace_id)
}

pub fn profiles_dir() -> PathBuf {
    app_data_dir().join("claude-accounts")
}

pub fn ai_config_file() -> PathBuf {
    user_data_dir().join("ai-config.json")
}

// The path the project box starts on. C:\dev only exists on Rim's Windows box;
// on Ubuntu the equivalent starting point is the home directory.
pub fn default_project_path() -> String {
    if cfg!(windows) {
        "C:\\dev".to_string()
    } else {
        home_dir().to_string_lossy().to_string()
    }
}
