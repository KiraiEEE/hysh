// Hysh - community plugin loader. GPL-3.0-or-later
//
// A plugin is a folder in <data>/plugins/<id>/ containing manifest.json:
//   { "name": "...", "version": "1.0.0", "author": "...", "description": "...",
//     "main": "main.js", "style": "style.css", "themes": [{ "id", "name", "note", "bg", "fg", "ac", "light" }] }
// main.js is an ES module whose default export is activate(hysh). See PLUGINS.md.
// Plugins run with the same access as Hysh itself, so only enabled ones are loaded.
import { invoke, http, env } from './api.js';
import { state, on, setSetting } from './store.js';
import * as P from './player.js';
import { registerSource } from './sources.js';
import { pluginThemes } from './theme.js';
import { toast } from './ui.js';

export const loaded = new Map(); // id -> { manifest, error? }
const base = () => `http://127.0.0.1:${env.port}/p/${env.token}`;

function apiFor(manifest) {
  const storeKey = `plugin_${manifest.id}`;
  return Object.freeze({
    version: env.version,
    plugin: { id: manifest.id, name: manifest.name, url: `${base()}/${manifest.id}/` },
    audio: {
      context: P.audioContext,
      addEffect: (id, make) => P.addEffect(`${manifest.id}:${id}`, make),
      removeEffect: (id) => P.removeEffect(`${manifest.id}:${id}`),
    },
    sources: { register: (src) => registerSource({ ...src, id: src.id || manifest.id }) },
    player: {
      get current() { return P.player.current; },
      get playing() { return P.player.playing; },
      get position() { return P.player.position; },
      play: P.play, pause: P.pause, toggle: P.toggle, next: P.next, prev: P.prev, seek: P.seek,
      playList: P.playList, addToQueue: P.addToQueue,
    },
    events: { on },
    ui: { toast },
    http,
    storage: {
      get: (k, fallback = null) => state.settings[storeKey]?.[k] ?? fallback,
      set: (k, v) => setSetting(storeKey, { ...(state.settings[storeKey] || {}), [k]: v }, { silent: true }),
    },
  });
}

export async function listPlugins() {
  return invoke('plugins_list');
}

/** Loads every enabled plugin. Errors stay inside the plugin that caused them. */
export async function loadPlugins() {
  const { plugins } = await listPlugins().catch(() => ({ plugins: [] }));
  const enabled = new Set(state.settings.plugins_enabled || []);
  for (const m of plugins) {
    if (!enabled.has(m.id) || m.error) continue;
    try {
      for (const t of Array.isArray(m.themes) ? m.themes : []) if (t?.id) pluginThemes.push({ ...t, plugin: m.id });
      if (m.style) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `${base()}/${m.id}/${m.style}`;
        document.head.append(link);
      }
      if (m.main) {
        const mod = await import(`${base()}/${m.id}/${m.main}`);
        await mod.default?.(apiFor(m));
      }
      loaded.set(m.id, { manifest: m });
    } catch (e) {
      console.error(`plugin ${m.id}`, e);
      loaded.set(m.id, { manifest: m, error: String(e?.message || e) });
      toast(`Plugin “${m.name}” failed to load: ${e?.message || e}`, true, 6000);
    }
  }
}
