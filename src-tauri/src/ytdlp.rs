// Hysh - web sources through the user's own yt-dlp: YouTube, SoundCloud, Bandcamp and any other
// page yt-dlp understands. Played songs are fetched once into a size-capped cache and then
// served as local files; downloads go straight to the download folder.
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::state::{anyhow_lite::{err, Error, Result}, Shared};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const RELEASE_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";

/// Search back-ends yt-dlp offers.
#[derive(Clone, Copy)]
pub enum Provider {
    /// YouTube Music's song catalogue: official audio tracks with exact lengths (what the
    /// Android clients use). Best for matching catalog songs.
    YouTubeMusic,
    YouTube,
    SoundCloud,
}

impl Provider {
    pub fn parse(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "soundcloud" => Self::SoundCloud,
            "ytmusic" | "youtubemusic" => Self::YouTubeMusic,
            _ => Self::YouTube,
        }
    }
    /// What to hand yt-dlp for a search.
    fn target(self, q: &str, limit: u32) -> String {
        match self {
            Self::YouTube => format!("ytsearch{limit}:{q}"),
            Self::SoundCloud => format!("scsearch{limit}:{q}"),
            Self::YouTubeMusic => {
                let url = reqwest::Url::parse_with_params("https://music.youtube.com/search", &[("q", q)])
                    .map(|u| u.to_string())
                    .unwrap_or_default();
                format!("{url}#songs")
            }
        }
    }
}

pub fn valid_id(id: &str) -> bool {
    id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn valid_page_url(url: &str) -> bool {
    url.starts_with("https://") && url.len() < 2048 && !url.chars().any(char::is_whitespace)
}

// ---------- process plumbing ----------

pub fn find(s: &Shared) -> Option<PathBuf> {
    let custom = s.setting_str("ytdlp_path");
    if !custom.is_empty() && Path::new(&custom).is_file() {
        return Some(PathBuf::from(custom));
    }
    let bundled = s.data_dir.join("bin").join("yt-dlp.exe");
    if bundled.is_file() {
        return Some(bundled);
    }
    std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|p| p.join("yt-dlp.exe")).find(|p| p.is_file()))
}

