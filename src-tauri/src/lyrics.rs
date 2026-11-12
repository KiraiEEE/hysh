// Hysh - multi-provider lyrics
// Providers (as used by Mochy, BitChord, Metrolist and Myspoti):
//   LyricsPlus / YouLyPlus (word-synced), LRCLIB, KuGou, NetEase, SimpMusic.
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::state::Shared;
use base64::Engine;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Word {
    pub t: u64,
    pub d: u64,
    pub text: String,
    #[serde(default)]
    pub bg: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Line {
    pub t: u64,
    pub d: u64,
    pub text: String,
    #[serde(default)]
    pub words: Vec<Word>,
    #[serde(default)]
    pub singer: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Lyrics {
    pub provider: String,
    /// 0 = plain text, 1 = line-synced, 2 = word-synced
    pub level: u8,
    pub lines: Vec<Line>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Query {
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub video_id: Option<String>,
    /// force one provider (for the "try another source" button)
    #[serde(default)]
    pub provider: Option<String>,
}

pub const PROVIDERS: &[&str] = &["lyricsplus", "lrclib", "kugou", "netease", "simpmusic"];

fn re(pat: &'static str, cell: &'static OnceLock<Regex>) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).unwrap())
}

/// Strips "(feat. X)", "- Remastered 2011", "[Official Video]" and friends for better matches.
pub fn clean_title(s: &str) -> String {
    static R1: OnceLock<Regex> = OnceLock::new();
    static R2: OnceLock<Regex> = OnceLock::new();
    let a = re(
        r"(?i)\s*[\(\[](feat\.?|ft\.?|with|official|lyric|lyrics|audio|video|music video|visualizer|remaster|remastered|explicit|clean|hd|hq|4k)[^\)\]]*[\)\]]",
        &R1,
    )
    .replace_all(s, "");
    let b = re(r"(?i)\s+-\s+(\d{4}\s+)?remaster(ed)?.*$|\s+-\s+single version$|\s+-\s+radio edit$", &R2).replace_all(&a, "");
    b.trim().to_string()
}

pub fn clean_artist(s: &str) -> String {
    // first credited artist only: "A, B & C" -> "A"
    let first = s
        .split([',', '&', ';', '/'])
        .next()
        .unwrap_or(s)
        .split(" feat")
        .next()
        .unwrap_or(s)
        .split(" x ")
        .next()
        .unwrap_or(s);
    first.trim().trim_end_matches(" - Topic").to_string()
}

fn parse_ts(min: &str, sec: &str, frac: Option<&str>) -> u64 {
    let m: u64 = min.parse().unwrap_or(0);
    let s: u64 = sec.parse().unwrap_or(0);
    let f = frac
        .map(|f| {
            let v: u64 = f.parse().unwrap_or(0);
            match f.len() {
                1 => v * 100,
                2 => v * 10,
                _ => v / 10u64.pow(f.len() as u32 - 3),
            }
        })
        .unwrap_or(0);
    m * 60_000 + s * 1000 + f
}

