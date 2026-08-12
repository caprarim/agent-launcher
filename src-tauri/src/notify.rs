use tauri::{AppHandle, Manager};

const APP_NAME: &str = "Claude Agent";
const TITLE: &str = "Claude";
#[cfg(not(windows))]
const VISIBLE_MS: u64 = 5000;

#[cfg(windows)]
const TOAST_AUMID: &str = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

fn app_focused(app: &AppHandle) -> bool {
    app.webview_windows()
        .values()
        .any(|w| w.is_focused().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
}

#[cfg(windows)]
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(windows)]
fn show_notification(title: &str, body: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let script = format!(
        "$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]; \
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]; \
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument; \
$xml.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>'); \
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml; \
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{}').Show($toast)",
        escape(title),
        escape(body),
        TOAST_AUMID,
    );
    let out = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            script.as_str(),
        ])
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&out.stderr)
        .trim()
        .chars()
        .take(160)
        .collect())
}

#[cfg(not(windows))]
fn close_after(id: String) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(VISIBLE_MS));
        let _ = std::process::Command::new("gdbus")
            .args([
                "call",
                "--session",
                "--dest",
                "org.freedesktop.Notifications",
                "--object-path",
                "/org/freedesktop/Notifications",
                "--method",
                "org.freedesktop.Notifications.CloseNotification",
                id.as_str(),
            ])
            .output();
    });
}

#[cfg(not(windows))]
fn show_notification(title: &str, body: &str) -> Result<(), String> {
    if let Ok(o) = std::process::Command::new("notify-send")
        .args(["-a", APP_NAME, "-u", "normal", "-t", "5000", "-p", title, body])
        .output()
    {
        if o.status.success() {
            let id = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !id.is_empty() {
                close_after(id);
            }
            return Ok(());
        }
    }
    let out = std::process::Command::new("gdbus")
        .args([
            "call",
            "--session",
            "--dest",
            "org.freedesktop.Notifications",
            "--object-path",
            "/org/freedesktop/Notifications",
            "--method",
            "org.freedesktop.Notifications.Notify",
            APP_NAME,
            "0",
            "",
            title,
            body,
            "[]",
            "{}",
            "5000",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&out.stderr)
        .trim()
        .chars()
        .take(160)
        .collect())
}

#[tauri::command(async)]
pub fn notify_agent_done(app: AppHandle, message: String) -> bool {
    let body = if message.trim().is_empty() {
        "Claude has finished working.".to_string()
    } else {
        message.trim().to_string()
    };
    if app_focused(&app) {
        crate::files::log_line(&app, "notify skipped, launcher window is focused");
        return false;
    }
    match show_notification(TITLE, &body) {
        Ok(()) => {
            crate::files::log_line(&app, &format!("notify shown {}", body));
            true
        }
        Err(e) => {
            crate::files::log_line(&app, &format!("notify failed {}", e));
            false
        }
    }
}
