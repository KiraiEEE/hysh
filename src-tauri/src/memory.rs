// Hysh - keep the footprint small.
// * WebView2 flags: CPU rasterisation + GPU compositing by default ("balanced", about 60 MB less
//   than Chromium's default), or no GPU at all ("ultralight", smallest memory).
// * When minimized the WebView is marked invisible (Chromium throttles it) and asked to drop
//   caches (MemoryUsageTargetLevel = Low). Audio keeps playing.
// SPDX-License-Identifier: GPL-3.0-or-later

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, Runtime, Window, WindowEvent};

static LOW: AtomicBool = AtomicBool::new(false);

const BASE_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,Translate,msEdgeTranslate,AutofillServerCommunication,msShopping,msEdgeShoppingUI --disable-background-networking --disable-component-update --disable-sync --no-pings --renderer-process-limit=1";

/// Browser arguments for the chosen rendering mode.
pub fn browser_args(render_mode: &str) -> String {
    match render_mode {
        "ultralight" => format!("{BASE_ARGS} --disable-gpu"),
        _ => format!("{BASE_ARGS} --disable-gpu-rasterization"),
    }
}

#[cfg(windows)]
fn set_level<R: Runtime>(webview: &tauri::WebviewWindow<R>, low: bool) {
    let _ = webview.with_webview(move |wv| {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        };
        use windows_core::Interface;
        // SAFETY: COM calls on the WebView's own thread (with_webview runs there).
        unsafe {
            let controller = wv.controller();
            let _ = controller.SetIsVisible(!low);
            if let Ok(core) = controller.CoreWebView2() {
                if let Ok(v19) = core.cast::<ICoreWebView2_19>() {
                    let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
                    let _ = v19.SetMemoryUsageTargetLevel(level);
                }
            }
        }
    });
}

#[cfg(not(windows))]
fn set_level<R: Runtime>(_webview: &tauri::WebviewWindow<R>, _low: bool) {}

pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    // only the main window is ever minimized; the widget stays as it is
    if window.label() != "main" || !matches!(event, WindowEvent::Resized(_) | WindowEvent::Focused(_)) {
        return;
    }
    let minimized = window.is_minimized().unwrap_or(false);
    if LOW.swap(minimized, Ordering::Relaxed) == minimized {
        return; // no change
    }
    if let Some(wv) = window.app_handle().get_webview_window(window.label()) {
        set_level(&wv, minimized);
    }
}
