// Hysh - local music library: scanning, tags and cover art
// SPDX-License-Identifier: GPL-3.0-or-later

use lofty::file::TaggedFileExt;
use lofty::prelude::*;
use lofty::picture::PictureType;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

/// Formats the WebView2 (Chromium) audio element can decode natively.
pub const AUDIO_EXT: &[&str] = &["mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wav", "webm", "mp4"];

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Track {
    pub id: String,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub genre: String,
    pub year: u32,
    pub track_no: u32,
    pub disc: u32,
    pub duration: f64,
    pub mtime: u64,
    pub size: u64,
    pub added: u64,
}

pub fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXT.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn file_times(path: &Path) -> (u64, u64) {
    match std::fs::metadata(path) {
        Ok(m) => {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            (mtime, m.len())
        }
        Err(_) => (0, 0),
    }
}

pub fn read_track(path: &Path) -> Track {
    let (mtime, size) = file_times(path);
    let p = path.to_string_lossy().to_string();
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut t = Track {
        id: format!("local:{p}"),
        path: p,
        title: stem.clone(),
        mtime,
        size,
        added: now_secs(),
        ..Default::default()
    };
    if let Ok(tagged) = lofty::read_from_path(path) {
        t.duration = tagged.properties().duration().as_secs_f64();
        if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
            if let Some(v) = tag.title() {
                if !v.trim().is_empty() {
                    t.title = v.trim().to_string();
                }
            }
            t.artist = tag.artist().map(|s| s.trim().to_string()).unwrap_or_default();
            t.album = tag.album().map(|s| s.trim().to_string()).unwrap_or_default();
            t.genre = tag.genre().map(|s| s.trim().to_string()).unwrap_or_default();
            t.album_artist = tag
                .get_string(&ItemKey::AlbumArtist)
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            t.track_no = tag.track().unwrap_or(0);
            t.disc = tag.disk().unwrap_or(0);
            t.year = tag.year().unwrap_or(0);
        }
    }
    // "Artist - Title.mp3" files without tags
    if t.artist.is_empty() {
        if let Some((a, b)) = stem.split_once(" - ") {
            if t.title == stem {
                t.title = b.trim().to_string();
            }
            t.artist = a.trim().to_string();
        }
    }
    if t.artist.is_empty() {
        t.artist = "Unknown Artist".into();
    }
    if t.album.is_empty() {
        t.album = path
            .parent()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "Unknown Album".into());
    }
    t
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Rescans every folder. Files whose mtime and size did not change keep their cached entry,
/// so a rescan of a large, unchanged library only costs a directory walk.
pub fn scan(folders: &[String], previous: &[Track], progress: impl Fn(usize) + Sync) -> Vec<Track> {
    let prev: HashMap<&str, &Track> = previous.iter().map(|t| (t.path.as_str(), t)).collect();
    let mut files = Vec::new();
    for folder in folders {
        for entry in WalkDir::new(folder).follow_links(true).into_iter().flatten() {
            if entry.file_type().is_file() && is_audio(entry.path()) {
                files.push(entry.into_path());
            }
        }
    }
    let done = AtomicUsize::new(0);
    let total = files.len();
    let mut out: Vec<Track> = files
        .par_iter()
        .map(|path| {
            let key = path.to_string_lossy();
            let (mtime, size) = file_times(path);
            let t = match prev.get(key.as_ref()) {
                Some(old) if old.mtime == mtime && old.size == size => (*old).clone(),
                Some(old) => {
                    let mut t = read_track(path);
                    t.added = old.added;
                    t
                }
                None => read_track(path),
            };
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            if n % 150 == 0 || n == total {
                progress(n);
            }
            t
        })
        .collect();
    out.sort_by(|a, b| {
        (a.album_artist.to_lowercase(), a.album.to_lowercase(), a.disc, a.track_no, a.title.to_lowercase()).cmp(&(
            b.album_artist.to_lowercase(),
            b.album.to_lowercase(),
            b.disc,
            b.track_no,
            b.title.to_lowercase(),
        ))
    });
    out.dedup_by(|a, b| a.path == b.path);
    out
}

/// Embedded front cover, or cover.jpg / folder.jpg next to the file.
pub fn cover_for(path: &Path) -> Option<(Vec<u8>, String)> {
    if let Ok(tagged) = lofty::read_from_path(path) {
        for tag in tagged.tags() {
            let pics = tag.pictures();
            let pic = pics
                .iter()
                .find(|p| p.pic_type() == PictureType::CoverFront)
                .or_else(|| pics.first());
            if let Some(p) = pic {
                let mime = p
                    .mime_type()
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_else(|| "image/jpeg".into());
                return Some((p.data().to_vec(), mime));
            }
        }
    }
    let dir = path.parent()?;
    for name in ["cover.jpg", "cover.png", "folder.jpg", "folder.png", "front.jpg", "album.jpg", "Cover.jpg", "Folder.jpg"] {
        let f = dir.join(name);
        if let Ok(bytes) = std::fs::read(&f) {
            let mime = if name.ends_with("png") { "image/png" } else { "image/jpeg" };
            return Some((bytes, mime.into()));
        }
    }
    None
}
