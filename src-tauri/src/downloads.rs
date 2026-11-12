// Hysh - downloads: fetch audio into the download folder and embed tags + cover art.
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::state::{anyhow_lite::{err, Result}, Shared};
use futures_util::StreamExt;
use lofty::config::WriteOptions;
use lofty::file::TaggedFileExt;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::tag::Tag;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct Meta {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub year: u32,
    pub track_no: u32,
    /// cover image URL (http/https) to embed
    pub cover: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Request {
    /// "page:<url>" (YouTube, SoundCloud... through yt-dlp) or a direct http(s) audio URL
    pub src: String,
    pub meta: Meta,
    /// "m4a" (default, taggable) or "best"
    #[serde(default)]
    pub format: String,
    /// extension to use for http downloads when the URL has none
    #[serde(default)]
    pub ext: String,
}

/// Windows-safe file name.
pub fn safe_name(name: &str) -> String {
    let n: String = name
        .chars()
        .map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let n = n.trim().trim_end_matches('.').chars().take(150).collect::<String>();
    if n.is_empty() { "track".into() } else { n }
}

fn ext_from_url(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next()?;
    let ext = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    crate::library::AUDIO_EXT.contains(&ext.as_str()).then_some(ext)
}

/// An already-downloaded file for this stem, whatever its extension.
fn existing(dir: &Path, stem: &str) -> Option<PathBuf> {
    crate::library::AUDIO_EXT
        .iter()
        .map(|e| dir.join(format!("{stem}.{e}")))
        .find(|p| p.is_file())
}

async fn fetch_http(s: &Shared, url: &str, dest: &Path) -> Result<()> {
    let resp = s.http.get(url).send().await?.error_for_status()?;
    let tmp = dest.with_extension("part");
    let mut f = tokio::fs::File::create(&tmp).await?;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        f.write_all(&chunk?).await?;
    }
    f.flush().await?;
    drop(f);
    tokio::fs::rename(&tmp, dest).await?;
    Ok(())
}

async fn fetch_cover(s: &Shared, url: &str) -> Option<(Vec<u8>, MimeType)> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return None;
    }
    let r = s.http.get(url).send().await.ok()?.error_for_status().ok()?;
    let mime = match r.headers().get("content-type").and_then(|v| v.to_str().ok()) {
        Some(m) if m.contains("png") => MimeType::Png,
        _ => MimeType::Jpeg,
    };
    let bytes = r.bytes().await.ok()?;
    (bytes.len() > 512).then(|| (bytes.to_vec(), mime))
}

/// Writes title / artist / album / year / track and the front cover. Formats lofty cannot
/// write (WebM) are left untouched; the file still plays and is named "Artist - Title".
pub fn write_tags(path: &Path, meta: &Meta, cover: Option<(Vec<u8>, MimeType)>) -> Result<()> {
    let mut tagged = lofty::read_from_path(path)?;
    let tag_type = tagged.primary_tag_type();
    if tagged.tag(tag_type).is_none() {
        tagged.insert_tag(Tag::new(tag_type));
    }
    let Some(tag) = tagged.tag_mut(tag_type) else { return err("could not create a tag") };
    if !meta.title.is_empty() {
        tag.set_title(meta.title.clone());
    }
    if !meta.artist.is_empty() {
        tag.set_artist(meta.artist.clone());
    }
    if !meta.album.is_empty() {
        tag.set_album(meta.album.clone());
    }
    if meta.year > 0 {
        tag.set_year(meta.year);
    }
    if meta.track_no > 0 {
        tag.set_track(meta.track_no);
    }
    if let Some((bytes, mime)) = cover {
        tag.remove_picture_type(PictureType::CoverFront);
        tag.push_picture(Picture::new_unchecked(PictureType::CoverFront, Some(mime), None, bytes));
    }
    tag.save_to_path(path, WriteOptions::default())?;
    Ok(())
}

pub async fn download(s: &Shared, req: Request) -> Result<PathBuf> {
    let dir = s.download_dir();
    let artist = req.meta.artist.split(',').next().unwrap_or("").trim();
    let stem = safe_name(&if artist.is_empty() { req.meta.title.clone() } else { format!("{artist} - {}", req.meta.title) });
    if let Some(p) = existing(&dir, &stem) {
        return Ok(p);
    }
    let path = if let Some(page) = req.src.strip_prefix("page:") {
        crate::ytdlp::download_to(s, page, &dir, &stem, req.format != "best").await?
    } else if req.src.starts_with("https://") || req.src.starts_with("http://") {
        let ext = ext_from_url(&req.src).unwrap_or_else(|| if req.ext.is_empty() { "mp3".into() } else { req.ext.clone() });
        let dest = dir.join(format!("{stem}.{ext}"));
        fetch_http(s, &req.src, &dest).await?;
        dest
    } else {
        return err("unsupported download source");
    };
    let cover = fetch_cover(s, &req.meta.cover).await;
    let (p2, meta) = (path.clone(), req.meta.clone());
    match tokio::task::spawn_blocking(move || write_tags(&p2, &meta, cover)).await {
        Ok(Err(e)) => eprintln!("tagging skipped for {}: {}", path.display(), e.0),
        Err(e) => eprintln!("tagging task failed: {e}"),
        Ok(Ok(())) => {}
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_are_windows_safe() {
        assert_eq!(safe_name("AC/DC: Back in Black?"), "AC_DC_ Back in Black_");
        assert_eq!(safe_name("  ..."), "track");
    }
    #[test]
    fn url_extensions() {
        assert_eq!(ext_from_url("https://x/y/song.FLAC?sig=1").as_deref(), Some("flac"));
        assert_eq!(ext_from_url("https://x/stream?id=3"), None);
    }
}
