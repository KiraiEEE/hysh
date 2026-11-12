// Hysh - instant playback for web sources (the approach Metrolist / Mochy use on Android).
// yt-dlp only *resolves* the direct audio URL (cached until it expires); the media server then
// streams it in ranged chunks, so a song starts in about the time the resolve takes and seeking is
// immediate. YouTube's servers throttle open-ended requests to playback speed, so every upstream
// request carries an explicit `range=` parameter, like the Android clients do.
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::state::{anyhow_lite::{err, Result}, Shared};
use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CHUNK: u64 = 2 * 1024 * 1024; // per upstream request; small enough to start fast
const FALLBACK_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Debug)]
pub struct Direct {
    pub url: String,
    pub headers: HashMap<String, String>,
    pub size: Option<u64>,
    pub mime: String,
    expires: Instant,
}

/// Seconds until a googlevideo URL stops working ("expire=" parameter), with a safety margin.
fn ttl_of(url: &str) -> Duration {
    let expire = url
        .split(['?', '&'])
        .find_map(|kv| kv.strip_prefix("expire="))
        .and_then(|v| v.parse::<u64>().ok());
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    match expire {
        Some(t) if t > now + 300 => Duration::from_secs(t - now - 300),
        _ => FALLBACK_TTL,
    }
}

fn mime_of(ext: &str) -> &'static str {
    match ext {
        "webm" | "weba" => "audio/webm",
        "m4a" | "mp4" => "audio/mp4",
        "mp3" => "audio/mpeg",
        "ogg" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        _ => "application/octet-stream",
    }
}

/// Resolves (or reuses) the direct stream for a page. `None` = not streamable as a plain file
/// (e.g. HLS); the caller then falls back to the download cache.
pub async fn direct(s: &Shared, page: &str) -> Result<Option<Direct>> {
    if let Some(d) = s.direct_cache.lock().await.get(page) {
        if Instant::now() < d.expires {
            return Ok(Some(d.clone()));
        }
    }
    let json = crate::ytdlp::describe(s, page).await?;
    let v: Value = serde_json::from_str(&json)?;
    let proto = v.get("protocol").and_then(|p| p.as_str()).unwrap_or("");
    let url = v.get("url").and_then(|p| p.as_str()).unwrap_or("");
    if !(proto == "https" || proto == "http") || url.is_empty() {
        return Ok(None);
    }
    let headers = v
        .get("http_headers")
        .and_then(|h| h.as_object())
        .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect())
        .unwrap_or_default();
    let d = Direct {
        url: url.to_string(),
        headers,
        size: v.get("filesize").and_then(|x| x.as_u64()),
        mime: mime_of(v.get("ext").and_then(|e| e.as_str()).unwrap_or("")).to_string(),
        expires: Instant::now() + ttl_of(url),
    };
    let mut cache = s.direct_cache.lock().await;
    if cache.len() > 300 {
        cache.retain(|_, d| Instant::now() < d.expires);
    }
    cache.insert(page.to_string(), d.clone());
    Ok(Some(d))
}

pub async fn forget(s: &Shared, page: &str) {
    s.direct_cache.lock().await.remove(page);
}

/// "bytes=a-b" / "bytes=a-" -> (a, Some(b) | None)
fn parse_range(h: Option<&HeaderValue>) -> (u64, Option<u64>) {
    let Some(v) = h.and_then(|v| v.to_str().ok()) else { return (0, None) };
    let Some(spec) = v.strip_prefix("bytes=") else { return (0, None) };
    let (a, b) = spec.split_once('-').unwrap_or((spec, ""));
    (a.trim().parse().unwrap_or(0), b.trim().parse().ok())
}

/// Serves one browser range request from the direct URL.
pub async fn serve(s: &Shared, d: &Direct, req_headers: &HeaderMap) -> Result<Response> {
    let mut rb = s.http.get(&d.url).timeout(Duration::from_secs(30));
    for (k, v) in &d.headers {
        rb = rb.header(k.as_str(), v.as_str());
    }
    let (start, end_req) = parse_range(req_headers.get(header::RANGE));
    let Some(size) = d.size else {
        // size unknown: pass the browser's range through untouched
        if let Some(r) = req_headers.get(header::RANGE) {
            rb = rb.header(header::RANGE, r.clone());
        }
        let resp = rb.send().await?;
        if !resp.status().is_success() {
            return err(format!("upstream {}", resp.status()));
        }
        let mut out = Response::builder().status(resp.status().as_u16()).header(header::CONTENT_TYPE, d.mime.as_str());
        for h in [header::CONTENT_LENGTH, header::CONTENT_RANGE, header::ACCEPT_RANGES] {
            if let Some(v) = resp.headers().get(&h) {
                out = out.header(h, v.as_bytes());
            }
        }
        return Ok(out.body(Body::from_stream(resp.bytes_stream()))?);
    };
    if start >= size {
        return Ok((StatusCode::RANGE_NOT_SATISFIABLE, [(header::CONTENT_RANGE, format!("bytes */{size}"))]).into_response());
    }
    let end = end_req.unwrap_or(u64::MAX).min(start + CHUNK - 1).min(size - 1);
    let sep = if d.url.contains('?') { '&' } else { '?' };
    let resp = s.http.get(format!("{}{sep}range={start}-{end}", d.url)).headers({
        let mut h = reqwest::header::HeaderMap::new();
        for (k, v) in &d.headers {
            if let (Ok(k), Ok(v)) = (reqwest::header::HeaderName::from_bytes(k.as_bytes()), reqwest::header::HeaderValue::from_str(v)) {
                h.insert(k, v);
            }
        }
        h
    })
    .timeout(Duration::from_secs(30))
    .send()
    .await?;
    if !resp.status().is_success() {
        return err(format!("upstream {}", resp.status()));
    }
    Ok(Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, d.mime.as_str())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"))
        .header(header::CONTENT_LENGTH, (end - start + 1).to_string())
        .body(Body::from_stream(resp.bytes_stream()))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges() {
        assert_eq!(parse_range(Some(&HeaderValue::from_static("bytes=100-"))), (100, None));
        assert_eq!(parse_range(Some(&HeaderValue::from_static("bytes=5-9"))), (5, Some(9)));
        assert_eq!(parse_range(None), (0, None));
    }
    #[test]
    fn expiry_parsing() {
        assert_eq!(ttl_of("https://x/videoplayback?a=1"), FALLBACK_TTL);
        let soon = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() + 3600;
        let ttl = ttl_of(&format!("https://x/videoplayback?expire={soon}&b=2"));
        assert!(ttl.as_secs() > 3000 && ttl.as_secs() <= 3300);
    }
}
