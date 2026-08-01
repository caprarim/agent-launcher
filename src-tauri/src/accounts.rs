use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify::{EventKind, RecursiveMode, Watcher};

use crate::paths;

// Claude Code account switching, ported from the Electron main process.
//
// Claude Code keeps its login in two places:
//   <config dir>/.credentials.json  — OAuth tokens (access + refresh)
//   <config dir>/.claude.json       — `oauthAccount` (email, accountUuid, plan)
//
// Every distinct account seen while the launcher runs is snapshotted into a
// profile file, and a watcher keeps the ACTIVE account's snapshot fresh because
// Claude Code rewrites the credentials on every token refresh. Switching means
// writing the other profile's credentials back and patching `oauthAccount`.

// Only these accounts take part in the Switch Account toggle. Every account is
// still snapshotted when logged in; switching cycles strictly within this list.
const SWITCH_EMAILS: [&str; 2] = ["coldworkapp@gmail.com", "zekrinum@gmail.com"];

pub struct ConfigPaths {
    pub dir: PathBuf,
    pub credentials_file: PathBuf,
    pub claude_json: PathBuf,
}

pub fn paths_for(config_dir: Option<&str>) -> ConfigPaths {
    match config_dir {
        None => ConfigPaths {
            dir: paths::claude_dir(),
            credentials_file: paths::claude_dir().join(".credentials.json"),
            claude_json: paths::claude_json(),
        },
        Some(dir) => {
            let dir = PathBuf::from(dir);
            ConfigPaths {
                credentials_file: dir.join(".credentials.json"),
                claude_json: dir.join(".claude.json"),
                dir,
            }
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
struct AccountProfile {
    #[serde(rename = "accountUuid")]
    account_uuid: String,
    email: String,
    #[serde(rename = "savedAt")]
    saved_at: u64,
    credentials: Value,
    #[serde(rename = "oauthAccount")]
    oauth_account: Value,
}

#[derive(Serialize, Clone, Default)]
pub struct SwitchResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct Identity {
    account_uuid: String,
    email: String,
    oauth_account: Value,
}

fn is_switchable(email: &str) -> bool {
    SWITCH_EMAILS
        .iter()
        .any(|e| e.eq_ignore_ascii_case(email.trim()))
}

fn switch_order(email: &str) -> usize {
    SWITCH_EMAILS
        .iter()
        .position(|e| e.eq_ignore_ascii_case(email.trim()))
        .unwrap_or(usize::MAX)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_json(file: &Path) -> Option<Value> {
    let raw = fs::read_to_string(file).ok()?;
    serde_json::from_str(&raw).ok()
}

// A /logout (or a failed token refresh) leaves an empty token block on disk.
// Such credentials must never be snapshotted over a good profile or restored by
// a switch — either one strands the user on a dead login.
fn has_tokens(credentials: &Value) -> bool {
    let oauth = match credentials.get("claudeAiOauth") {
        Some(v) => v,
        None => return false,
    };
    let nonempty = |key: &str| {
        oauth
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false)
    };
    nonempty("refreshToken") || nonempty("accessToken")
}

fn current_identity(config_dir: Option<&str>) -> Option<Identity> {
    let cfg = read_json(&paths_for(config_dir).claude_json)?;
    let oa = cfg.get("oauthAccount")?.clone();
    let account_uuid = oa.get("accountUuid")?.as_str()?.to_string();
    if account_uuid.is_empty() {
        return None;
    }
    let email = oa
        .get("emailAddress")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Some(Identity {
        account_uuid,
        email,
        oauth_account: oa,
    })
}

pub fn current_email(config_dir: Option<&str>) -> Option<String> {
    current_identity(config_dir)
        .map(|id| id.email)
        .filter(|e| !e.is_empty())
}

fn list_profiles() -> Vec<AccountProfile> {
    let dir = paths::profiles_dir();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Some(value) = read_json(&path) {
            if let Ok(profile) = serde_json::from_value::<AccountProfile>(value) {
                if !profile.account_uuid.is_empty() {
                    out.push(profile);
                }
            }
        }
    }
    out
}

// Save the logged-in account (tokens + identity) into its profile slot.
pub fn snapshot_current(config_dir: Option<&str>) {
    let p = paths_for(config_dir);
    let id = match current_identity(config_dir) {
        Some(id) => id,
        None => return,
    };
    let credentials = match read_json(&p.credentials_file) {
        Some(c) => c,
        None => return,
    };
    if !has_tokens(&credentials) {
        return;
    }
    let profile = AccountProfile {
        account_uuid: id.account_uuid.clone(),
        email: id.email,
        saved_at: now_millis(),
        credentials: credentials.clone(),
        oauth_account: id.oauth_account,
    };
    let dir = paths::profiles_dir();
    if let Err(e) = fs::create_dir_all(&dir) {
        eprintln!("[accounts] snapshot failed: {e}");
        return;
    }
    match serde_json::to_string_pretty(&profile) {
        Ok(text) => {
            if let Err(e) = fs::write(dir.join(format!("{}.json", id.account_uuid)), text) {
                eprintln!("[accounts] snapshot failed: {e}");
            }
        }
        Err(e) => eprintln!("[accounts] snapshot failed: {e}"),
    }
    propagate_credentials(&p.dir, &id.account_uuid, &credentials);
}

// Claude Code rotates the refresh token on every refresh and each config dir
// holds its own copy of the credentials — so the moment one dir refreshes,
// every OTHER dir logged into the same account is left holding a dead token.
// Mirror fresh credentials into every other watched dir on that account.
fn propagate_credentials(from_dir: &Path, account_uuid: &str, credentials: &Value) {
    let raw = credentials.to_string();
    let watched: Vec<(PathBuf, Option<String>)> = {
        let guard = WATCHED_DIRS.lock().unwrap();
        guard
            .iter()
            .map(|(dir, arg)| (PathBuf::from(dir), arg.clone()))
            .collect()
    };
    for (dir, cfg_arg) in watched {
        if dir == from_dir {
            continue;
        }
        let identity = match current_identity(cfg_arg.as_deref()) {
            Some(i) => i,
            None => continue,
        };
        if identity.account_uuid != account_uuid {
            continue;
        }
        let p = paths_for(cfg_arg.as_deref());
        if read_json(&p.credentials_file)
            .map(|v| v.to_string() == raw)
            .unwrap_or(false)
        {
            continue;
        }
        if let Err(e) = fs::write(&p.credentials_file, &raw) {
            eprintln!("[accounts] propagate failed: {e}");
        }
    }
}

// Only the allow-listed accounts participate, cycled in SWITCH_EMAILS order.
// Profiles whose tokens were wiped are excluded — restoring one would just land
// the user on a dead login.
fn switchable_profiles() -> Vec<AccountProfile> {
    let mut profiles: Vec<AccountProfile> = list_profiles()
        .into_iter()
        .filter(|p| is_switchable(&p.email) && has_tokens(&p.credentials))
        .collect();
    profiles.sort_by_key(|p| switch_order(&p.email));
    profiles
}

// Returns the blocking error, or None when a switch can proceed — so the Claude
// CLIs are only restarted when the swap will actually happen.
pub fn can_switch() -> Option<String> {
    let profiles = switchable_profiles();
    if profiles.len() < 2 {
        let missing: Vec<&str> = SWITCH_EMAILS
            .iter()
            .copied()
            .filter(|e| !profiles.iter().any(|p| p.email.eq_ignore_ascii_case(e)))
            .collect();
        return Some(format!(
            "Switching needs both accounts saved. Log into {} once inside a launcher Claude terminal (/logout then /login) and it will be remembered from then on.",
            missing.join(" and ")
        ));
    }
    None
}

// Swap the active Claude Code login to the next stored account.
pub fn switch_account(config_dir: Option<&str>) -> SwitchResult {
    let p = paths_for(config_dir);
    snapshot_current(config_dir);
    if let Some(blocked) = can_switch() {
        return SwitchResult {
            ok: false,
            error: Some(blocked),
            ..Default::default()
        };
    }
    let profiles = switchable_profiles();
    let current = current_identity(config_dir);
    // Not finding the current account lands on the first profile, same as the
    // Electron findIndex(-1) + 1 behaviour.
    let next_index = current
        .as_ref()
        .and_then(|c| profiles.iter().position(|p| p.account_uuid == c.account_uuid))
        .map(|i| (i + 1) % profiles.len())
        .unwrap_or(0);
    let next = &profiles[next_index];

    let write = || -> Result<(), String> {
        fs::create_dir_all(&p.dir).map_err(|e| e.to_string())?;
        fs::write(&p.credentials_file, next.credentials.to_string()).map_err(|e| e.to_string())?;
        let mut cfg = read_json(&p.claude_json).unwrap_or_else(|| Value::Object(Default::default()));
        if !cfg.is_object() {
            cfg = Value::Object(Default::default());
        }
        cfg.as_object_mut()
            .unwrap()
            .insert("oauthAccount".to_string(), next.oauth_account.clone());
        let text = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
        fs::write(&p.claude_json, text).map_err(|e| e.to_string())?;
        Ok(())
    };

    match write() {
        Ok(()) => SwitchResult {
            ok: true,
            email: Some(next.email.clone()),
            error: None,
        },
        Err(e) => SwitchResult {
            ok: false,
            error: Some(format!("Could not write Claude credentials: {e}")),
            ..Default::default()
        },
    }
}

pub fn seed_config_dir(config_dir: &Path) {
    let p = paths_for(config_dir.to_str());
    if let Err(e) = fs::create_dir_all(config_dir) {
        eprintln!("[accounts] seed failed: {e}");
        return;
    }
    let claude = paths::claude_dir();
    let copies: [(PathBuf, PathBuf); 3] = [
        (claude.join(".credentials.json"), p.credentials_file.clone()),
        (paths::claude_json(), p.claude_json.clone()),
        (
            claude.join("settings.json"),
            config_dir.join("settings.json"),
        ),
    ];
    for (src, dest) in copies {
        if !dest.exists() && src.exists() {
            if let Err(e) = fs::copy(&src, &dest) {
                eprintln!("[accounts] seed failed: {e}");
            }
        }
    }
}

// dir path -> the configDir argument it was registered with (None = the global
// ~/.claude), so propagation can re-resolve each dir's file paths.
static WATCHED_DIRS: Lazy<Mutex<HashMap<String, Option<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

// Keep the active account's snapshot fresh: Claude Code rewrites
// .credentials.json on login and on every token refresh. Each watcher runs on
// its own thread with a 750ms debounce, matching the Electron behaviour.
pub fn watch_config_dir(config_dir: Option<&str>) {
    let p = paths_for(config_dir);
    let key = p.dir.to_string_lossy().to_string();
    {
        let mut guard = WATCHED_DIRS.lock().unwrap();
        if guard.contains_key(&key) {
            return;
        }
        guard.insert(key.clone(), config_dir.map(|s| s.to_string()));
    }
    snapshot_current(config_dir);

    let owned_cfg = config_dir.map(|s| s.to_string());
    let dir = p.dir.clone();
    std::thread::spawn(move || {
        let (tx, rx) = channel();
        let mut watcher = match notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        }) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[accounts] watch failed: {e}");
                return;
            }
        };
        if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
            eprintln!("[accounts] watch failed: {e}");
            return;
        }
        let mut pending = false;
        loop {
            match rx.recv_timeout(Duration::from_millis(750)) {
                Ok(Ok(event)) => {
                    let touched_credentials = event.paths.iter().any(|path| {
                        path.file_name().and_then(|n| n.to_str()) == Some(".credentials.json")
                    });
                    let relevant = matches!(
                        event.kind,
                        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Any
                    );
                    if touched_credentials && relevant {
                        pending = true;
                    }
                }
                Ok(Err(_)) => {}
                Err(RecvTimeoutError::Timeout) => {
                    if pending {
                        pending = false;
                        snapshot_current(owned_cfg.as_deref());
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });
}

pub fn start_watching() {
    watch_config_dir(None);
}
