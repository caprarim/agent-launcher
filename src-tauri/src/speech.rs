use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::SharedState;

static APP: OnceCell<AppHandle> = OnceCell::new();

pub fn set_app(app: AppHandle) {
    let _ = APP.set(app);
}

fn emit_speaking(on: bool) {
    if let Some(app) = APP.get() {
        let _ = app.emit("tts-state", serde_json::json!({ "speaking": on }));
    }
}

pub struct TtsQueue {
    tx: mpsc::Sender<(u64, String)>,
    gen: Arc<AtomicU64>,
    current: Arc<Mutex<Option<Child>>>,
}

impl TtsQueue {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<(u64, String)>();
        let gen: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let current: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
        let gen_t = gen.clone();
        let cur_t = current.clone();
        std::thread::spawn(move || loop {
            let Ok(first) = rx.recv() else { break };
            emit_speaking(true);
            let mut item = Some(first);
            while let Some((g, text)) = item.take() {
                let text = text.trim().to_string();
                if !text.is_empty() && g >= gen_t.load(Ordering::SeqCst) {
                    if !speak_piper(&text, &gen_t, g, &cur_t) && g >= gen_t.load(Ordering::SeqCst) {
                        speak_sapi(&text, &gen_t, g, &cur_t);
                    }
                }
                item = rx.try_recv().ok();
            }
            emit_speaking(false);
        });
        Self { tx, gen, current }
    }

    pub fn say(&self, text: &str) {
        let g = self.gen.load(Ordering::SeqCst);
        let _ = self.tx.send((g, text.to_string()));
    }

    pub fn stop(&self) {
        self.gen.fetch_add(1, Ordering::SeqCst);
        if let Some(child) = self.current.lock().as_mut() {
            let _ = child.kill();
        }
    }
}

fn wait_current(gen: &Arc<AtomicU64>, g: u64, slot: &Arc<Mutex<Option<Child>>>) -> bool {
    loop {
        if g < gen.load(Ordering::SeqCst) {
            if let Some(c) = slot.lock().as_mut() {
                let _ = c.kill();
            }
        }
        {
            let mut guard = slot.lock();
            match guard.as_mut() {
                None => return false,
                Some(c) => match c.try_wait() {
                    Ok(Some(status)) => {
                        *guard = None;
                        return status.success() && g >= gen.load(Ordering::SeqCst);
                    }
                    Ok(None) => {}
                    Err(_) => {
                        *guard = None;
                        return false;
                    }
                },
            }
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

fn piper_defaults() -> (PathBuf, PathBuf) {
    #[cfg(windows)]
    {
        (
            PathBuf::from("D:\\ai\\piper\\piper\\piper.exe"),
            PathBuf::from("D:\\ai\\piper\\piper\\en_US-amy-medium.onnx"),
        )
    }
    #[cfg(not(windows))]
    {
        let base = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/opt"))
            .join(".local/share/piper");
        (base.join("piper"), base.join("en_US-amy-medium.onnx"))
    }
}

fn piper_paths() -> (PathBuf, PathBuf) {
    let (default_exe, default_model) = piper_defaults();
    let exe = std::env::var("AGENT_PIPER_EXE")
        .map(PathBuf::from)
        .unwrap_or(default_exe);
    let model = std::env::var("AGENT_PIPER_MODEL")
        .map(PathBuf::from)
        .unwrap_or(default_model);
    (exe, model)
}

/// Neural offline TTS via Piper. Returns true if it handled the utterance.
fn speak_piper(text: &str, gen: &Arc<AtomicU64>, g: u64, slot: &Arc<Mutex<Option<Child>>>) -> bool {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let (exe, model) = piper_paths();
    if !exe.exists() || !model.exists() {
        return false;
    }
    if g < gen.load(Ordering::SeqCst) {
        return true;
    }
    let out_wav = std::env::temp_dir().join("agent-launcher-tts.wav");
    let dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();

    let mut cmd = Command::new(&exe);
    cmd.args([
        "--model",
        &model.to_string_lossy(),
        "--output_file",
        &out_wav.to_string_lossy(),
    ]);
    if dir.exists() {
        cmd.current_dir(&dir);
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let Ok(mut child) = cmd.spawn() else {
        return false;
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(text.as_bytes());
        let _ = stdin.write_all(b"\n");
    }
    *slot.lock() = Some(child);
    let ok = wait_current(gen, g, slot);
    if g < gen.load(Ordering::SeqCst) {
        return true;
    }
    if !ok || !out_wav.exists() {
        return false;
    }
    play_wav(&out_wav, gen, g, slot)
}

#[cfg(windows)]
fn play_wav(path: &Path, gen: &Arc<AtomicU64>, g: u64, slot: &Arc<Mutex<Option<Child>>>) -> bool {
    let script = format!(
        "(New-Object System.Media.SoundPlayer '{}').PlaySync()",
        path.to_string_lossy().replace('\'', "''")
    );
    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script]);
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let Ok(child) = cmd.spawn() else {
        return false;
    };
    *slot.lock() = Some(child);
    wait_current(gen, g, slot) || g < gen.load(Ordering::SeqCst)
}

#[cfg(not(windows))]
fn play_wav(path: &Path, gen: &Arc<AtomicU64>, g: u64, slot: &Arc<Mutex<Option<Child>>>) -> bool {
    use std::process::Stdio;
    let file = path.to_string_lossy().to_string();
    for (bin, args) in [("paplay", vec![]), ("aplay", vec!["-q"])] {
        let mut cmd = std::process::Command::new(bin);
        cmd.args(args);
        cmd.arg(&file);
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
        if let Ok(child) = cmd.spawn() {
            *slot.lock() = Some(child);
            return wait_current(gen, g, slot) || g < gen.load(Ordering::SeqCst);
        }
    }
    false
}

/// Fallback TTS via Windows SAPI, using the clearest installed voice.
#[cfg(windows)]
fn speak_sapi(text: &str, gen: &Arc<AtomicU64>, g: u64, slot: &Arc<Mutex<Option<Child>>>) {
    let escaped = text.replace('\'', "''");
    let script = format!(
        "Add-Type -AssemblyName System.Speech; \
         $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
         foreach ($v in @('Microsoft Zira Desktop','Microsoft Hazel Desktop')) {{ \
           try {{ $s.SelectVoice($v); break }} catch {{}} \
         }} \
         $s.Rate = 0; $s.Volume = 100; $s.Speak('{}'); $s.Dispose()",
        escaped
    );
    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script]);
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    if g < gen.load(Ordering::SeqCst) {
        return;
    }
    if let Ok(child) = cmd.spawn() {
        *slot.lock() = Some(child);
        let _ = wait_current(gen, g, slot);
    }
}

