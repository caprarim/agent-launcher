use std::time::Duration;

use once_cell::sync::Lazy;
use serde_json::Value;

const OLLAMA: &str = "http://127.0.0.1:11434";
pub const MODELS_DIR: &str = "D:\\ollama\\models";

static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .expect("reqwest client")
});

// Fires when the user hits the stop button. Dropping the in flight request also
// tells Ollama to stop generating, so an interrupt is immediate, not just a UI
// state change.
static CANCEL: Lazy<tokio::sync::Notify> = Lazy::new(tokio::sync::Notify::new);

/// Interrupt whatever chat request is currently generating. A no op when nothing
/// is in flight, and it never cancels a future request (notify does not queue).
#[tauri::command]
pub fn ollama_cancel() {
    CANCEL.notify_waiters();
}

#[tauri::command]
pub async fn ollama_chat(mut body: Value) -> Result<Value, String> {
    if let Some(obj) = body.as_object_mut() {
        obj.insert("stream".into(), Value::Bool(false));
    }
    let request = async {
        let res = CLIENT
            .post(format!("{}/api/chat", OLLAMA))
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                // Only a real connection failure should read as "unreachable"; a slow
                // model that times out is a different problem and must not send the
                // user chasing a server that is actually running.
                if e.is_timeout() {
                    format!("ollama timed out: {}", e)
                } else if e.is_connect() {
                    format!("ollama unreachable: {}", e)
                } else {
                    format!("ollama request failed: {}", e)
                }
            })?;
        let status = res.status();
        let json: Value = res.json().await.map_err(|e| format!("ollama bad response: {}", e))?;
        if !status.is_success() {
            return Err(format!("ollama error {}: {}", status, json));
        }
        Ok(json)
    };
    // Race the request against a cancel signal. If cancel wins, `request` is
    // dropped, its connection closes, and Ollama halts generation.
    tokio::select! {
        result = request => result,
        _ = CANCEL.notified() => Err("interrupted".to_string()),
    }
}

#[tauri::command]
pub async fn ollama_tags() -> Result<Value, String> {
    let res = CLIENT
        .get(format!("{}/api/tags", OLLAMA))
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map_err(|e| format!("ollama unreachable: {}", e))?;
    res.json().await.map_err(|e| format!("ollama bad response: {}", e))
}

/// Path to the ollama binary: prefer the known per user install location, fall
/// back to bare "ollama" on PATH. Spawning by full path means the server still
/// comes up even when PATH is not inherited into this process.
fn ollama_bin() -> String {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let p = format!("{}\\Programs\\Ollama\\ollama.exe", local);
        if std::path::Path::new(&p).exists() {
            return p;
        }
    }
    "ollama".to_string()
}

#[tauri::command]
pub async fn ollama_ensure() -> Result<bool, String> {
    if ollama_tags().await.is_ok() {
        return Ok(true);
    }
    let mut cmd = std::process::Command::new(ollama_bin());
    cmd.arg("serve");
    cmd.env("OLLAMA_MODELS", MODELS_DIR);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    cmd.spawn().map_err(|e| format!("could not start ollama: {}", e))?;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if ollama_tags().await.is_ok() {
            return Ok(true);
        }
    }
    Err("ollama did not come up in 10s".into())
}
