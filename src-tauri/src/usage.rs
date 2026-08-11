use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;

use crate::SharedState;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA: &str = "oauth-2025-04-20";
const FRESH_TTL: Duration = Duration::from_secs(60);
const ERROR_TTL: Duration = Duration::from_secs(120);
const LOCAL_FRESH_MS: u64 = 10 * 60 * 1000;
const LOCAL_MAX_AGE_MS: u64 = 6 * 60 * 60 * 1000;

static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .expect("usage client")
});

static CACHE: Lazy<Mutex<HashMap<String, (Instant, Usage)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

static INFLIGHT: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub percent: f64,
    pub resets_at: Option<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub session: Option<UsageWindow>,
    pub week: Option<UsageWindow>,
    pub source: String,
    pub age_ms: u64,
    pub account: Option<String>,
    pub error: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn config_root(config_dir: &Option<String>) -> Option<PathBuf> {
    match config_dir {
        Some(d) if !d.trim().is_empty() => Some(PathBuf::from(d)),
        _ => dirs::home_dir().map(|h| h.join(".claude")),
    }
}

fn settings_file(config_dir: &Option<String>) -> Option<PathBuf> {
    match config_dir {
        Some(d) if !d.trim().is_empty() => Some(PathBuf::from(d).join(".claude.json")),
        _ => dirs::home_dir().map(|h| h.join(".claude.json")),
    }
}

fn access_token(config_dir: &Option<String>) -> Option<String> {
    let file = config_root(config_dir)?.join(".credentials.json");
    let raw = std::fs::read_to_string(file).ok()?;
    let json: Value = serde_json::from_str(&raw).ok()?;
    let tok = json
        .get("claudeAiOauth")?
        .get("accessToken")?
        .as_str()?
        .trim()
        .to_string();
    if tok.is_empty() {
        None
    } else {
        Some(tok)
    }
}

fn window_from(node: Option<&Value>) -> Option<UsageWindow> {
    let node = node?;
    if node.is_null() {
        return None;
    }
    let percent = node.get("utilization")?.as_f64()?;
    let resets_at = node
        .get("resets_at")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Some(UsageWindow {
        percent: percent.clamp(0.0, 100.0),
        resets_at,
    })
}

fn parse_utilization(root: &Value, source: &str) -> Usage {
    Usage {
        session: window_from(root.get("five_hour")),
        week: window_from(root.get("seven_day")),
        source: source.to_string(),
        age_ms: 0,
        account: None,
        error: None,
    }
}

fn account_email(config_dir: &Option<String>) -> Option<String> {
    let file = settings_file(config_dir)?;
    let raw = std::fs::read_to_string(file).ok()?;
    let json: Value = serde_json::from_str(&raw).ok()?;
    json.get("oauthAccount")?
        .get("emailAddress")?
        .as_str()
        .map(|s| s.to_string())
}

fn local(config_dir: &Option<String>) -> Option<(u64, Usage)> {
    let file = settings_file(config_dir)?;
    let raw = std::fs::read_to_string(file).ok()?;
    let json: Value = serde_json::from_str(&raw).ok()?;
    let cached = json.get("cachedUsageUtilization")?;
    let fetched = cached.get("fetchedAtMs")?.as_u64()?;
    let out = parse_utilization(cached.get("utilization")?, "local");
    if out.session.is_none() && out.week.is_none() {
        return None;
    }
    let age = now_ms().saturating_sub(fetched);
    Some((age, out))
}

async fn fetch(config_dir: &Option<String>) -> Result<Usage, String> {
    let token = access_token(config_dir).ok_or("not logged in")?;
    let res = CLIENT
        .get(USAGE_URL)
        .bearer_auth(token)
        .header("Content-Type", "application/json")
        .header("anthropic-beta", OAUTH_BETA)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("http {}", status.as_u16()));
    }
    let json: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let root = json.get("utilization").unwrap_or(&json);
    let out = parse_utilization(root, "api");
    if out.session.is_none() && out.week.is_none() {
        return Err("no limits in response".into());
    }
    Ok(out)
}

async fn resolve(config_dir: Option<String>) -> Usage {
    let local_now = local(&config_dir);
    if let Some((age, out)) = &local_now {
        if *age <= LOCAL_FRESH_MS {
            let mut out = out.clone();
            out.age_ms = *age;
            return out;
        }
    }

    match fetch(&config_dir).await {
        Ok(u) => u,
        Err(e) => match local_now {
            Some((age, mut out)) if age <= LOCAL_MAX_AGE_MS => {
                out.age_ms = age;
                out.error = Some(e);
                out
            }
            _ => Usage {
                session: None,
                week: None,
                source: "none".into(),
                age_ms: 0,
                account: None,
                error: Some(e),
            },
        },
    }
}

#[tauri::command]
pub async fn usage_get(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedState>,
    id: Option<String>,
    config_dir: Option<String>,
) -> Result<Usage, String> {
    let from_session = id
        .as_ref()
        .and_then(|i| state.ptys.lock().get(i).and_then(|s| s.config_dir.clone()));
    let dir = from_session
        .or(config_dir)
        .or_else(|| std::env::var("CLAUDE_CONFIG_DIR").ok().filter(|d| !d.is_empty()));
    let key = dir.clone().unwrap_or_default();

    if let Some((at, cached)) = CACHE.lock().get(&key).cloned() {
        let ttl = if cached.error.is_some() { ERROR_TTL } else { FRESH_TTL };
        if at.elapsed() < ttl {
            return Ok(cached);
        }
    }

    let _guard = INFLIGHT.lock().await;
    if let Some((at, cached)) = CACHE.lock().get(&key).cloned() {
        let ttl = if cached.error.is_some() { ERROR_TTL } else { FRESH_TTL };
        if at.elapsed() < ttl {
            return Ok(cached);
        }
    }

    let mut out = resolve(dir.clone()).await;
    out.account = account_email(&dir);
    crate::files::log_line(
        &app,
        &format!(
            "usage_get dir={} account={:?} source={} age={}s session={:?} week={:?} error={:?}",
            dir.clone().unwrap_or_else(|| "home".into()),
            out.account,
            out.source,
            out.age_ms / 1000,
            out.session.as_ref().map(|w| w.percent),
            out.week.as_ref().map(|w| w.percent),
            out.error,
        ),
    );
    CACHE.lock().insert(key, (Instant::now(), out.clone()));
    Ok(out)
}
