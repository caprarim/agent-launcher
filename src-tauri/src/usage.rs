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
const API_MIN_INTERVAL: Duration = Duration::from_secs(600);
const API_MAX_INTERVAL: Duration = Duration::from_secs(3600);
const API_ERROR_INTERVAL: Duration = Duration::from_secs(120);
const LOCAL_REREAD: Duration = Duration::from_secs(1);
const LOCAL_FRESH_MS: u64 = 6 * 60 * 1000;
const LOCAL_MAX_AGE_MS: u64 = 6 * 60 * 60 * 1000;

static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .expect("usage client")
});

#[derive(Clone)]
struct Entry {
    best: Option<(u64, Usage)>,
    last_local: Option<Instant>,
    next_api: Option<Instant>,
    backoff: Duration,
    error: Option<String>,
    last_logged: Option<(i64, i64)>,
}

impl Default for Entry {
    fn default() -> Self {
        Entry {
            best: None,
            last_local: None,
            next_api: None,
            backoff: API_MIN_INTERVAL,
            error: None,
            last_logged: None,
        }
    }
}

static STATE: Lazy<Mutex<HashMap<String, Entry>>> = Lazy::new(|| Mutex::new(HashMap::new()));

static INFLIGHT: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

struct FetchError {
    message: String,
    retry_after: Option<Duration>,
    rate_limited: bool,
}

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
    Some((fetched, out))
}

async fn fetch(config_dir: &Option<String>) -> Result<Usage, FetchError> {
    let token = access_token(config_dir).ok_or_else(|| FetchError {
        message: "not logged in".into(),
        retry_after: None,
        rate_limited: false,
    })?;
    let res = CLIENT
        .get(USAGE_URL)
        .bearer_auth(token)
        .header("Content-Type", "application/json")
        .header("anthropic-beta", OAUTH_BETA)
        .send()
        .await
        .map_err(|e| FetchError {
            message: e.to_string(),
            retry_after: None,
            rate_limited: false,
        })?;
    let status = res.status();
    let retry_after = res
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(Duration::from_secs);
    let body = res.text().await.map_err(|e| FetchError {
        message: e.to_string(),
        retry_after,
        rate_limited: status.as_u16() == 429,
    })?;
    if !status.is_success() {
        return Err(FetchError {
            message: format!("http {}", status.as_u16()),
            retry_after,
            rate_limited: status.as_u16() == 429,
        });
    }
    let json: Value = serde_json::from_str(&body).map_err(|e| FetchError {
        message: e.to_string(),
        retry_after: None,
        rate_limited: false,
    })?;
    let root = json.get("utilization").unwrap_or(&json);
    let out = parse_utilization(root, "api");
    if out.session.is_none() && out.week.is_none() {
        return Err(FetchError {
            message: "no limits in response".into(),
            retry_after: None,
            rate_limited: false,
        });
    }
    Ok(out)
}

fn absorb(key: &str, fetched: u64, usage: Usage) {
    let mut guard = STATE.lock();
    let entry = guard.entry(key.to_string()).or_default();
    let newer = match &entry.best {
        Some((have, _)) => fetched > *have,
        None => true,
    };
    if newer {
        entry.best = Some((fetched, usage));
    }
}