/// Fallback TTS on Linux, espeak-ng first then speech-dispatcher.
#[cfg(not(windows))]
fn speak_sapi(text: &str, gen: &Arc<AtomicU64>, g: u64, slot: &Arc<Mutex<Option<Child>>>) {
    use std::process::Stdio;
    if g < gen.load(Ordering::SeqCst) {
        return;
    }
    for (bin, args) in [
        ("espeak-ng", vec!["-s", "170", "-v", "en-us"]),
        ("espeak", vec!["-s", "170", "-v", "en-us"]),
        ("spd-say", vec!["-w"]),
    ] {
        let mut cmd = std::process::Command::new(bin);
        cmd.args(args);
        cmd.arg(text);
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
        if let Ok(child) = cmd.spawn() {
            *slot.lock() = Some(child);
            let _ = wait_current(gen, g, slot);
            return;
        }
    }
}

#[tauri::command]
pub fn speak(state: State<'_, SharedState>, text: String) {
    state.tts.say(&text);
}

#[tauri::command]
pub fn speak_stop(state: State<'_, SharedState>) {
    state.tts.stop();
}

struct RecHandle {
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<f32>>>,
    meta: Arc<Mutex<(u32, u16)>>,
    join: std::thread::JoinHandle<()>,
}

pub struct Recorder {
    inner: Mutex<Option<RecHandle>>,
}

impl Recorder {
    pub fn new() -> Self {
        Self { inner: Mutex::new(None) }
    }
}

fn input_device_names() -> Vec<String> {
    let host = cpal::default_host();
    let Ok(devices) = host.input_devices() else {
        return Vec::new();
    };
    devices.filter_map(|d| d.name().ok()).collect()
}

#[tauri::command]
pub fn list_input_devices() -> Vec<String> {
    input_device_names()
}

#[tauri::command]
pub fn default_input_device() -> Option<String> {
    cpal::default_host().default_input_device().and_then(|d| d.name().ok())
}

fn resolve_device(host: &cpal::Host, want: &Option<String>) -> Option<cpal::Device> {
    match want {
        None => host.default_input_device(),
        Some(name) => host
            .input_devices()
            .ok()?
            .find(|d| d.name().map(|n| n == *name).unwrap_or(false)),
    }
}

fn device_order(prefs: &[String]) -> Vec<Option<String>> {
    let mut order: Vec<Option<String>> = Vec::new();
    for p in prefs {
        let p = p.trim();
        if !p.is_empty() && !order.iter().any(|o| o.as_deref() == Some(p)) {
            order.push(Some(p.to_string()));
        }
    }
    order.push(None);
    for name in input_device_names() {
        if !order.iter().any(|o| o.as_deref() == Some(name.as_str())) {
            order.push(Some(name));
        }
    }
    order
}

const PROBE_MS: u64 = 900;

