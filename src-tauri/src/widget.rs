// Hysh - the floating / pinned player widget: a second, tiny, frameless window.
// It shares the main window's WebView2 environment (same browser arguments), so it costs one
// small renderer process. The main window owns all state; the widget only renders and sends commands.
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::state::Shared;
use serde_json::Value;
use tauri::window::Color;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "widget";

pub fn open(app: &AppHandle, s: &Shared) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(LABEL) {
        w.show()?;
        return Ok(());
    }
    let on_top = !matches!(s.setting("widget_on_top"), Value::Bool(false));
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("widget.html".into()))
        .title("Hysh widget")
        .inner_size(340.0, 132.0)
        .decorations(false)
        .transparent(true)
        .background_color(Color(0, 0, 0, 0))
        .shadow(false) // the card draws its own soft shadow inside the transparent window
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(on_top)
        .focused(false)
        .visible(false) // the page positions itself first, then shows: no jump on open
        .additional_browser_args(&crate::memory::browser_args(&s.setting_str("render_mode")))
        .build()?;
    Ok(())
}

pub fn close(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
}
