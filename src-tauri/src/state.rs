// Hysh - shared application state
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::library::Track;
use rand::Rng;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex, RwLock};

pub const USER_AGENT: &str = concat!(
    "Hysh/",
    env!("CARGO_PKG_VERSION"),
    " (Windows desktop music player)"
);

pub struct Shared {
    pub http: reqwest::Client,
    pub data_dir: PathBuf,
    pub token: String,
    pub port: AtomicU16,
    pub settings: RwLock<Value>,
    pub library: RwLock<Vec<Track>>,
    pub discord: Mutex<Option<crate::discord::Ipc>>,
    /// one lock per page URL, so two requests for the same song never fetch it twice
    pub fetch_locks: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Spotify access token and when it stops being valid
    pub spotify_token: tokio::sync::Mutex<Option<(String, std::time::Instant)>>,
    /// resolved direct audio URLs for web pages (see stream.rs)
    pub direct_cache: tokio::sync::Mutex<HashMap<String, crate::stream::Direct>>,
}

impl Shared {
    pub fn new(data_dir: PathBuf) -> anyhow_lite::Result<Self> {
        std::fs::create_dir_all(&data_dir)?;
        for sub in ["store", "lyrics", "cache", "bin"] {
            std::fs::create_dir_all(data_dir.join(sub))?;
        }
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(std::time::Duration::from_secs(8))
            .gzip(true)
            .build()?;
        let token: String = {
            let mut r = rand::thread_rng();
            (0..32).map(|_| format!("{:x}", r.gen_range(0..16u8))).collect()
        };
        let settings = read_json(&data_dir.join("settings.json")).unwrap_or_else(|| json!({}));
        let library: Vec<Track> = read_json(&data_dir.join("library.json"))
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        Ok(Self {
            http,
            data_dir,
            token,
            port: AtomicU16::new(0),
            settings: RwLock::new(settings),
            library: RwLock::new(library),
            discord: Mutex::new(None),
            fetch_locks: tokio::sync::Mutex::new(HashMap::new()),
            spotify_token: tokio::sync::Mutex::new(None),
            direct_cache: tokio::sync::Mutex::new(HashMap::new()),
        })
    }

    pub fn port(&self) -> u16 {
        self.port.load(Ordering::Relaxed)
    }

    pub fn setting(&self, key: &str) -> Value {
        self.settings
            .read()
            .ok()
            .and_then(|s| s.get(key).cloned())
            .unwrap_or(Value::Null)
    }

    pub fn setting_str(&self, key: &str) -> String {
        match self.setting(key) {
            Value::String(s) => s.trim().to_string(),
            _ => String::new(),
        }
    }

    pub fn setting_bool(&self, key: &str) -> bool {
        matches!(self.setting(key), Value::Bool(true))
    }

    pub fn set_setting(&self, key: &str, value: Value) {
        if let Ok(mut s) = self.settings.write() {
            if !s.is_object() {
                *s = json!({});
            }
            s[key] = value;
        }
        self.save_settings();
    }

    pub fn save_settings(&self) {
        if let Ok(s) = self.settings.read() {
            let _ = write_json(&self.data_dir.join("settings.json"), &s);
        }
    }

    pub fn cache_dir(&self) -> PathBuf {
        self.data_dir.join("cache")
    }

    /// Folder where downloads go: the user's choice, or Music\Hysh.
    pub fn download_dir(&self) -> PathBuf {
        let custom = self.setting_str("download_dir");
        let dir = if !custom.is_empty() {
            PathBuf::from(custom)
        } else {
            dirs::audio_dir()
                .unwrap_or_else(|| self.data_dir.clone())
                .join("Hysh")
        };
        let _ = std::fs::create_dir_all(&dir);
        dir
    }
}

pub fn read_json(path: &Path) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Writes through a temp file so a crash never leaves half a JSON file behind.
pub fn write_json(path: &Path, value: &Value) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(value)?)?;
    std::fs::rename(tmp, path)
}

/// Tiny error helper so every module can use `?` on any error and hand a String to the UI.
pub mod anyhow_lite {
    pub type Result<T> = std::result::Result<T, Error>;
    #[derive(Debug)]
    pub struct Error(pub String);
    impl<E: std::fmt::Display> From<E> for Error {
        fn from(e: E) -> Self {
            Error(e.to_string())
        }
    }
    impl From<Error> for String {
        fn from(e: Error) -> String {
            e.0
        }
    }
    pub fn err<T>(msg: impl Into<String>) -> Result<T> {
        Err(Error(msg.into()))
    }
}
