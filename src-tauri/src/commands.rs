// Hysh - the command surface the UI calls. Each command is a thin adapter over a module.
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::state::{self, Shared};
use crate::{discord, downloads, library, lyrics, plugins, scrobble, spotify, widget, ytdlp};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::Emitter;

type St<'a> = tauri::State<'a, Arc<Shared>>;
type R<T> = Result<T, String>;

// ---------- app / settings / storage ----------

#[tauri::command]
pub fn app_env(s: St) -> Value {
    json!({
        "port": s.port(),
        "token": s.token,
        "dataDir": s.data_dir,
        "downloadDir": s.download_dir(),
        "version": env!("CARGO_PKG_VERSION"),
        "lyricProviders": lyrics::PROVIDERS,
    })
}

#[tauri::command]
pub fn settings_get(s: St) -> Value {
    s.settings.read().map(|v| v.clone()).unwrap_or(Value::Null)
}

#[tauri::command]
pub fn settings_set(s: St, value: Value) {
    if let Ok(mut cur) = s.settings.write() {
        // merge, so keys owned by the backend (Last.fm session...) survive UI saves
        match (cur.as_object_mut(), value.as_object()) {
            (Some(c), Some(n)) => {
                for (k, v) in n {
                    c.insert(k.clone(), v.clone());
                }
            }
            _ => *cur = value,
        }
    }
    s.save_settings();
}

fn store_path(s: &Shared, name: &str) -> R<std::path::PathBuf> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("bad store name".into());
    }
    Ok(s.data_dir.join("store").join(format!("{name}.json")))
}

#[tauri::command]
pub fn store_load(s: St, name: String) -> R<Value> {
    Ok(state::read_json(&store_path(&s, &name)?).unwrap_or(Value::Null))
}

#[tauri::command]
pub fn store_save(s: St, name: String, value: Value) -> R<()> {
    state::write_json(&store_path(&s, &name)?, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn files_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| std::path::Path::new(p).is_file()).collect()
}

// ---------- library ----------

#[tauri::command]
pub fn library_get(s: St) -> Vec<library::Track> {
    s.library.read().map(|l| l.clone()).unwrap_or_default()
}