fn best_age_ms(key: &str) -> Option<u64> {
    let guard = STATE.lock();
    guard
        .get(key)
        .and_then(|e| e.best.as_ref().map(|(f, _)| now_ms().saturating_sub(*f)))
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

    let read_local = {
        let mut guard = STATE.lock();
        let entry = guard.entry(key.clone()).or_default();
        match entry.last_local {
            Some(at) if at.elapsed() < LOCAL_REREAD => false,
            _ => {
                entry.last_local = Some(Instant::now());
                true
            }
        }
    };
    if read_local {
        if let Some((fetched, out)) = local(&dir) {
            absorb(&key, fetched, out);
        }
    }

    let local_fresh = best_age_ms(&key).map(|a| a < LOCAL_FRESH_MS).unwrap_or(false);

    let due = !local_fresh && {
        let guard = STATE.lock();
        guard
            .get(&key)
            .and_then(|e| e.next_api)
            .map(|at| Instant::now() >= at)
            .unwrap_or(true)
    };

    if due {
        let _guard = INFLIGHT.lock().await;
        let still_due = {
            let mut inner = STATE.lock();
            let entry = inner.entry(key.clone()).or_default();
            let ok = entry.next_api.map(|at| Instant::now() >= at).unwrap_or(true);
            if ok {
                entry.next_api = Some(Instant::now() + entry.backoff);
            }
            ok
        };
        if still_due && !best_age_ms(&key).map(|a| a < LOCAL_FRESH_MS).unwrap_or(false) {
            let result = fetch(&dir).await;
            let mut inner = STATE.lock();
            let entry = inner.entry(key.clone()).or_default();
            match result {
                Ok(out) => {
                    entry.backoff = API_MIN_INTERVAL;
                    entry.next_api = Some(Instant::now() + API_MIN_INTERVAL);
                    entry.error = None;
                    let fetched = now_ms();
                    let newer = match &entry.best {
                        Some((have, _)) => fetched > *have,
                        None => true,
                    };
                    if newer {
                        entry.best = Some((fetched, out));
                    }
                }
                Err(e) => {
                    if e.rate_limited {
                        let hinted = e
                            .retry_after
                            .filter(|d| *d > Duration::from_secs(0))
                            .unwrap_or(entry.backoff * 2);
                        entry.backoff = hinted.clamp(API_MIN_INTERVAL, API_MAX_INTERVAL);
                        entry.next_api = Some(Instant::now() + entry.backoff);
                    } else {
                        entry.next_api = Some(Instant::now() + API_ERROR_INTERVAL);
                    }
                    entry.error = Some(e.message);
                }
            }
            let snapshot = entry.clone();
            drop(inner);
            crate::files::log_line(
                &app,
                &format!(
                    "usage_api dir={} source={} age={}s next={}s error={:?}",
                    key.is_empty().then(|| "home".to_string()).unwrap_or(key.clone()),
                    snapshot
                        .best
                        .as_ref()
                        .map(|(_, u)| u.source.clone())
                        .unwrap_or_else(|| "none".into()),
                    snapshot
                        .best
                        .as_ref()
                        .map(|(f, _)| now_ms().saturating_sub(*f) / 1000)
                        .unwrap_or(0),
                    snapshot.backoff.as_secs(),
                    snapshot.error,
                ),
            );
        }
    }

    let (best, error) = {
        let guard = STATE.lock();
        match guard.get(&key) {
            Some(e) => (e.best.clone(), e.error.clone()),
            None => (None, None),
        }
    };

    let mut out = match best {
        Some((fetched, mut u)) => {
            let age = now_ms().saturating_sub(fetched);
            if age > LOCAL_MAX_AGE_MS {
                Usage {
                    session: None,
                    week: None,
                    source: "none".into(),
                    age_ms: 0,
                    account: None,
                    error: error.clone().or(Some("stale".into())),
                }
            } else {
                u.age_ms = age;
                u.error = error.clone();
                u
            }
        }
        None => Usage {
            session: None,
            week: None,
            source: "none".into(),
            age_ms: 0,
            account: None,
            error: error.clone().or(Some("no usage yet".into())),
        },
    };
    out.account = account_email(&dir);

    let shown = (
        out.session.as_ref().map(|w| w.percent.round() as i64).unwrap_or(-1),
        out.week.as_ref().map(|w| w.percent.round() as i64).unwrap_or(-1),
    );
    let changed = {
        let mut guard = STATE.lock();
        let entry = guard.entry(key.clone()).or_default();
        if entry.last_logged == Some(shown) {
            false
        } else {
            entry.last_logged = Some(shown);
            true
        }
    };
    if changed {
        crate::files::log_line(
            &app,
            &format!(
                "usage_shown dir={} source={} session={}% week={}% age={}s",
                key.is_empty().then(|| "home".to_string()).unwrap_or(key.clone()),
                out.source,
                shown.0,
                shown.1,
                out.age_ms / 1000,
            ),
        );
    }

    Ok(out)
}
