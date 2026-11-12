// Hysh - tiny loopback media server.
// Serves local files (with Range), embedded cover art, remote streams (proxied so Web Audio can
// process them: EQ, crossfade, visualizer) and the yt-dlp cache. Every route needs the
// per-launch secret token, so other programs on the machine cannot use it.
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::state::Shared;
use axum::body::Body;
use axum::extract::{Path as UrlPath, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use tower::ServiceExt;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeFile;

type S = State<Arc<Shared>>;

#[derive(Deserialize)]
struct Q {
    t: String,
    #[serde(default)]
    p: String,
    #[serde(default)]
    u: String,
}

fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, "bad token").into_response()
}

fn token_matches(s: &Shared, t: &str) -> bool {
    // constant-time-ish compare
    t.len() == s.token.len() && t.bytes().zip(s.token.bytes()).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0
}

fn ok_token(s: &Shared, q: &Q) -> bool {
    token_matches(s, &q.t)
}

/// Plugin files. The token is part of the path so a plugin's relative imports keep working.
async fn plugin_file(State(s): S, UrlPath((token, rest)): UrlPath<(String, String)>, req: Request) -> Response {
    if !token_matches(&s, &token) {
        return forbidden();
    }
    match crate::plugins::resolve_file(&s, &rest) {
        Some(path) => serve_path(path, req).await,
        None => (StatusCode::NOT_FOUND, "no such plugin file").into_response(),
    }
}

async fn serve_path(path: PathBuf, req: Request) -> Response {
    if !path.is_file() {
        return (StatusCode::NOT_FOUND, "no such file").into_response();
    }
    match ServeFile::new(path).oneshot(req).await {
        Ok(r) => r.map(Body::new).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn file(State(s): S, Query(q): Query<Q>, req: Request) -> Response {
    if !ok_token(&s, &q) {
        return forbidden();
    }
    let path = PathBuf::from(&q.p);
    if !crate::library::is_audio(&path) {
        return (StatusCode::FORBIDDEN, "not an audio file").into_response();
    }
    serve_path(path, req).await
}

async fn cover(State(s): S, Query(q): Query<Q>) -> Response {
    if !ok_token(&s, &q) {
        return forbidden();
    }
    let path = PathBuf::from(&q.p);
    let res = tokio::task::spawn_blocking(move || crate::library::cover_for(&path)).await.ok().flatten();
    match res {
        Some((bytes, mime)) => (
            [
                (header::CONTENT_TYPE, mime),
                (header::CACHE_CONTROL, "max-age=86400".to_string()),
            ],
            bytes,
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "no cover").into_response(),
    }
}

async fn proxy(State(s): S, Query(q): Query<Q>, headers: HeaderMap) -> Response {
    if !ok_token(&s, &q) {
        return forbidden();
    }
    if !(q.u.starts_with("http://") || q.u.starts_with("https://")) {
        return (StatusCode::BAD_REQUEST, "bad url").into_response();
    }
    let mut rb = s.http.get(&q.u);
    if let Some(r) = headers.get(header::RANGE) {
        rb = rb.header(header::RANGE, r.clone());
    }
    let resp = match rb.send().await {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_GATEWAY, e.to_string()).into_response(),
    };
    let mut out = Response::builder().status(resp.status().as_u16());
    for h in [header::CONTENT_TYPE, header::CONTENT_LENGTH, header::CONTENT_RANGE, header::ACCEPT_RANGES, header::CACHE_CONTROL] {
        if let Some(v) = resp.headers().get(&h) {
            if let Ok(v) = HeaderValue::from_bytes(v.as_bytes()) {
                out = out.header(h, v);
            }
        }
    }
    out.body(Body::from_stream(resp.bytes_stream()))
        .unwrap_or_else(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())
}

/// Songs from web pages (YouTube, SoundCloud, Bandcamp...).
/// 1. a copy cached on disk, 2. instant ranged streaming from the direct URL,
/// 3. for formats that cannot be streamed as a file (HLS), download into the cache first.
async fn web(State(s): S, Query(q): Query<Q>, req: Request) -> Response {
    if !ok_token(&s, &q) {
        return forbidden();
    }
    if let Some(path) = crate::ytdlp::cached_file(&s, &q.u) {
        return serve_path(path, req).await;
    }
    let headers = req.headers().clone();
    for attempt in 0..2 {
        match crate::stream::direct(&s, &q.u).await {
            Ok(Some(d)) => match crate::stream::serve(&s, &d, &headers).await {
                Ok(resp) => return resp,
                // the link expired or was refused: resolve a fresh one once
                Err(_) if attempt == 0 => crate::stream::forget(&s, &q.u).await,
                Err(_) => break,
            },
            _ => break,
        }
    }
    match crate::ytdlp::fetch(&s, &q.u).await {
        Ok(path) => serve_path(path, req).await,
        Err(e) => (StatusCode::BAD_GATEWAY, e.0).into_response(),
    }
}

pub async fn serve(listener: std::net::TcpListener, shared: Arc<Shared>) {
    let app = Router::new()
        .route("/file", get(file))
        .route("/cover", get(cover))
        .route("/proxy", get(proxy))
        .route("/web", get(web))
        .route("/p/{token}/{*rest}", get(plugin_file))
        .layer(CorsLayer::permissive())
        .with_state(shared);
    match tokio::net::TcpListener::from_std(listener) {
        Ok(l) => {
            if let Err(e) = axum::serve(l, app).await {
                eprintln!("media server stopped: {e}");
            }
        }
        Err(e) => eprintln!("media server failed to start: {e}"),
    }
}
