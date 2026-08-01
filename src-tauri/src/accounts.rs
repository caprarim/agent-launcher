use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAccount {
    pub id: String,
    pub name: String,
    pub dir: String,
    pub logged_in: bool,
}

fn accounts_root(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| e.to_string())
        .map(|d| d.join("claude-accounts"))
}

#[tauri::command]
pub fn list_accounts(app: AppHandle) -> Result<Vec<ClaudeAccount>, String> {
    let mut out = Vec::new();
    let home_logged = dirs::home_dir()
        .map(|h| h.join(".claude").join(".credentials.json").exists() || h.join(".claude.json").exists())
        .unwrap_or(false);
    out.push(ClaudeAccount {
        id: "default".into(),
        name: "Main".into(),
        dir: String::new(),
        logged_in: home_logged,
    });
    let root = accounts_root(&app)?;
    if let Ok(entries) = std::fs::read_dir(&root) {
        let mut dirs_list: Vec<_> = entries.flatten().filter(|e| e.path().is_dir()).collect();
        dirs_list.sort_by_key(|e| e.file_name());
        for e in dirs_list {
            let dir = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            let logged_in =
                dir.join(".credentials.json").exists() || dir.join(".claude.json").exists();
            out.push(ClaudeAccount {
                id: name.clone(),
                name,
                dir: dir.to_string_lossy().to_string(),
                logged_in,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn create_account(app: AppHandle, name: String) -> Result<ClaudeAccount, String> {
    let clean: String = name
        .trim()
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == ' ')
        .collect::<String>()
        .trim()
        .replace(' ', "-");
    if clean.is_empty() {
        return Err("empty account name".into());
    }
    let dir = accounts_root(&app)?.join(&clean);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let logged_in = dir.join(".credentials.json").exists() || dir.join(".claude.json").exists();
    Ok(ClaudeAccount {
        id: clean.clone(),
        name: clean,
        dir: dir.to_string_lossy().to_string(),
        logged_in,
    })
}