#[tauri::command]
pub async fn library_scan(app: tauri::AppHandle, s: St<'_>) -> R<usize> {
    let folders: Vec<String> = s
        .setting("music_folders")
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let prev = s.library.read().map(|l| l.clone()).unwrap_or_default();
    let tracks = tokio::task::spawn_blocking(move || {
        library::scan(&folders, &prev, |n| {
            let _ = app.emit("scan-progress", n);
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    let n = tracks.len();
    let v = serde_json::to_value(&tracks).map_err(|e| e.to_string())?;
    state::write_json(&s.data_dir.join("library.json"), &v).map_err(|e| e.to_string())?;
    if let Ok(mut l) = s.library.write() {
        *l = tracks;
    }
    Ok(n)
}

// ---------- network ----------

#[derive(Deserialize)]
pub struct HttpReq {
    url: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    form: Option<HashMap<String, String>>,
    #[serde(default)]
    json: Option<Value>,
    #[serde(default)]
    timeout: Option<u64>,
}

/// Generic HTTP for the catalog modules in the UI (Deezer, iTunes, Apple charts, Radio Browser,
/// Internet Archive, Jamendo, Subsonic, Spotify import, Wikipedia, SponsorBlock...).
/// Runs in Rust so there are no CORS limits.
#[tauri::command]
pub async fn http_request(s: St<'_>, req: HttpReq) -> R<Value> {
    if !(req.url.starts_with("https://") || req.url.starts_with("http://")) {
        return Err("only http(s) urls".into());
    }
    let mut rb = match req.method.as_deref().unwrap_or("GET").to_ascii_uppercase().as_str() {
        "POST" => s.http.post(&req.url),
        "PUT" => s.http.put(&req.url),
        "DELETE" => s.http.delete(&req.url),
        _ => s.http.get(&req.url),
    };
    rb = rb.timeout(std::time::Duration::from_secs(req.timeout.unwrap_or(15)));
    for (k, v) in &req.headers {
        rb = rb.header(k, v);
    }
    if let Some(f) = &req.form {
        rb = rb.form(f);
    } else if let Some(j) = &req.json {
        rb = rb.json(j);
    }
    let resp = rb.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let body = serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text));
    Ok(json!({ "status": status, "ok": (200..300).contains(&status), "body": body }))
}

/// Subsonic token auth needs md5(password + salt).
#[tauri::command]
pub fn md5_hex(text: String) -> String {
    format!("{:x}", md5::compute(text))
}

// ---------- lyrics / scrobbling / presence ----------

#[tauri::command]
pub async fn lyrics_get(s: St<'_>, query: lyrics::Query) -> R<Option<lyrics::Lyrics>> {
    Ok(lyrics::get(&s, query).await)
}

#[tauri::command]
pub async fn lastfm_login(s: St<'_>, user: String, pass: String) -> R<String> {
    scrobble::lastfm_login(&s, &user, &pass).await.map_err(Into::into)
}

#[tauri::command]
pub async fn scrobble_now(s: St<'_>, track: scrobble::ScrobbleTrack) -> R<()> {
    scrobble::now_playing(&s, track).await.map_err(Into::into)
}

#[tauri::command]
pub async fn scrobble_submit(s: St<'_>, track: scrobble::ScrobbleTrack, timestamp: u64) -> R<()> {
    scrobble::scrobble(&s, track, timestamp).await.map_err(Into::into)
}

#[tauri::command]
pub async fn discord_update(s: St<'_>, activity: Option<discord::Activity>) -> R<()> {
    let shared = s.inner().clone();
    tokio::task::spawn_blocking(move || discord::update(&shared, activity))
        .await
        .map_err(|e| e.to_string())?
}

// ---------- web sources (yt-dlp) ----------

#[tauri::command]
pub async fn yt_status(s: St<'_>) -> R<Value> {
    Ok(ytdlp::status(&s).await)
}

#[tauri::command]
pub async fn yt_install(s: St<'_>) -> R<Value> {
    ytdlp::install(&s).await.map_err(Into::into)
}

#[tauri::command]
pub async fn yt_search(s: St<'_>, query: String, limit: Option<u32>, provider: Option<String>) -> R<Vec<Value>> {
    let provider = ytdlp::Provider::parse(provider.as_deref().unwrap_or("youtube"));
    ytdlp::search(&s, &query, limit.unwrap_or(20), provider).await.map_err(Into::into)
}

#[tauri::command]
pub async fn yt_extract(s: St<'_>, url: String) -> R<Value> {
    ytdlp::extract(&s, &url).await.map_err(Into::into)
}

/// Resolves a page's direct stream link in the background so the song starts instantly later.
#[tauri::command]
pub async fn web_warm(s: St<'_>, url: String) -> R<()> {
    crate::stream::direct(&s, &url).await.map(|_| ()).map_err(Into::into)
}

#[tauri::command]
pub async fn yt_match(s: St<'_>, title: String, artist: String, duration: f64) -> R<Option<String>> {
    ytdlp::find_match(&s, &title, &artist, duration).await.map_err(Into::into)
}

// ---------- downloads ----------

#[tauri::command]
pub async fn download(s: St<'_>, req: downloads::Request) -> R<String> {
    downloads::download(&s, req)
        .await
        .map(|p| p.to_string_lossy().to_string())
        .map_err(Into::into)
}

// ---------- Spotify account ----------

#[tauri::command]
pub async fn spotify_connect(s: St<'_>) -> R<Value> {
    spotify::connect(&s).await.map_err(Into::into)
}

#[tauri::command]
pub async fn spotify_token(s: St<'_>) -> R<String> {
    spotify::access_token(&s).await.map_err(Into::into)
}

#[tauri::command]
pub async fn spotify_disconnect(s: St<'_>) -> R<()> {
    spotify::disconnect(&s).await;
    Ok(())
}

// ---------- widget window ----------

#[tauri::command]
pub fn widget_open(app: tauri::AppHandle, s: St) -> R<()> {
    widget::open(&app, &s).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn widget_close(app: tauri::AppHandle) {
    widget::close(&app);
}

// ---------- plugins ----------

#[tauri::command]
pub fn plugins_list(s: St) -> Value {
    json!({ "dir": plugins::dir(&s), "plugins": plugins::list(&s) })
}

// ---------- import / export files (paths always come from a file dialog) ----------

const MAX_IMPORT_BYTES: u64 = 32 * 1024 * 1024;

#[tauri::command]
pub async fn read_text_file(path: String) -> R<String> {
    let meta = tokio::fs::metadata(&path).await.map_err(|e| e.to_string())?;
    if meta.len() > MAX_IMPORT_BYTES {
        return Err("file is too large to import".into());
    }
    let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
    // tolerate a UTF-8 BOM and Windows-1252 leftovers in old playlists
    let text = String::from_utf8_lossy(&bytes);
    Ok(text.trim_start_matches('\u{feff}').to_string())
}

#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> R<()> {
    tokio::fs::write(&path, contents).await.map_err(|e| e.to_string())
}

// ---------- shell ----------

#[tauri::command]
pub fn open_path(path: String) -> R<()> {
    let p = std::path::Path::new(&path);
    let mut c = std::process::Command::new("explorer");
    if p.is_file() {
        c.arg(format!("/select,{path}"));
    } else {
        c.arg(&path);
    }
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_url(url: String) -> R<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only web links".into());
    }
    std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
