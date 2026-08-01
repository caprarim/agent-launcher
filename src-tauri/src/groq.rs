use std::path::PathBuf;
use std::time::Duration;

use once_cell::sync::Lazy;
use serde_json::Value;
use tauri::{AppHandle, Manager};

const API: &str = "https://api.groq.com/openai/v1";
pub const TRANSCRIBE_MODEL: &str = "whisper-large-v3-turbo";

static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .expect("reqwest client")
});

static CANCEL: Lazy<tokio::sync::Notify> = Lazy::new(tokio::sync::Notify::new);

fn key_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("groq.json"))
}

pub fn api_key(app: &AppHandle) -> Option<String> {
    if let Ok(k) = std::env::var("GROQ_API_KEY") {
        let k = k.trim().to_string();
        if !k.is_empty() {
            return Some(k);
        }
    }
    let file = key_file(app)?;
    let raw = std::fs::read_to_string(file).ok()?;
    let json: Value = serde_json::from_str(&raw).ok()?;
    let k = json.get("apiKey")?.as_str()?.trim().to_string();
    if k.is_empty() {
        None
    } else {
        Some(k)
    }
}

#[tauri::command]
pub fn groq_key_present(app: AppHandle) -> bool {
    api_key(&app).is_some()
}

#[tauri::command]
pub fn groq_key_set(app: AppHandle, key: String) -> Result<(), String> {
    let file = key_file(&app).ok_or("no config dir")?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, serde_json::json!({ "apiKey": key.trim() }).to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn groq_cancel() {
    CANCEL.notify_waiters();
}

fn parse_retry_seconds(msg: &str) -> Option<f64> {
    let idx = msg.find("try again in ")?;
    let rest = &msg[idx + "try again in ".len()..];
    let num: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let val: f64 = num.parse().ok()?;
    let unit = rest[num.len()..].chars().next().unwrap_or('s');
    match unit {
        'm' => Some(val * 60.0),
        'h' => Some(val * 3600.0),
        _ => Some(val),
    }
}

#[tauri::command]
pub async fn groq_chat(app: AppHandle, body: Value) -> Result<Value, String> {
    let key = api_key(&app).ok_or("groq api key missing")?;
    let request = async {
        let mut attempt: u32 = 0;
        loop {
            let res = CLIENT
                .post(format!("{}/chat/completions", API))
                .bearer_auth(&key)
                .json(&body)
                .send()
                .await
                .map_err(|e| {
                    if e.is_timeout() {
                        format!("groq timed out: {}", e)
                    } else if e.is_connect() {
                        format!("groq unreachable: {}", e)
                    } else {
                        format!("groq request failed: {}", e)
                    }
                })?;
            let status = res.status();
            let header_wait = res
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<f64>().ok());
            let json: Value = res
                .json()
                .await
                .map_err(|e| format!("groq bad response: {}", e))?;
            if status.is_success() {
                return Ok(json);
            }
            let msg = json
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
                .to_string();
            let code = status.as_u16();
            if code == 429 || code >= 500 {
                let wait = header_wait
                    .or_else(|| parse_retry_seconds(&msg))
                    .unwrap_or(2.0);
                if attempt < 2 && wait <= 15.0 {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_secs_f64(wait.max(1.0))).await;
                    continue;
                }
                if code == 429 {
                    return Err(format!("groq rate limited: {}", msg));
                }
            }
            return Err(format!("groq error {}: {}", status, msg));
        }
    };
    tokio::select! {
        result = request => result,
        _ = CANCEL.notified() => Err("interrupted".to_string()),
    }
}

pub async fn transcribe_wav(app: &AppHandle, wav: &std::path::Path) -> Result<String, String> {
    let key = api_key(app).ok_or("groq api key missing")?;
    let bytes = std::fs::read(wav).map_err(|e| e.to_string())?;
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name("voice.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", TRANSCRIBE_MODEL)
        .text("language", "en")
        .text("temperature", "0");
    let res = CLIENT
        .post(format!("{}/audio/transcriptions", API))
        .bearer_auth(&key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("groq transcription timed out: {}", e)
            } else if e.is_connect() {
                format!("groq unreachable: {}", e)
            } else {
                format!("groq transcription failed: {}", e)
            }
        })?;
    let status = res.status();
    let json: Value = res
        .json()
        .await
        .map_err(|e| format!("groq bad response: {}", e))?;
    if !status.is_success() {
        let msg = json
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(format!("groq error {}: {}", status, msg));
    }
    Ok(json
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string())
}
