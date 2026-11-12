// Hysh - "Connect Spotify": the official Authorization Code + PKCE flow.
// The user signs in on accounts.spotify.com in their own browser; Hysh only ever sees a
// short-lived access token and a refresh token. No client secret is needed with PKCE.
// Used to import Liked Songs and playlists.
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::state::{anyhow_lite::{err, Error, Result}, Shared};
use base64::Engine;
use rand::Rng;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Must match a Redirect URI registered in the user's Spotify app settings.
pub const REDIRECT_URI: &str = "http://127.0.0.1:43821/callback";
const LISTEN_ADDR: &str = "127.0.0.1:43821";
const SCOPES: &str = "user-library-read playlist-read-private playlist-read-collaborative";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(180);

fn random_string(len: usize) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut r = rand::thread_rng();
    (0..len).map(|_| CHARS[r.gen_range(0..CHARS.len())] as char).collect()
}

fn pkce_challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn client_id(s: &Shared) -> Result<String> {
    let id = s.setting_str("spotify_client_id");
    if id.is_empty() {
        return err("Add your Spotify Client ID in Settings › Sources first");
    }
    Ok(id)
}

/// Waits for Spotify to redirect the browser back to us and returns the query string.
async fn wait_for_redirect(listener: tokio::net::TcpListener) -> Result<String> {
    loop {
        let (mut sock, _) = listener.accept().await?;
        let mut buf = vec![0u8; 8192];
        let n = sock.read(&mut buf).await?;
        let req = String::from_utf8_lossy(&buf[..n]).to_string();
        let target = req.split_whitespace().nth(1).unwrap_or("").to_string();
        if !target.starts_with("/callback") {
            let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue; // e.g. the browser asking for /favicon.ico
        }
        let body = "<!doctype html><meta charset=utf-8><title>Hysh</title><body style=\"font:16px system-ui;background:#0f0f0e;color:#ecebe6;display:grid;place-items:center;height:90vh\"><div>Spotify is connected. You can close this tab and go back to Hysh.</div>";
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = sock.write_all(resp.as_bytes()).await;
        return Ok(target.split_once('?').map(|(_, q)| q.to_string()).unwrap_or_default());
    }
}

async fn token_request(s: &Shared, form: &[(&str, &str)]) -> Result<Value> {
    let r = s.http.post("https://accounts.spotify.com/api/token").form(form).send().await?;
    let status = r.status();
    let v: Value = r.json().await?;
    if !status.is_success() {
        let msg = v.get("error_description").or_else(|| v.get("error")).and_then(|e| e.as_str()).unwrap_or("token request failed");
        return err(format!("Spotify: {msg}"));
    }
    Ok(v)
}

async fn store_tokens(s: &Shared, v: &Value) -> Result<String> {
    let access = v.get("access_token").and_then(|t| t.as_str()).ok_or_else(|| Error("Spotify sent no access token".into()))?.to_string();
    let ttl = v.get("expires_in").and_then(|t| t.as_u64()).unwrap_or(3600);
    if let Some(refresh) = v.get("refresh_token").and_then(|t| t.as_str()) {
        s.set_setting("spotify_refresh", json!(refresh));
    }
    // refresh a minute early so a long import never runs on an expired token
    *s.spotify_token.lock().await = Some((access.clone(), Instant::now() + Duration::from_secs(ttl.saturating_sub(60))));
    Ok(access)
}

/// Opens the Spotify login in the user's browser and completes the PKCE exchange.
pub async fn connect(s: &Shared) -> Result<Value> {
    let cid = client_id(s)?;
    let verifier = random_string(96);
    let state = random_string(24);
    let listener = tokio::net::TcpListener::bind(LISTEN_ADDR)
        .await
        .map_err(|e| Error(format!("port 43821 is busy ({e}); close the other program using it and try again")))?;
    let url = reqwest::Url::parse_with_params(
        "https://accounts.spotify.com/authorize",
        &[
            ("client_id", cid.as_str()),
            ("response_type", "code"),
            ("redirect_uri", REDIRECT_URI),
            ("code_challenge_method", "S256"),
            ("code_challenge", &pkce_challenge(&verifier)),
            ("state", &state),
            ("scope", SCOPES),
        ],
    )?;
    std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url.as_str()]).spawn()?;

    let query = tokio::time::timeout(LOGIN_TIMEOUT, wait_for_redirect(listener))
        .await
        .map_err(|_| Error("Spotify login timed out".into()))??;
    let params: std::collections::HashMap<String, String> =
        reqwest::Url::parse(&format!("http://x/?{query}"))?.query_pairs().into_owned().collect();
    if params.get("state") != Some(&state) {
        return err("Spotify login was not started by Hysh (state mismatch)");
    }
    if let Some(e) = params.get("error") {
        return err(format!("Spotify: {e}"));
    }
    let code = params.get("code").ok_or_else(|| Error("Spotify sent no code".into()))?;
    let v = token_request(
        s,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", REDIRECT_URI),
            ("client_id", &cid),
            ("code_verifier", &verifier),
        ],
    )
    .await?;
    let access = store_tokens(s, &v).await?;
    let me: Value = s.http.get("https://api.spotify.com/v1/me").bearer_auth(&access).send().await?.json().await?;
    let name = me.get("display_name").and_then(|n| n.as_str()).or_else(|| me.get("id").and_then(|n| n.as_str())).unwrap_or("Spotify user");
    s.set_setting("spotify_user", json!(name));
    Ok(json!({ "user": name }))
}

/// A valid access token, refreshed when needed.
pub async fn access_token(s: &Shared) -> Result<String> {
    if let Some((tok, until)) = s.spotify_token.lock().await.clone() {
        if Instant::now() < until {
            return Ok(tok);
        }
    }
    let refresh = s.setting_str("spotify_refresh");
    if refresh.is_empty() {
        return err("Spotify is not connected (Settings › Sources › Connect Spotify)");
    }
    let cid = client_id(s)?;
    let v = token_request(s, &[("grant_type", "refresh_token"), ("refresh_token", &refresh), ("client_id", &cid)]).await?;
    store_tokens(s, &v).await
}

pub async fn disconnect(s: &Shared) {
    *s.spotify_token.lock().await = None;
    s.set_setting("spotify_refresh", Value::Null);
    s.set_setting("spotify_user", Value::Null);
}

#[cfg(test)]
mod tests {
    #[test]
    fn pkce_matches_rfc7636_example() {
        // RFC 7636 appendix B
        assert_eq!(super::pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }
}