async fn run(exe: &Path, args: &[&str]) -> Result<String> {
    let out = tokio::process::Command::new(exe)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output()
        .await?;
    if !out.status.success() {
        let e = String::from_utf8_lossy(&out.stderr);
        let line = e.lines().rev().find(|l| l.contains("ERROR")).unwrap_or(e.trim());
        return err(format!("yt-dlp: {}", line.chars().take(300).collect::<String>()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn exe(s: &Shared) -> Result<PathBuf> {
    find(s).ok_or_else(|| Error("yt-dlp is not installed (Settings › Sources)".into()))
}

pub async fn status(s: &Shared) -> Value {
    match find(s) {
        Some(p) => {
            let v = run(&p, &["--version"]).await.unwrap_or_default();
            json!({ "available": true, "path": p, "version": v.trim() })
        }
        None => json!({ "available": false }),
    }
}

/// Downloads the official yt-dlp.exe from its GitHub releases into Hysh's data folder.
pub async fn install(s: &Shared) -> Result<Value> {
    let bytes = s.http.get(RELEASE_URL).send().await?.error_for_status()?.bytes().await?;
    if bytes.len() < 1_000_000 {
        return err("download looked incomplete");
    }
    tokio::fs::write(s.data_dir.join("bin").join("yt-dlp.exe"), &bytes).await?;
    Ok(status(s).await)
}

// ---------- metadata ----------

/// "Artist - Title (Official Video)" -> (artist, title) when the uploader name is not useful.
fn split_title(title: &str, uploader: &str) -> (String, String) {
    let uploader = uploader.trim_end_matches(" - Topic").trim_end_matches("VEVO").trim().to_string();
    if let Some((a, t)) = title.split_once(" - ") {
        return (a.trim().to_string(), crate::lyrics::clean_title(t));
    }
    (uploader, crate::lyrics::clean_title(title))
}

fn str_of<'a>(e: &'a Value, keys: &[&str]) -> &'a str {
    keys.iter().find_map(|k| e.get(*k).and_then(|v| v.as_str()).filter(|s| !s.is_empty())).unwrap_or("")
}

/// SoundCloud hands out full-size "original" artwork; its 300 px rendition is plenty for lists.
fn small_artwork(url: &str) -> String {
    if url.contains("sndcdn.com") { url.replace("-original.", "-t300x300.").replace("-large.", "-t300x300.") } else { url.to_string() }
}

/// Normalises one yt-dlp entry into the UI's track shape.
fn to_track(e: &Value) -> Option<Value> {
    let id = str_of(e, &["id"]);
    let extractor = str_of(e, &["ie_key", "extractor_key", "extractor"]).to_ascii_lowercase();
    let is_youtube = extractor.contains("youtube") || (extractor.is_empty() && valid_id(id));
    let raw_title = str_of(e, &["track", "title"]);
    if raw_title.is_empty() {
        return None;
    }
    let uploader = str_of(e, &["artist", "creator", "channel", "uploader"]);
    let (artist, title) = if e.get("track").is_some() && !uploader.is_empty() {
        (uploader.to_string(), raw_title.to_string())
    } else {
        split_title(raw_title, uploader)
    };
    let duration = e.get("duration").and_then(|x| x.as_f64()).unwrap_or(0.0);
    let thumb = e
        .get("thumbnails")
        .and_then(|t| t.as_array())
        .and_then(|a| a.last())
        .and_then(|t| t.get("url"))
        .and_then(|u| u.as_str())
        .or_else(|| e.get("thumbnail").and_then(|t| t.as_str()))
        .unwrap_or("");
    if is_youtube && valid_id(id) {
        return Some(json!({
            "id": format!("yt:{id}"), "source": "youtube", "videoId": id,
            "title": title, "artist": artist, "album": "", "duration": duration,
            "cover": format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"),
        }));
    }
    let page = str_of(e, &["webpage_url", "original_url", "url"]);
    if !valid_page_url(page) {
        return None;
    }
    let source = if extractor.contains("soundcloud") { "soundcloud" } else if extractor.contains("bandcamp") { "bandcamp" } else { "web" };
    Some(json!({
        "id": format!("url:{page}"), "source": source, "pageUrl": page,
        "title": title, "artist": artist, "album": str_of(e, &["album"]), "duration": duration,
        "cover": if thumb.starts_with("https://") { small_artwork(thumb) } else { String::new() },
    }))
}

pub async fn search(s: &Shared, q: &str, limit: u32, provider: Provider) -> Result<Vec<Value>> {
    let limit = limit.clamp(1, 40);
    let target = provider.target(q, limit);
    let end = limit.to_string();
    let out = run(&exe(s)?, &["-J", "--flat-playlist", "--no-warnings", "--ignore-config", "--playlist-end", &end, &target]).await?;
    let v: Value = serde_json::from_str(&out)?;
    Ok(v.get("entries").and_then(|e| e.as_array()).map(|a| a.iter().filter_map(to_track).collect()).unwrap_or_default())
}

/// Reads a pasted link: a single song, or a playlist / album / set.
pub async fn extract(s: &Shared, url: &str) -> Result<Value> {
    if !valid_page_url(url) {
        return err("paste an https:// link");
    }
    let out = run(&exe(s)?, &["-J", "--flat-playlist", "--no-warnings", "--ignore-config", "--playlist-end", "500", url]).await?;
    let v: Value = serde_json::from_str(&out)?;
    let tracks: Vec<Value> = match v.get("entries").and_then(|e| e.as_array()) {
        Some(entries) => entries.iter().filter_map(to_track).collect(),
        None => to_track(&v).into_iter().collect(),
    };
    Ok(json!({
        "title": str_of(&v, &["title", "playlist_title"]),
        "owner": str_of(&v, &["uploader", "channel", "artist"]),
        "isList": v.get("entries").is_some(),
        "tracks": tracks,
    }))
}

// ---------- matching catalog songs to YouTube Music audio ----------

/// Lower-case words only, for loose comparisons ("Ash Again (feat. X)" -> "ash again feat x").
fn words(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Versions that are not the original recording, unless the song itself is one of them.
const ALTERNATE: &[&str] = &["cover", "remix", "live", "karaoke", "instrumental", "nightcore", "sped", "slowed", "reverb", "8d", "acoustic", "reaction", "tutorial"];
/// Words that commonly decorate an official upload and say nothing about which song it is.
const NOISE: &[&str] = &["official", "music", "video", "audio", "lyrics", "lyric", "mv", "hd", "hq", "4k", "feat", "ft", "prod", "topic", "version", "ver", "visualizer", "the", "a", "with", "x", "and", "full", "op", "ed", "opening", "ending"];

fn word_set(s: &str) -> Vec<String> {
    words(s).split(' ').filter(|w| !w.is_empty()).map(String::from).collect()
}

/// Every credited artist as its own word list ("A, B & C feat. D" -> [[a], [b], [c], [d]]).
fn artists_of(artist: &str) -> Vec<Vec<String>> {
    artist
        .split([',', '&', ';', '/'])
        .flat_map(|a| a.split(" feat").flat_map(|b| b.split(" x ")))
        .map(word_set)
        .filter(|w| !w.is_empty())
        .collect()
}

/// Lower is better. `None` = not acceptable.
fn score(hit: &Value, title: &str, artist: &str, duration: f64) -> Option<f64> {
    let d = hit["duration"].as_f64().unwrap_or(0.0);
    let diff = if duration > 0.0 && d > 0.0 { (d - duration).abs() } else { 10.0 };
    if diff > 30.0 {
        return None;
    }
    let hit_words = word_set(&format!("{} {}", hit["title"].as_str().unwrap_or(""), hit["artist"].as_str().unwrap_or("")));
    let has = |w: &String| hit_words.contains(w);
    let want = word_set(&crate::lyrics::clean_title(title));
    let artists = artists_of(artist);
    let original = word_set(title);

    let mut sc = diff * 2.0;
    // title: share of its words present as whole words
    if !want.is_empty() {
        let found = want.iter().filter(|w| has(w)).count() as f64;
        sc += (1.0 - found / want.len() as f64) * 60.0;
    }
    // artist: at least one credited artist fully present
    if !artists.is_empty() && !artists.iter().any(|a| a.iter().all(|w| has(w))) {
        sc += 30.0;
    }
    // a large share of unrelated words means a different video ("Insane 1 Gbps using ACT GIGA").
    // Non-Latin tokens are skipped: official Japanese / Korean uploads are full of them.
    let known: Vec<&String> = want.iter().chain(artists.iter().flatten()).collect();
    let latin: Vec<&String> = hit_words.iter().filter(|w| w.is_ascii() && !NOISE.contains(&w.as_str())).collect();
    if !latin.is_empty() {
        let extra = latin.iter().filter(|w| !known.contains(w)).count() as f64;
        sc += extra / latin.len() as f64 * 60.0;
    }
    for alt in ALTERNATE {
        if hit_words.iter().any(|w| w.starts_with(alt)) && !original.iter().any(|w| w.starts_with(alt)) {
            sc += 35.0;
        }
    }
    (sc <= 45.0).then_some(sc)
}

/// Finds the YouTube video that best matches catalog metadata (title / artist / length).
/// 1. YouTube search, scored on length, title words, credited artists and alternate versions.
/// 2. YouTube Music's song catalogue (official audio) when nothing passes.
pub async fn find_match(s: &Shared, title: &str, artist: &str, duration: f64) -> Result<Option<String>> {
    let t = crate::lyrics::clean_title(title);
    let credited: Vec<String> = artists_of(artist).into_iter().take(2).map(|w| w.join(" ")).collect();
    let a = credited.join(" ");
    for q in [format!("{t} {a}"), format!("{t} {} official audio", credited.first().cloned().unwrap_or_default())] {
        let hits = search(s, q.trim(), 8, Provider::YouTube).await?;
        let best = hits
            .iter()
            .filter_map(|h| score(h, title, artist, duration).map(|sc| (sc, h)))
            .min_by(|x, y| x.0.total_cmp(&y.0));
        if let Some((_, h)) = best {
            return Ok(h["videoId"].as_str().map(String::from));
        }
    }
    let want = word_set(&t);
    let hits = search(s, format!("{t} {a}").trim(), 5, Provider::YouTubeMusic).await?;
    let pick = hits.iter().find(|h| {
        let ht = word_set(h["title"].as_str().unwrap_or(""));
        !want.is_empty() && want.iter().all(|w| ht.contains(w)) && !ALTERNATE.iter().any(|alt| ht.iter().any(|w| w.starts_with(alt)))
    });
    Ok(pick.and_then(|h| h["videoId"].as_str().map(String::from)))
}

/// JSON description of the best directly streamable audio format of a page (yt-dlp -j).
pub async fn describe(s: &Shared, url: &str) -> Result<String> {
    if !valid_page_url(url) {
        return err("bad url");
    }
    run(
        &exe(s)?,
        &[
            "-j", "--no-playlist", "--no-warnings", "--ignore-config",
            "-f", "bestaudio[protocol=https][ext=webm]/bestaudio[protocol=https][ext=m4a]/bestaudio[protocol=https]/bestaudio",
            url,
        ],
    )
    .await
}

// ---------- playback cache ----------

fn cache_dir(s: &Shared) -> PathBuf {
    let d = s.cache_dir().join("web");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn cache_key(url: &str) -> String {
    format!("{:x}", md5::compute(url))
}

fn cached(dir: &Path, key: &str) -> Option<PathBuf> {
    std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| {
        p.file_stem().and_then(|x| x.to_str()) == Some(key)
            && p.extension().and_then(|x| x.to_str()).is_some_and(|e| e != "part" && e != "ytdl")
    })
}

/// The cached audio file for a page, if it was fetched before.
pub fn cached_file(s: &Shared, url: &str) -> Option<PathBuf> {
    cached(&cache_dir(s), &cache_key(url))
}

/// Keeps the cache under the user's limit by deleting the least recently used files.
fn trim_cache(s: &Shared, dir: &Path) {
    let limit = s.setting("cache_mb").as_u64().unwrap_or(1024) * 1024 * 1024;
    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((e.path(), m.len(), m.accessed().or_else(|_| m.modified()).ok()?))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.2);
    for (p, size, _) in files {
        if total <= limit {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            total -= size;
        }
    }
}

/// Audio for a page URL, fetched once and then served from the cache.
pub async fn fetch(s: &Arc<Shared>, url: &str) -> Result<PathBuf> {
    if !valid_page_url(url) {
        return err("bad url");
    }
    let key = cache_key(url);
    let lock = {
        let mut map = s.fetch_locks.lock().await;
        map.entry(key.clone()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
    };
    let _guard = lock.lock().await; // one fetch per song, however many requests arrive
    let dir = cache_dir(s);
    if let Some(p) = cached(&dir, &key) {
        return Ok(p);
    }
    let template = dir.join(format!("{key}.%(ext)s")).to_string_lossy().to_string();
    run(
        &exe(s)?,
        &[
            "-f", "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best",
            "--no-playlist", "--no-warnings", "--ignore-config", "--no-part", "--no-mtime", "-o", &template, url,
        ],
    )
    .await?;
    trim_cache(s, &dir);
    cached(&dir, &key).ok_or_else(|| Error("yt-dlp finished but no file was written".into()))
}

/// Downloads a page's audio straight into `dir` as `<stem>.<ext>`.
/// `compatible` prefers AAC/M4A (taggable, plays everywhere); otherwise the best stream (Opus on YouTube).
pub async fn download_to(s: &Shared, url: &str, dir: &Path, stem: &str, compatible: bool) -> Result<PathBuf> {
    if !valid_page_url(url) {
        return err("bad url");
    }
    let format = if compatible { "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best" } else { "bestaudio/best" };
    let template = dir.join(format!("{stem}.%(ext)s")).to_string_lossy().to_string();
    let out = run(
        &exe(s)?,
        &[
            "-f", format, "--no-playlist", "--no-warnings", "--ignore-config", "--no-part", "--no-mtime",
            "--no-simulate", "--print", "after_move:filepath", "-o", &template, url,
        ],
    )
    .await?;
    match out.lines().rev().map(str::trim).find(|l| !l.is_empty()).map(PathBuf::from) {
        Some(p) if p.is_file() => Ok(p),
        _ => err("yt-dlp finished but did not report the file"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matcher_prefers_the_original_recording() {
        let hit = |title: &str, artist: &str, d: f64| json!({ "title": title, "artist": artist, "duration": d });
        let official = score(&hit("Better Luck Next Time", "Alohaii", 248.0), "Better Luck Next Time", "Alohaii, Shiki Miyoshino", 248.0).unwrap();
        let cover = score(&hit("Better Luck Next Time cover ver", "Rowa", 248.0), "Better Luck Next Time", "Alohaii, Shiki Miyoshino", 248.0);
        assert!(official < 5.0);
        assert!(cover.is_none(), "a cover by someone else must be rejected");
        assert!(score(&hit("B.L.N.T. (Better Luck Next Time remix)", "CYPARISS", 204.0), "Better Luck Next Time", "Alohaii", 248.0).is_none());
        // the real-world mismatch: same short title word and an artist word, unrelated video
        assert!(score(&hit("Insane 1 Gbps using ACT GIGA", "", 159.0), "ACT (feat. Daoko)", "Giga, TeddyLoid, Daoko", 164.0).is_none());
        assert!(score(&hit("Giga - ACT feat. Daoko", "Giga", 164.0), "ACT (feat. Daoko)", "Giga, TeddyLoid, Daoko", 164.0).unwrap() < 5.0);
        // a remix is fine when the song itself is the remix
        assert!(score(&hit("Song (Remix)", "A", 200.0), "Song (Remix)", "A", 200.0).unwrap() < 10.0);
    }

    #[test]
    fn normalises_youtube_and_soundcloud_entries() {
        let yt = to_track(&json!({ "id": "dQw4w9WgXcQ", "ie_key": "Youtube", "title": "Rick Astley - Never Gonna Give You Up (Official Video)", "channel": "Rick Astley", "duration": 213 })).unwrap();
        assert_eq!(yt["source"], "youtube");
        assert_eq!(yt["artist"], "Rick Astley");
        assert_eq!(yt["title"], "Never Gonna Give You Up");
        let sc = to_track(&json!({ "id": "123", "ie_key": "Soundcloud", "title": "Track", "uploader": "Someone", "url": "https://soundcloud.com/someone/track" })).unwrap();
        assert_eq!(sc["source"], "soundcloud");
        assert_eq!(sc["pageUrl"], "https://soundcloud.com/someone/track");
        assert!(to_track(&json!({ "id": "x", "title": "t", "url": "http://insecure" })).is_none());
    }
}