/// LRC parser, with the "enhanced LRC" <mm:ss.xx>word extension for word timing.
pub fn parse_lrc(lrc: &str, provider: &str) -> Option<Lyrics> {
    static LINE: OnceLock<Regex> = OnceLock::new();
    static WORD: OnceLock<Regex> = OnceLock::new();
    static TAG: OnceLock<Regex> = OnceLock::new();
    let line_re = re(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]", &LINE);
    let word_re = re(r"<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>", &WORD);
    let tag_re = re(r"^\[[a-zA-Z]+:.*\]$", &TAG);
    let mut lines: Vec<Line> = Vec::new();
    let mut any_words = false;
    for raw in lrc.lines() {
        let raw = raw.trim();
        if raw.is_empty() || tag_re.is_match(raw) {
            continue;
        }
        let stamps: Vec<u64> = line_re
            .captures_iter(raw)
            .map(|c| parse_ts(&c[1], &c[2], c.get(3).map(|m| m.as_str())))
            .collect();
        if stamps.is_empty() {
            continue;
        }
        let body = line_re.replace_all(raw, "").to_string();
        // word timing
        let mut words = Vec::new();
        if word_re.is_match(&body) {
            let mut last: Option<(u64, usize)> = None;
            let mut segs: Vec<(u64, String)> = Vec::new();
            for c in word_re.captures_iter(&body) {
                let m = c.get(0).unwrap();
                let t = parse_ts(&c[1], &c[2], c.get(3).map(|m| m.as_str()));
                if let Some((lt, start)) = last {
                    segs.push((lt, body[start..m.start()].to_string()));
                }
                last = Some((t, m.end()));
            }
            if let Some((lt, start)) = last {
                segs.push((lt, body[start..].to_string()));
            }
            for i in 0..segs.len() {
                let (t, ref text) = segs[i];
                if text.is_empty() {
                    continue;
                }
                let next = segs.get(i + 1).map(|s| s.0).unwrap_or(t + 400);
                words.push(Word { t, d: next.saturating_sub(t), text: text.clone(), bg: false });
            }
            any_words |= !words.is_empty();
        }
        let text = word_re.replace_all(&body, "").trim().to_string();
        for t in stamps {
            lines.push(Line { t, d: 0, text: text.clone(), words: words.clone(), singer: None });
        }
    }
    if lines.is_empty() {
        return None;
    }
    lines.sort_by_key(|l| l.t);
    for i in 0..lines.len() {
        let next = lines.get(i + 1).map(|l| l.t).unwrap_or(lines[i].t + 5000);
        lines[i].d = next.saturating_sub(lines[i].t);
    }
    Some(Lyrics { provider: provider.into(), level: if any_words { 2 } else { 1 }, lines })
}

pub fn plain(text: &str, provider: &str) -> Option<Lyrics> {
    let lines: Vec<Line> = text
        .lines()
        .map(|l| Line { text: l.trim().to_string(), ..Default::default() })
        .collect();
    if lines.iter().all(|l| l.text.is_empty()) {
        return None;
    }
    Some(Lyrics { provider: provider.into(), level: 0, lines })
}

async fn get_json(s: &Shared, url: &str, query: &[(&str, String)], timeout: u64) -> Option<Value> {
    let mut req = s.http.get(url).query(query).timeout(Duration::from_secs(timeout));
    if url.contains("163.com") {
        req = req.header("Referer", "https://music.163.com/");
    }
    let r = req.send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    r.json::<Value>().await.ok()
}

// ---------- LyricsPlus (word-level, Apple-Music-like) ----------
async fn lyricsplus(s: &Shared, q: &Query) -> Option<Lyrics> {
    let servers = ["https://lyricsplus.prjktla.my.id", "https://lyricsplus.binimum.org"];
    let params = vec![
        ("title", clean_title(&q.title)),
        ("artist", clean_artist(&q.artist)),
        ("album", q.album.clone()),
        ("duration", format!("{}", q.duration.round() as i64)),
    ];
    for server in servers {
        let Some(v) = get_json(s, &format!("{server}/v2/lyrics/get"), &params, 8).await else { continue };
        if let Some(items) = v.get("lyrics").and_then(|l| l.as_array()) {
            let mut lines = Vec::new();
            let mut word_level = false;
            for it in items {
                let t = it.get("time").and_then(|x| x.as_u64()).unwrap_or(0);
                let d = it.get("duration").and_then(|x| x.as_u64()).unwrap_or(0);
                let mut words = Vec::new();
                if let Some(syl) = it.get("syllabus").and_then(|x| x.as_array()) {
                    for w in syl {
                        words.push(Word {
                            t: w.get("time").and_then(|x| x.as_u64()).unwrap_or(t),
                            d: w.get("duration").and_then(|x| x.as_u64()).unwrap_or(0),
                            text: w.get("text").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                            bg: w.get("isBackground").and_then(|x| x.as_bool()).unwrap_or(false),
                        });
                    }
                }
                word_level |= !words.is_empty();
                let mut text = it.get("text").and_then(|x| x.as_str()).unwrap_or("").to_string();
                if text.is_empty() && !words.is_empty() {
                    text = words.iter().filter(|w| !w.bg).map(|w| w.text.as_str()).collect::<String>();
                }
                let singer = it
                    .get("element")
                    .and_then(|e| e.get("singer"))
                    .and_then(|x| x.as_str())
                    .map(String::from);
                lines.push(Line { t, d, text: text.trim().to_string(), words, singer });
            }
            if !lines.is_empty() {
                let line_synced = v.get("type").and_then(|x| x.as_str()) != Some("None");
                return Some(Lyrics {
                    provider: "LyricsPlus".into(),
                    level: if word_level { 2 } else if line_synced { 1 } else { 0 },
                    lines,
                });
            }
        }
        if let Some(l) = v.get("syncedLyrics").and_then(|x| x.as_str()).and_then(|x| parse_lrc(x, "LyricsPlus")) {
            return Some(l);
        }
    }
    None
}

