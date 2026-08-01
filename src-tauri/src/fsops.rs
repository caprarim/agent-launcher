use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

#[derive(Serialize)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDirectory")]
    pub is_directory: bool,
}

#[derive(Serialize, Default)]
pub struct FsReadDirResult {
    pub entries: Vec<FsEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Default)]
pub struct FsReadFileResult {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Default)]
pub struct FsWriteFileResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

const IGNORE: [&str; 6] = [
    ".git",
    "node_modules",
    "__pycache__",
    ".next",
    "dist",
    ".DS_Store",
];

pub fn read_dir(dir_path: &str) -> FsReadDirResult {
    let entries = match fs::read_dir(dir_path) {
        Ok(e) => e,
        Err(err) => {
            return FsReadDirResult {
                entries: Vec::new(),
                error: Some(err.to_string()),
            }
        }
    };

    let mut out: Vec<FsEntry> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if IGNORE.contains(&name.as_str()) {
            continue;
        }
        let is_directory = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(FsEntry {
            path: entry.path().to_string_lossy().to_string(),
            name,
            is_directory,
        });
    }
    out.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    FsReadDirResult {
        entries: out,
        error: None,
    }
}

pub fn read_file(file_path: &str) -> FsReadFileResult {
    match fs::read_to_string(file_path) {
        Ok(content) => FsReadFileResult {
            content,
            error: None,
        },
        Err(err) => FsReadFileResult {
            content: String::new(),
            error: Some(err.to_string()),
        },
    }
}

pub fn write_file(file_path: &str, content: &str) -> FsWriteFileResult {
    match fs::write(file_path, content) {
        Ok(()) => FsWriteFileResult {
            success: true,
            error: None,
        },
        Err(err) => FsWriteFileResult {
            success: false,
            error: Some(err.to_string()),
        },
    }
}

// Open editor files are watched so an edit made by an agent in a terminal shows
// up in the editor pane. Dropping the watcher is what stops it.
#[derive(Default)]
pub struct FsWatchers(Mutex<HashMap<String, RecommendedWatcher>>);

impl FsWatchers {
    pub fn watch(&self, app: &AppHandle, file_path: &str) {
        let mut guard = self.0.lock().unwrap();
        if guard.contains_key(file_path) {
            return;
        }
        let app = app.clone();
        let emitted_path = file_path.to_string();
        let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if res.is_ok() {
                let _ = app.emit("fs:changed", emitted_path.clone());
            }
        }) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[fs] watch failed: {e}");
                return;
            }
        };
        if let Err(e) = watcher.watch(Path::new(file_path), RecursiveMode::NonRecursive) {
            eprintln!("[fs] watch failed: {e}");
            return;
        }
        guard.insert(file_path.to_string(), watcher);
    }

    pub fn unwatch(&self, file_path: &str) {
        self.0.lock().unwrap().remove(file_path);
    }

    pub fn clear(&self) {
        self.0.lock().unwrap().clear();
    }
}
