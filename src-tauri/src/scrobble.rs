// Hysh - Last.fm and ListenBrainz scrobbling
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::state::{anyhow_lite::{err, Result}, Shared};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

const LASTFM: &str = "https://ws.audioscrobbler.com/2.0/";

#[derive(Deserialize, Debug, Clone)]
pub struct ScrobbleTrack {
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub duration: f64,
}

fn sign(params: &BTreeMap<String, String>, secret: &str) -> String {
    let mut s = String::new();
    for (k, v) in params {
        if k != "format" && k != "callback" {
            s.push_str(k);
            s.push_str(v);
        }
    }
    s.push_str(secret);
    format!("{:x}", md5::compute(s))
}

async fn lastfm_call(s: &Shared, mut params: BTreeMap<String, String>) -> Result<Value> {
    let key = s.setting_str("lastfm_api_key");
    let secret = s.setting_str("lastfm_secret");
    if key.is_empty() || secret.is_empty() {
        return err("Last.fm API key and secret are not set");
    }
    params.insert("api_key".into(), key);
    let sig = sign(&params, &secret);
    params.insert("api_sig".into(), sig);
    params.insert("format".into(), "json".into());
    let v: Value = s.http.post(LASTFM).form(&params).send().await?.json().await?;
    if let Some(e) = v.get("message").and_then(|m| m.as_str()) {
        if v.get("error").is_some() {
            return err(format!("Last.fm: {e}"));
        }
    }
    Ok(v)
}

/// Exchanges username + password for a session key once; only the key is stored.
pub async fn lastfm_login(s: &Shared, user: &str, pass: &str) -> Result<String> {
    let mut p = BTreeMap::new();
    p.insert("method".into(), "auth.getMobileSession".into());
    p.insert("username".into(), user.into());
    p.insert("password".into(), pass.into());
    let v = lastfm_call(s, p).await?;
    let key = v.pointer("/session/key").and_then(|k| k.as_str()).ok_or_else(|| crate::state::anyhow_lite::Error("no session key".into()))?;
    let name = v.pointer("/session/name").and_then(|k| k.as_str()).unwrap_or(user).to_string();
    s.set_setting("lastfm_session", json!(key));
    s.set_setting("lastfm_user", json!(name));
    Ok(name)
}

fn track_params(method: &str, t: &ScrobbleTrack, sk: &str) -> BTreeMap<String, String> {
    let mut p = BTreeMap::new();
    p.insert("method".into(), method.into());
    p.insert("artist".into(), t.artist.clone());
    p.insert("track".into(), t.title.clone());
    if !t.album.is_empty() {
        p.insert("album".into(), t.album.clone());
    }
    if t.duration > 0.0 {
        p.insert("duration".into(), (t.duration.round() as i64).to_string());
    }
    p.insert("sk".into(), sk.into());
    p
}

async fn listenbrainz(s: &Shared, kind: &str, t: &ScrobbleTrack, ts: Option<u64>) -> Result<()> {
    let token = s.setting_str("listenbrainz_token");
    if token.is_empty() {
        return Ok(());
    }
    let mut listen = json!({
        "track_metadata": {
            "artist_name": t.artist,
            "track_name": t.title,
            "additional_info": {
                "media_player": "Hysh",
                "submission_client": "Hysh",
                "submission_client_version": env!("CARGO_PKG_VERSION"),
                "duration_ms": (t.duration * 1000.0) as u64,
            }
        }
    });
    if !t.album.is_empty() {
        listen["track_metadata"]["release_name"] = json!(t.album);
    }
    if let Some(ts) = ts {
        listen["listened_at"] = json!(ts);
    }
    let r = s
        .http
        .post("https://api.listenbrainz.org/1/submit-listens")
        .header("Authorization", format!("Token {token}"))
        .json(&json!({ "listen_type": kind, "payload": [listen] }))
        .send()
        .await?;
    if !r.status().is_success() {
        return err(format!("ListenBrainz: HTTP {}", r.status()));
    }
    Ok(())
}

pub async fn now_playing(s: &Shared, t: ScrobbleTrack) -> Result<()> {
    let sk = s.setting_str("lastfm_session");
    let lf = async {
        if !sk.is_empty() {
            lastfm_call(s, track_params("track.updateNowPlaying", &t, &sk)).await.map(|_| ())
        } else {
            Ok(())
        }
    };
    let (a, b) = tokio::join!(lf, listenbrainz(s, "playing_now", &t, None));
    a.and(b)
}

pub async fn scrobble(s: &Shared, t: ScrobbleTrack, ts: u64) -> Result<()> {
    let sk = s.setting_str("lastfm_session");
    let lf = async {
        if !sk.is_empty() {
            let mut p = track_params("track.scrobble", &t, &sk);
            p.insert("timestamp".into(), ts.to_string());
            lastfm_call(s, p).await.map(|_| ())
        } else {
            Ok(())
        }
    };
    let (a, b) = tokio::join!(lf, listenbrainz(s, "single", &t, Some(ts)));
    a.and(b)
}

#[cfg(test)]
mod tests {
    #[test]
    fn signature_is_sorted_and_skips_format() {
        let mut p = std::collections::BTreeMap::new();
        p.insert("b".to_string(), "2".to_string());
        p.insert("a".to_string(), "1".to_string());
        p.insert("format".to_string(), "json".to_string());
        assert_eq!(super::sign(&p, "s"), format!("{:x}", md5::compute("a1b2s")));
    }
}