// ---------- LRCLIB ----------
async fn lrclib(s: &Shared, q: &Query) -> Option<Lyrics> {
    let title = clean_title(&q.title);
    let artist = clean_artist(&q.artist);
    let mut params = vec![("track_name", title.clone()), ("artist_name", artist.clone())];
    if !q.album.is_empty() {
        params.push(("album_name", q.album.clone()));
    }
    if q.duration > 0.0 {
        params.push(("duration", format!("{}", q.duration.round() as i64)));
    }
    let mut hit = get_json(s, "https://lrclib.net/api/get", &params, 8).await;
    if hit.is_none() {
        let list = get_json(
            s,
            "https://lrclib.net/api/search",
            &[("track_name", title), ("artist_name", artist)],
            8,
        )
        .await?;
        let arr = list.as_array()?;
        hit = arr
            .iter()
            .filter(|x| x.get("syncedLyrics").map(|v| v.is_string()).unwrap_or(false) || x.get("plainLyrics").map(|v| v.is_string()).unwrap_or(false))
            .min_by_key(|x| {
                let d = x.get("duration").and_then(|d| d.as_f64()).unwrap_or(0.0);
                let synced_bonus = if x.get("syncedLyrics").map(|v| v.is_string()).unwrap_or(false) { 0 } else { 1000 };
                ((d - q.duration).abs() * 10.0) as i64 + synced_bonus
            })
            .cloned();
    }
    let v = hit?;
    if let Some(l) = v.get("syncedLyrics").and_then(|x| x.as_str()).and_then(|x| parse_lrc(x, "LRCLIB")) {
        return Some(l);
    }
    v.get("plainLyrics").and_then(|x| x.as_str()).and_then(|x| plain(x, "LRCLIB"))
}