#[tauri::command]
pub fn voice_start(state: State<'_, SharedState>, devices: Option<Vec<String>>) -> Result<(), String> {
    let mut guard = state.recorder.inner.lock();
    if guard.is_some() {
        return Ok(());
    }
    let prefs = devices.unwrap_or_default();
    let stop = Arc::new(AtomicBool::new(false));
    let samples: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let meta: Arc<Mutex<(u32, u16)>> = Arc::new(Mutex::new((16000, 1)));

    let stop_t = stop.clone();
    let samples_t = samples.clone();
    let meta_t = meta.clone();
    let join = std::thread::spawn(move || {
        let host = cpal::default_host();
        for want in device_order(&prefs) {
            if stop_t.load(Ordering::Relaxed) {
                return;
            }
            let Some(device) = resolve_device(&host, &want) else { continue };
            let Ok(config) = device.default_input_config() else { continue };
            samples_t.lock().clear();
            *meta_t.lock() = (config.sample_rate().0, config.channels());
            let err_fn = |e| eprintln!("[voice] stream error: {}", e);
            let stream = match config.sample_format() {
                cpal::SampleFormat::F32 => {
                    let s = samples_t.clone();
                    device.build_input_stream(
                        &config.into(),
                        move |data: &[f32], _: &cpal::InputCallbackInfo| s.lock().extend_from_slice(data),
                        err_fn,
                        None,
                    )
                }
                cpal::SampleFormat::I16 => {
                    let s = samples_t.clone();
                    device.build_input_stream(
                        &config.into(),
                        move |data: &[i16], _: &cpal::InputCallbackInfo| {
                            s.lock().extend(data.iter().map(|v| *v as f32 / 32768.0))
                        },
                        err_fn,
                        None,
                    )
                }
                cpal::SampleFormat::U16 => {
                    let s = samples_t.clone();
                    device.build_input_stream(
                        &config.into(),
                        move |data: &[u16], _: &cpal::InputCallbackInfo| {
                            s.lock().extend(data.iter().map(|v| (*v as f32 - 32768.0) / 32768.0))
                        },
                        err_fn,
                        None,
                    )
                }
                other => {
                    eprintln!("[voice] unsupported sample format {:?}", other);
                    continue;
                }
            };
            let Ok(stream) = stream else { continue };
            if stream.play().is_err() {
                continue;
            }

            let probe_until = Instant::now() + Duration::from_millis(PROBE_MS);
            let mut alive = false;
            while !stop_t.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(30));
                if !alive {
                    if !samples_t.lock().is_empty() {
                        alive = true;
                    } else if Instant::now() >= probe_until {
                        break;
                    }
                }
            }
            drop(stream);
            if alive || stop_t.load(Ordering::Relaxed) {
                return;
            }
        }
        eprintln!("[voice] no working input device");
    });

    *guard = Some(RecHandle { stop, samples, meta, join });
    Ok(())
}

fn resample_to_16k(samples: &[f32], rate: u32, channels: u16) -> Vec<i16> {
    let ch = channels.max(1) as usize;
    let mono: Vec<f32> = samples
        .chunks(ch)
        .map(|frame| frame.iter().sum::<f32>() / ch as f32)
        .collect();
    if rate == 16000 {
        return mono.iter().map(|v| (v.clamp(-1.0, 1.0) * 32767.0) as i16).collect();
    }
    let ratio = rate as f64 / 16000.0;
    let out_len = (mono.len() as f64 / ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * ratio;
        let idx = pos as usize;
        let frac = (pos - idx as f64) as f32;
        let a = mono.get(idx).copied().unwrap_or(0.0);
        let b = mono.get(idx + 1).copied().unwrap_or(a);
        let v = a + (b - a) * frac;
        out.push((v.clamp(-1.0, 1.0) * 32767.0) as i16);
    }
    out
}

fn write_wav(path: &Path, pcm: &[i16]) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).map_err(|e| e.to_string())?;
    for s in pcm {
        writer.write_sample(*s).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn voice_stop(app: AppHandle, state: State<'_, SharedState>) -> Result<String, String> {
    let handle = state.recorder.inner.lock().take();
    let Some(handle) = handle else {
        return Err("not recording".into());
    };

    let wav_path = tauri::async_runtime::spawn_blocking(move || {
        handle.stop.store(true, Ordering::Relaxed);
        let _ = handle.join.join();
        let samples = handle.samples.lock().clone();
        let (rate, channels) = *handle.meta.lock();
        if samples.len() < 1600 {
            return Err("no audio captured, pick a working microphone in settings".to_string());
        }

        let pcm = resample_to_16k(&samples, rate, channels);
        let wav_path = std::env::temp_dir().join("agent-launcher-voice.wav");
        write_wav(&wav_path, &pcm)?;
        Ok(wav_path)
    })
    .await
    .map_err(|e| format!("voice task panicked: {}", e))??;

    crate::groq::transcribe_wav(&app, &wav_path).await
}

#[tauri::command]
pub fn ensure_workspace_config(app: AppHandle, workspace_id: String) -> Result<String, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("claude-workspaces")
        .join(&workspace_id);
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;

    if let Some(home) = dirs::home_dir() {
        let seed_json = home.join(".claude.json");
        let target_json = base.join(".claude.json");
        if seed_json.exists() && !target_json.exists() {
            let _ = std::fs::copy(&seed_json, &target_json);
        }
        let seed_creds = home.join(".claude").join(".credentials.json");
        let target_creds = base.join(".credentials.json");
        if seed_creds.exists() && !target_creds.exists() {
            let _ = std::fs::copy(&seed_creds, &target_creds);
        }
    }
    Ok(base.to_string_lossy().to_string())
}
