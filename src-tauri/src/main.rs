// Hysh - a lightweight all-in-one music player for Windows.
// Copyright (C) 2026 Hysh contributors. GPL-3.0-or-later.
// Built after studying Myspoti, BitChord, Mochy Music and Metrolist (all GPL-3.0).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod discord;
mod downloads;
mod library;
mod lyrics;
mod memory;
mod plugins;
mod scrobble;
mod server;
mod spotify;
mod state;
mod stream;
mod widget;
mod ytdlp;

use state::Shared;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::window::{Color, Effect, EffectsBuilder};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::StateFlags;

/// Windows 11 backdrop material chosen in Settings › Appearance ("none" keeps an opaque window).
fn material(name: &str) -> Option<Effect> {
    match name {
        "mica" => Some(Effect::Mica),
        "mica-alt" => Some(Effect::Tabbed),
        "acrylic" => Some(Effect::Acrylic),
        _ => None,
    }
}

fn main() {
    tauri::Builder::default()
        // a second launch focuses the running window instead of starting another copy
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .with_denylist(&[widget::LABEL]) // the widget places itself (floating or pinned)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let shared = Arc::new(Shared::new(app.path().app_data_dir()?).map_err(|e| e.0)?);
            // loopback media server on a random free port
            let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
            listener.set_nonblocking(true)?;
            shared.port.store(listener.local_addr()?.port(), Ordering::Relaxed);
            tauri::async_runtime::spawn(server::serve(listener, shared.clone()));
            // the window is built here (not in tauri.conf.json) so the rendering mode setting can
            // choose its WebView2 flags
            let args = memory::browser_args(&shared.setting_str("render_mode"));
            let backdrop = material(&shared.setting_str("window_material"));
            app.manage(shared);
            let mut window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Hysh")
                .inner_size(1320.0, 840.0)
                .min_inner_size(960.0, 620.0)
                .decorations(false)
                .center()
                .additional_browser_args(&args);
            window = match backdrop {
                // transparent window + native material; the page paints a translucent tint on top
                Some(effect) => window
                    .transparent(true)
                    .background_color(Color(0, 0, 0, 0))
                    .effects(EffectsBuilder::new().effect(effect).build()),
                None => window.background_color(Color(15, 15, 14, 255)),
            };
            window.build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // closing the main window quits Hysh, widget included
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
            memory::on_window_event(window, event);
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_env,
            commands::settings_get,
            commands::settings_set,
            commands::store_load,
            commands::store_save,
            commands::files_exist,
            commands::library_get,
            commands::library_scan,
            commands::http_request,
            commands::md5_hex,
            commands::lyrics_get,
            commands::lastfm_login,
            commands::scrobble_now,
            commands::scrobble_submit,
            commands::discord_update,
            commands::yt_status,
            commands::yt_install,
            commands::yt_search,
            commands::yt_extract,
            commands::yt_match,
            commands::web_warm,
            commands::download,
            commands::spotify_connect,
            commands::spotify_token,
            commands::spotify_disconnect,
            commands::read_text_file,
            commands::plugins_list,
            commands::widget_open,
            commands::widget_close,
            commands::write_text_file,
            commands::open_path,
            commands::open_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hysh");
}