// ---------- KuGou ----------
async fn kugou(s: &Shared, q: &Query) -> Option<Lyrics> {
    let keyword = format!("{} - {}", clean_title(&q.title), clean_artist(&q.artist));
    let dur = q.duration.round() as i64;
    let mut candidate: Option<Value> = None;
    if let Some(songs) = get_json(
        s,
        "https://mobileservice.kugou.com/api/v3/search/song",
        &[("version", "9108".into()), ("plat", "0".into()), ("pagesize", "8".into()), ("showtype", "0".into()), ("keyword", keyword.clone())],
        8,
    )
    .await
    {
        if let Some(info) = songs.pointer("/data/info").and_then(|x| x.as_array()) {
            for song in info {
                let sd = song.get("duration").and_then(|x| x.as_i64()).unwrap_or(-1);
                if dur > 0 && (sd - dur).abs() > 8 {
                    continue;
                }
                let Some(hash) = song.get("hash").and_then(|x| x.as_str()) else { continue };
                if let Some(r) = get_json(
                    s,
                    "https://lyrics.kugou.com/search",
                    &[("ver", "1".into()), ("man", "yes".into()), ("client", "pc".into()), ("hash", hash.into())],
                    8,
                )
                .await
                {
                    if let Some(c) = r.pointer("/candidates/0") {
                        candidate = Some(c.clone());
                        break;
                    }
                }
            }
        }
    }
    if candidate.is_none() {
        let mut p = vec![("ver", "1".to_string()), ("man", "yes".into()), ("client", "pc".into()), ("keyword", keyword)];
        if dur > 0 {
            p.push(("duration", (dur * 1000).to_string()));
        }
        candidate = get_json(s, "https://lyrics.kugou.com/search", &p, 8)
            .await
            .and_then(|r| r.pointer("/candidates/0").cloned());
    }
    let c = candidate?;
    let id = c.get("id").map(|v| v.to_string().trim_matches('"').to_string())?;
    let key = c.get("accesskey").and_then(|x| x.as_str())?.to_string();
    let d = get_json(
        s,
        "https://lyrics.kugou.com/download",
        &[("fmt", "lrc".into()), ("charset", "utf8".into()), ("client", "pc".into()), ("ver", "1".into()), ("id", id), ("accesskey", key)],
        8,
    )
    .await?;
    let b64 = d.get("content").and_then(|x| x.as_str())?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    // KuGou pads lyrics with credit lines ("作词 : ...", "Arranged by：...") - drop them
    static CREDIT: OnceLock<Regex> = OnceLock::new();
    let credit = re(
        r"(?i)^\s*(arranged|arrangement|produced|producer|written|writer|composed|composer|lyrics|lyricist|music|mixed|mixing|mastered|mastering|recorded|vocals?|engineer|publisher|op|sp)\b[^:：]{0,20}[:：]",
        &CREDIT,
    );
    let filtered: String = text
        .lines()
        .filter(|l| {
            let body = l.split(']').last().unwrap_or("");
            !(body.contains("作词") || body.contains("作曲") || body.contains("编曲") || body.contains("制作") || body.contains("Kugou") || body.contains("酷狗") || credit.is_match(body))
        })
        .collect::<Vec<_>>()
        .join("\n");
    parse_lrc(&filtered, "KuGou")
}

// ---------- NetEase Cloud Music ----------
async fn netease(s: &Shared, q: &Query) -> Option<Lyrics> {
    let term = format!("{} {}", clean_title(&q.title), clean_artist(&q.artist));
    let res = get_json(
        s,
        "https://music.163.com/api/search/get",
        &[("s", term), ("type", "1".into()), ("limit", "6".into())],
        8,
    )
    .await?;
    let songs = res.pointer("/result/songs")?.as_array()?;
    let dur_ms = (q.duration * 1000.0) as i64;
    let song = songs
        .iter()
        .min_by_key(|x| {
            let d = x.get("duration").and_then(|d| d.as_i64()).unwrap_or(0);
            if dur_ms > 0 { (d - dur_ms).abs() } else { 0 }
        })?;
    if dur_ms > 0 {
        let d = song.get("duration").and_then(|d| d.as_i64()).unwrap_or(0);
        if (d - dur_ms).abs() > 8000 {
            return None;
        }
    }
    let id = song.get("id")?.as_i64()?;
    let l = get_json(
        s,
        "https://music.163.com/api/song/lyric",
        &[("id", id.to_string()), ("lv", "1".into()), ("kv", "1".into()), ("tv", "-1".into())],
        8,
    )
    .await?;
    let lrc = l.pointer("/lrc/lyric")?.as_str()?;
    parse_lrc(lrc, "NetEase")
}

// ---------- SimpMusic (keyed by YouTube video id) ----------
async fn simpmusic(s: &Shared, q: &Query) -> Option<Lyrics> {
    let vid = q.video_id.as_ref()?;
    let v = get_json(s, &format!("https://api-lyrics.simpmusic.org/v1/{vid}"), &[], 8).await?;
    let first = v.get("data")?.as_array()?.first()?.clone();
    for key in ["richSyncLyrics", "syncedLyrics"] {
        if let Some(l) = first.get(key).and_then(|x| x.as_str()).and_then(|x| parse_lrc(x, "SimpMusic")) {
            return Some(l);
        }
    }
    first.get("plainLyric").and_then(|x| x.as_str()).and_then(|x| plain(x, "SimpMusic"))
}

