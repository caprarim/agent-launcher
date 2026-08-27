use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::Value;

use crate::usage::{Usage, UsageWindow};

const CACHE_TTL: Duration = Duration::from_millis(2500);
const TAIL_BYTES: u64 = 192 * 1024;
const MAX_FILES: usize = 8;
const MAX_DAYS: usize = 4;
const MAX_AGE_MS: u64 = 12 * 60 * 60 * 1000;

struct Cached {
    at: Instant,
    value: Usage,
}

static CACHE: Lazy<Mutex<Option<Cached>>> = Lazy::new(|| Mutex::new(None));
static LAST_LOGGED: Lazy<Mutex<Option<(i64, i64)>>> = Lazy::new(|| Mutex::new(None));

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn codex_home() -> Option<PathBuf> {
    match std::env::var("CODEX_HOME") {
        Ok(v) if !v.trim().is_empty() => Some(PathBuf::from(v)),
        _ => dirs::home_dir().map(|h| h.join(".codex")),
    }
}

fn sorted_children(dir: &PathBuf) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .collect(),
        Err(_) => Vec::new(),
    };
    out.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    out
}

fn day_dirs(root: &PathBuf) -> Vec<PathBuf> {
    let mut days = Vec::new();
    for year in sorted_children(root) {
        for month in sorted_children(&year) {
            for day in sorted_children(&month) {
                days.push(day);
                if days.len() >= MAX_DAYS {
                    return days;
                }
            }
        }
    }
    days
}

fn newest_rollouts(root: &PathBuf) -> Vec<PathBuf> {
    let mut files: Vec<(SystemTime, PathBuf)> = Vec::new();
    for day in day_dirs(root) {
        let rd = match std::fs::read_dir(&day) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for entry in rd.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(UNIX_EPOCH);
            files.push((modified, path));
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.truncate(MAX_FILES);
    files.into_iter().map(|(_, p)| p).collect()
}

fn tail(path: &PathBuf) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let from = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = Vec::with_capacity((len - from) as usize);
    file.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    if from == 0 {
        return Some(text);
    }
    match text.find('\n') {
        Some(i) => Some(text[i + 1..].to_string()),
        None => None,
    }
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn iso_utc(secs: i64) -> String {
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let rest = secs.rem_euclid(86_400);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

fn stamp_ms(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num = |a: usize, b: usize| text.get(a..b)?.parse::<i64>().ok();
    let year = num(0, 4)?;
    let month = num(5, 7)?;
    let day = num(8, 10)?;
    let hour = num(11, 13)?;
    let min = num(14, 16)?;
    let sec = num(17, 19)?;
    let millis = text
        .get(20..23)
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    let secs = days_from_civil(year, month, day) * 86_400 + hour * 3600 + min * 60 + sec;
    u64::try_from(secs * 1000 + millis).ok()
}

fn window(node: Option<&Value>) -> Option<UsageWindow> {
    let node = node?;
    if node.is_null() {
        return None;
    }
    let percent = node.get("used_percent")?.as_f64()?;
    let resets_at = node
        .get("resets_at")
        .and_then(|v| v.as_i64())
        .map(iso_utc)
        .or_else(|| {
            node.get("resets_in_seconds")
                .and_then(|v| v.as_i64())
                .map(|s| iso_utc(now_ms() as i64 / 1000 + s))
        });
    Some(UsageWindow {
        percent: percent.clamp(0.0, 100.0),
        resets_at,
    })
}

fn snapshot(path: &PathBuf) -> Option<(u64, Usage)> {
    let text = tail(path)?;
    for line in text.lines().rev() {
        if !line.contains("\"rate_limits\"") {
            continue;
        }
        let json: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let limits = match json.pointer("/payload/rate_limits") {
            Some(v) if !v.is_null() => v,
            _ => continue,
        };
        let session = window(limits.get("primary"));
        let week = window(limits.get("secondary"));
        if session.is_none() && week.is_none() {
            continue;
        }
        let at = json
            .get("timestamp")
            .and_then(|v| v.as_str())
            .and_then(stamp_ms)
            .unwrap_or_else(now_ms);
        return Some((
            at,
            Usage {
                session,
                week,
                source: "codex".into(),
                age_ms: 0,
                account: None,
                error: None,
            },
        ));
    }
    None
}

fn read_latest() -> Usage {
    let root = match codex_home() {
        Some(h) => h.join("sessions"),
        None => {
            return Usage {
                source: "none".into(),
                error: Some("no home directory".into()),
                ..Usage::default()
            }
        }
    };
    if !root.is_dir() {
        return Usage {
            source: "none".into(),
            error: Some("no codex sessions yet".into()),
            ..Usage::default()
        };
    }

    let mut best: Option<(u64, Usage)> = None;
    for file in newest_rollouts(&root) {
        if let Some((at, usage)) = snapshot(&file) {
            let newer = best.as_ref().map(|(have, _)| at > *have).unwrap_or(true);
            if newer {
                best = Some((at, usage));
            }
        }
    }

    match best {
        Some((at, mut usage)) => {
            let age = now_ms().saturating_sub(at);
            if age > MAX_AGE_MS {
                Usage {
                    source: "none".into(),
                    error: Some("stale".into()),
                    ..Usage::default()
                }
            } else {
                usage.age_ms = age;
                usage
            }
        }
        None => Usage {
            source: "none".into(),
            error: Some("no limits in codex sessions".into()),
            ..Usage::default()
        },
    }
}

#[tauri::command]
pub fn codex_usage_get(app: tauri::AppHandle) -> Result<Usage, String> {
    {
        let guard = CACHE.lock();
        if let Some(hit) = guard.as_ref() {
            if hit.at.elapsed() < CACHE_TTL {
                return Ok(hit.value.clone());
            }
        }
    }

    let out = read_latest();
    *CACHE.lock() = Some(Cached {
        at: Instant::now(),
        value: out.clone(),
    });

    let shown = (
        out.session.as_ref().map(|w| w.percent.round() as i64).unwrap_or(-1),
        out.week.as_ref().map(|w| w.percent.round() as i64).unwrap_or(-1),
    );
    let changed = {
        let mut guard = LAST_LOGGED.lock();
        if *guard == Some(shown) {
            false
        } else {
            *guard = Some(shown);
            true
        }
    };
    if changed {
        crate::files::log_line(
            &app,
            &format!(
                "codex_usage source={} session={}% week={}% age={}s error={:?}",
                out.source,
                shown.0,
                shown.1,
                out.age_ms / 1000,
                out.error,
            ),
        );
    }

    Ok(out)
}
