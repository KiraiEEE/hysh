// Hysh - community plugins.
// A plugin is a folder in <data>/plugins/<id>/ with a manifest.json and ES-module code.
// Files are served to the UI from the loopback server (token-protected, no path escapes);
// the UI decides which plugins run (only ones the user enabled in Settings).
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::state::Shared;
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};

pub fn dir(s: &Shared) -> PathBuf {
    let d = s.data_dir.join("plugins");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Every plugin folder with a readable manifest.
pub fn list(s: &Shared) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir(s)) else { return out };
    for e in entries.flatten() {
        let id = e.file_name().to_string_lossy().to_string();
        if !e.path().is_dir() || !valid_id(&id) {
            continue;
        }
        let manifest = crate::state::read_json(&e.path().join("manifest.json"));
        match manifest {
            Some(m) if m.is_object() => {
                let get = |k: &str| m.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
                out.push(json!({
                    "id": id,
                    "name": if get("name").is_empty() { id.clone() } else { get("name") },
                    "version": get("version"),
                    "author": get("author"),
                    "description": get("description"),
                    "homepage": get("homepage"),
                    "main": get("main"),
                    "style": get("style"),
                    "themes": m.get("themes").cloned().unwrap_or(Value::Array(vec![])),
                }));
            }
            _ => out.push(json!({ "id": id, "name": id, "error": "manifest.json is missing or invalid" })),
        }
    }
    out.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    out
}

/// Resolves "<plugin>/<relative path>" inside the plugins folder, refusing anything that escapes it.
pub fn resolve_file(s: &Shared, rel: &str) -> Option<PathBuf> {
    let rel_path = Path::new(rel);
    if rel_path.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None; // "..", absolute paths, drive prefixes
    }
    let first = rel_path.components().next()?.as_os_str().to_str()?;
    if !valid_id(first) {
        return None;
    }
    let full = dir(s).join(rel_path);
    full.is_file().then_some(full)
}

#[cfg(test)]
mod tests {
    #[test]
    fn ids() {
        assert!(super::valid_id("slowed-reverb"));
        assert!(!super::valid_id("../evil"));
        assert!(!super::valid_id(""));
    }
}