async fn run_provider(s: &Shared, name: &str, q: &Query) -> Option<Lyrics> {
    let fut = async {
        match name {
            "lyricsplus" => lyricsplus(s, q).await,
            "lrclib" => lrclib(s, q).await,
            "kugou" => kugou(s, q).await,
            "netease" => netease(s, q).await,
            "simpmusic" => simpmusic(s, q).await,
            _ => None,
        }
    };
    tokio::time::timeout(Duration::from_secs(12), fut).await.ok().flatten()
}

fn cache_key(q: &Query) -> String {
    let raw = format!("{}|{}|{}", q.title.to_lowercase(), q.artist.to_lowercase(), q.duration.round() as i64);
    format!("{:x}", md5::compute(raw))
}

/// Races the fast providers, keeps the richest result (word > line > plain).
pub async fn get(s: &Shared, q: Query) -> Option<Lyrics> {
    if let Some(p) = &q.provider {
        return run_provider(s, p, &q).await;
    }
    let path = s.data_dir.join("lyrics").join(format!("{}.json", cache_key(&q)));
    if let Some(v) = crate::state::read_json(&path) {
        if let Ok(l) = serde_json::from_value::<Lyrics>(v) {
            return Some(l);
        }
    }
    // first wave runs in parallel; a word-synced answer wins immediately
    let mut best: Option<Lyrics> = None;
    {
        use futures_util::stream::{FuturesUnordered, StreamExt};
        let mut wave: FuturesUnordered<_> = ["lyricsplus", "lrclib", "simpmusic"]
            .into_iter()
            .map(|p| run_provider(s, p, &q))
            .collect();
        while let Some(res) = wave.next().await {
            if let Some(cand) = res {
                if best.as_ref().map(|x| cand.level > x.level).unwrap_or(true) {
                    best = Some(cand);
                }
                if best.as_ref().map(|b| b.level == 2).unwrap_or(false) {
                    break;
                }
            }
        }
    }
    if best.as_ref().map(|b| b.level < 1).unwrap_or(true) {
        let (k, n) = tokio::join!(run_provider(s, "kugou", &q), run_provider(s, "netease", &q));
        for cand in [k, n].into_iter().flatten() {
            if best.as_ref().map(|x| cand.level > x.level).unwrap_or(true) {
                best = Some(cand);
            }
        }
    }
    if let Some(l) = &best {
        if let Ok(v) = serde_json::to_value(l) {
            let _ = crate::state::write_json(&path, &v);
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lrc_basic_and_enhanced() {
        let l = parse_lrc("[ar:x]\n[00:01.50]hello\n[00:03.00]<00:03.00>wor<00:03.40>ld\n", "t").unwrap();
        assert_eq!(l.lines.len(), 2);
        assert_eq!(l.lines[0].t, 1500);
        assert_eq!(l.level, 2);
        assert_eq!(l.lines[1].words.len(), 2);
        assert_eq!(l.lines[1].text, "world");
    }
    #[test]
    fn credit_regex() {
        static C: OnceLock<Regex> = OnceLock::new();
        let r = re(r"(?i)^\s*(arranged|produced|written|composed|lyrics)\b[^:：]{0,20}[:：]", &C);
        assert!(r.is_match("Arranged by：Paul Epworth"));
        assert!(r.is_match("Lyrics by: X"));
        assert!(!r.is_match("Let the sky fall"));
    }
    #[test]
    fn titles() {
        assert_eq!(clean_title("Song (feat. X) - Remastered 2011"), "Song");
        assert_eq!(clean_title("Song [Official Video]"), "Song");
        assert_eq!(clean_artist("A, B & C"), "A");
    }
}
