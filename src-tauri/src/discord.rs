// Hysh - Discord Rich Presence over the local IPC pipe (no SDK needed)
// SPDX-License-Identifier: GPL-3.0-or-later

use serde::Deserialize;
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};

pub struct Ipc {
    pipe: File,
    nonce: u64,
}

impl Ipc {
    pub fn connect(app_id: &str) -> io::Result<Self> {
        for i in 0..10 {
            let path = format!(r"\\.\pipe\discord-ipc-{i}");
            if let Ok(pipe) = OpenOptions::new().read(true).write(true).open(&path) {
                let mut ipc = Ipc { pipe, nonce: 0 };
                ipc.send(0, &json!({ "v": 1, "client_id": app_id }))?;
                let ready = ipc.recv()?;
                if ready.get("evt").and_then(|e| e.as_str()) == Some("READY") {
                    return Ok(ipc);
                }
                return Err(io::Error::new(io::ErrorKind::Other, format!("Discord refused the handshake: {ready}")));
            }
        }
        Err(io::Error::new(io::ErrorKind::NotFound, "Discord is not running"))
    }

    fn send(&mut self, op: u32, payload: &Value) -> io::Result<()> {
        let body = payload.to_string().into_bytes();
        let mut frame = Vec::with_capacity(8 + body.len());
        frame.extend_from_slice(&op.to_le_bytes());
        frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
        frame.extend_from_slice(&body);
        self.pipe.write_all(&frame)?;
        self.pipe.flush()
    }

    fn recv(&mut self) -> io::Result<Value> {
        let mut header = [0u8; 8];
        self.pipe.read_exact(&mut header)?;
        let len = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
        let mut body = vec![0u8; len.min(1 << 20)];
        self.pipe.read_exact(&mut body)?;
        Ok(serde_json::from_slice(&body).unwrap_or(Value::Null))
    }

    pub fn set_activity(&mut self, activity: Option<Value>) -> io::Result<()> {
        self.nonce += 1;
        let args = match activity {
            Some(a) => json!({ "pid": std::process::id(), "activity": a }),
            None => json!({ "pid": std::process::id() }),
        };
        self.send(1, &json!({ "cmd": "SET_ACTIVITY", "args": args, "nonce": self.nonce.to_string() }))?;
        self.recv().map(|_| ())
    }
}

#[derive(Deserialize, Debug, Clone)]
pub struct Activity {
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub cover: String,
    #[serde(default)]
    pub position: f64,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub playing: bool,
    /// optional public link for a "Listen" button on the profile card
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub url_label: String,
}

/// Shows / clears the status, connecting lazily and reconnecting once if Discord restarted.
/// Blocking (named-pipe I/O): call it from a blocking task.
pub fn update(s: &crate::state::Shared, activity: Option<Activity>) -> Result<(), String> {
    let app_id = s.setting_str("discord_app_id");
    let enabled = s.setting_bool("discord_enabled") && !app_id.is_empty();
    let mut guard = s.discord.lock().map_err(|e| e.to_string())?;
    if !enabled {
        if let Some(ipc) = guard.as_mut() {
            let _ = ipc.set_activity(None);
        }
        *guard = None;
        return Ok(());
    }
    let payload = activity.as_ref().map(build);
    for _attempt in 0..2 {
        if guard.is_none() {
            *guard = Some(Ipc::connect(&app_id).map_err(|e| e.to_string())?);
        }
        match guard.as_mut().map(|ipc| ipc.set_activity(payload.clone())) {
            Some(Ok(())) => return Ok(()),
            _ => *guard = None,
        }
    }
    Err("Discord did not accept the status".into())
}

pub fn build(a: &Activity) -> Value {
    fn clip(s: &str) -> String {
        // Discord rejects fields shorter than 2 or longer than 128 characters
        let mut s: String = s.chars().take(120).collect();
        while s.chars().count() < 2 {
            s.push(' ');
        }
        s
    }
    // type 2 = "Listening to ...". status_display_type 1 makes the member list read
    // "Listening to <artist>" instead of the application name.
    let mut act = json!({
        "type": 2,
        "status_display_type": 1,
        "details": clip(&a.title),
        "state": clip(&a.artist),
        "assets": { "large_text": clip(if a.album.is_empty() { &a.title } else { &a.album }) },
    });
    if a.cover.starts_with("https://") {
        act["assets"]["large_image"] = json!(a.cover);
    }
    if a.url.starts_with("https://") {
        let label = if a.url_label.is_empty() { "Listen".to_string() } else { a.url_label.chars().take(30).collect() };
        act["buttons"] = json!([{ "label": label, "url": a.url }]);
    }
    if a.playing && a.duration > 0.0 {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let start = now - (a.position * 1000.0) as i64;
        act["timestamps"] = json!({ "start": start, "end": start + (a.duration * 1000.0) as i64 });
    } else if !a.playing {
        act["assets"]["small_text"] = json!("Paused");
    }
    act
}
