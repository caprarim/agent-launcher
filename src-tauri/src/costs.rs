use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::Manager;

const CACHE_READ_MULT: f64 = 0.1;
const CACHE_WRITE_5M_MULT: f64 = 1.25;
const CACHE_WRITE_1H_MULT: f64 = 2.0;

#[derive(Serialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl Tokens {
    fn add(&mut self, o: &Tokens) {
        self.input += o.input;
        self.output += o.output;
        self.cache_read += o.cache_read;
        self.cache_write += o.cache_write;
    }
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub tokens: Tokens,
    pub cost: f64,
    pub messages: u64,
}

impl Bucket {
    fn add(&mut self, t: &Tokens, cost: f64) {
        self.tokens.add(t);
        self.cost += cost;
        self.messages += 1;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRow {
    pub model: String,
    pub tokens: Tokens,
    pub cost: f64,
    pub messages: u64,
    pub rate_input: f64,
    pub rate_output: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub project: String,
    pub cost: f64,
    pub tokens: Tokens,
    pub models: Vec<String>,
    pub started_at: String,
    pub ended_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayRow {
    pub date: String,
    pub cost: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRow {
    pub project: String,
    pub cost: f64,
    pub sessions: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostReport {
    pub day: Bucket,
    pub week: Bucket,
    pub month: Bucket,
    pub total: Bucket,
    pub models: Vec<ModelRow>,
    pub sessions: Vec<SessionRow>,
    pub projects: Vec<ProjectRow>,
    pub days: Vec<DayRow>,
    pub session_count: u64,
    pub file_count: u64,
    pub roots: Vec<String>,
    pub scanned_ms: u64,
    pub error: Option<String>,
}

fn rates(model: &str) -> (f64, f64) {
    let m = model.to_ascii_lowercase();
    if m.contains("fable") || m.contains("mythos") {
        (10.0, 50.0)
    } else if m.contains("opus") {
        (5.0, 25.0)
    } else if m.contains("haiku") {
        (1.0, 5.0)
    } else {
        (3.0, 15.0)
    }
}

fn cost_of(model: &str, t: &Tokens, write_5m: u64, write_1h: u64) -> f64 {
    let (rin, rout) = rates(model);
    let untagged = t.cache_write.saturating_sub(write_5m + write_1h);
    let write_units = write_5m as f64 * CACHE_WRITE_5M_MULT
        + write_1h as f64 * CACHE_WRITE_1H_MULT
        + untagged as f64 * CACHE_WRITE_1H_MULT;
    (t.input as f64 * rin
        + t.output as f64 * rout
        + t.cache_read as f64 * rin * CACHE_READ_MULT
        + write_units * rin)
        / 1_000_000.0
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn parse_ts(s: &str) -> Option<i64> {
    if s.len() < 19 {
        return None;
    }
    let num = |a: usize, z: usize| -> Option<i64> { s.get(a..z)?.parse().ok() };
    let y = num(0, 4)?;
    let mo = num(5, 7)?;
    let d = num(8, 10)?;
    let h = num(11, 13)?;
    let mi = num(14, 16)?;
    let se = num(17, 19)?;
    Some(days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + se)
}

fn walk_jsonl(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 6 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk_jsonl(&p, out, depth + 1);
        } else if p.extension().map(|x| x == "jsonl").unwrap_or(false) {
            out.push(p);
        }
    }
}

fn project_label(path: &Path) -> String {
    path.parent()
        .and_then(|p| p.file_name())
        .map(|n| {
            let raw = n.to_string_lossy().to_string();
            let trimmed = raw.trim_start_matches('-');
            let restored = trimmed.replace('-', "/");
            match restored.rsplit_once('/') {
                Some((_, last)) if !last.is_empty() => last.to_string(),
                _ => restored,
            }
        })
        .unwrap_or_else(|| "unknown".into())
}

struct SessionAcc {
    project: String,
    tokens: Tokens,
    cost: f64,
    models: Vec<String>,
    first: String,
    last: String,
}

fn build(roots: Vec<PathBuf>) -> CostReport {
    let started = Instant::now();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let mut files = Vec::new();
    let mut root_labels = Vec::new();
    for r in &roots {
        if r.is_dir() {
            root_labels.push(r.to_string_lossy().to_string());
            walk_jsonl(r, &mut files, 0);
        }
    }

    let mut report = CostReport {
        day: Bucket::default(),
        week: Bucket::default(),
        month: Bucket::default(),
        total: Bucket::default(),
        models: Vec::new(),
        sessions: Vec::new(),
        projects: Vec::new(),
        days: Vec::new(),
        session_count: 0,
        file_count: files.len() as u64,
        roots: root_labels,
        scanned_ms: 0,
        error: None,
    };

    let mut seen: HashSet<String> = HashSet::new();
    let mut models: HashMap<String, (Tokens, f64, u64)> = HashMap::new();
    let mut sessions: HashMap<String, SessionAcc> = HashMap::new();
    let mut days: HashMap<String, f64> = HashMap::new();

    for file in &files {
        let Ok(text) = std::fs::read_to_string(file) else { continue };
        let session_id = file
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let project = project_label(file);

        for line in text.lines() {
            if line.is_empty() || !line.contains("\"usage\"") {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
            let msg = &v["message"];
            let usage = &msg["usage"];
            if !usage.is_object() {
                continue;
            }
            let model = msg["model"].as_str().unwrap_or("").to_string();
            if model.is_empty() || model == "<synthetic>" {
                continue;
            }

            let key = msg["id"]
                .as_str()
                .or_else(|| v["requestId"].as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("{}:{}", session_id, seen.len()));
            if !seen.insert(key) {
                continue;
            }

            let n = |k: &str| -> u64 { usage[k].as_u64().unwrap_or(0) };
            let t = Tokens {
                input: n("input_tokens"),
                output: n("output_tokens"),
                cache_read: n("cache_read_input_tokens"),
                cache_write: n("cache_creation_input_tokens"),
            };
            if t.input == 0 && t.output == 0 && t.cache_read == 0 && t.cache_write == 0 {
                continue;
            }
            let cc = &usage["cache_creation"];
            let w5 = cc["ephemeral_5m_input_tokens"].as_u64().unwrap_or(0);
            let w1 = cc["ephemeral_1h_input_tokens"].as_u64().unwrap_or(0);
            let cost = cost_of(&model, &t, w5, w1);

            let stamp = v["timestamp"].as_str().unwrap_or("").to_string();
            let secs = parse_ts(&stamp);

            report.total.add(&t, cost);
            if let Some(s) = secs {
                let age = now - s;
                if age <= 86_400 {
                    report.day.add(&t, cost);
                }
                if age <= 7 * 86_400 {
                    report.week.add(&t, cost);
                }
                if age <= 30 * 86_400 {
                    report.month.add(&t, cost);
                }
                if age <= 30 * 86_400 {
                    if let Some(date) = stamp.get(0..10) {
                        *days.entry(date.to_string()).or_insert(0.0) += cost;
                    }
                }
            }

            let entry = models
                .entry(model.clone())
                .or_insert((Tokens::default(), 0.0, 0));
            entry.0.add(&t);
            entry.1 += cost;
            entry.2 += 1;

            let acc = sessions.entry(session_id.clone()).or_insert_with(|| SessionAcc {
                project: project.clone(),
                tokens: Tokens::default(),
                cost: 0.0,
                models: Vec::new(),
                first: stamp.clone(),
                last: stamp.clone(),
            });
            acc.tokens.add(&t);
            acc.cost += cost;
            if !acc.models.contains(&model) {
                acc.models.push(model.clone());
            }
            if !stamp.is_empty() {
                if acc.first.is_empty() || stamp < acc.first {
                    acc.first = stamp.clone();
                }
                if stamp > acc.last {
                    acc.last = stamp.clone();
                }
            }
        }
    }

    let mut model_rows: Vec<ModelRow> = models
        .into_iter()
        .map(|(model, (tokens, cost, messages))| {
            let (rate_input, rate_output) = rates(&model);
            ModelRow {
                model,
                tokens,
                cost,
                messages,
                rate_input,
                rate_output,
            }
        })
        .collect();
    model_rows.sort_by(|a, b| b.cost.total_cmp(&a.cost));
    report.models = model_rows;

    report.session_count = sessions.len() as u64;

    let mut project_totals: HashMap<String, (f64, u64)> = HashMap::new();
    for acc in sessions.values() {
        let e = project_totals.entry(acc.project.clone()).or_insert((0.0, 0));
        e.0 += acc.cost;
        e.1 += 1;
    }
    let mut project_rows: Vec<ProjectRow> = project_totals
        .into_iter()
        .map(|(project, (cost, sessions))| ProjectRow {
            project,
            cost,
            sessions,
        })
        .collect();
    project_rows.sort_by(|a, b| b.cost.total_cmp(&a.cost));
    project_rows.truncate(12);
    report.projects = project_rows;

    let mut session_rows: Vec<SessionRow> = sessions
        .into_iter()
        .map(|(id, acc)| SessionRow {
            id,
            project: acc.project,
            cost: acc.cost,
            tokens: acc.tokens,
            models: acc.models,
            started_at: acc.first,
            ended_at: acc.last,
        })
        .collect();
    session_rows.sort_by(|a, b| b.cost.total_cmp(&a.cost));
    session_rows.truncate(25);
    report.sessions = session_rows;

    let mut day_rows: Vec<DayRow> = days
        .into_iter()
        .map(|(date, cost)| DayRow { date, cost })
        .collect();
    day_rows.sort_by(|a, b| a.date.cmp(&b.date));
    report.days = day_rows;

    report.scanned_ms = started.elapsed().as_millis() as u64;
    report
}

fn roots_for(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".claude").join("projects"));
    }
    if let Ok(cfg) = app.path().app_config_dir() {
        let accounts = cfg.join("claude-accounts");
        if let Ok(rd) = std::fs::read_dir(&accounts) {
            for e in rd.flatten() {
                let p = e.path().join("projects");
                if p.is_dir() {
                    roots.push(p);
                }
            }
        }
    }
    roots
}

#[tauri::command]
pub async fn usage_costs(app: tauri::AppHandle) -> Result<CostReport, String> {
    let roots = roots_for(&app);
    tauri::async_runtime::spawn_blocking(move || build(roots))
        .await
        .map_err(|e| e.to_string())
}
