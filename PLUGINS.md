# Writing Hysh plugins

A plugin is a folder inside Hysh's plugins folder
(`%APPDATA%\app.hysh.player\plugins\<plugin-id>\`; **Settings › Plugins › Open plugins folder**).
Enable it in **Settings › Plugins**, then press **Reload**.

> A plugin runs with the same access as Hysh itself. Only install plugins from people you trust.

## manifest.json

```json
{
  "name": "My plugin",
  "version": "1.0.0",
  "author": "you",
  "description": "One line shown in Settings.",
  "homepage": "https://example.com",
  "main": "main.js",
  "style": "style.css",
  "themes": [{ "id": "my-theme", "name": "My theme", "note": "Short description", "bg": "#101010", "fg": "#eeeeee", "ac": "#ff6699", "light": false }]
}
```

`main`, `style` and `themes` are all optional. The folder name is the plugin id (letters, digits, `-`, `_`).

## main.js

An ES module whose default export receives the `hysh` API:

```js
export default function activate(hysh) {
  hysh.ui.toast(`Hello from ${hysh.plugin.name}`);
}
```

| API | What it does |
|---|---|
| `hysh.audio.addEffect(id, (ctx) => ({ input, output }))` | Inserts a Web Audio effect after the equalizer. Use any nodes, including an `AudioWorkletNode` for custom DSP (load worklets from `hysh.plugin.url`). |
| `hysh.audio.removeEffect(id)` | Removes it. |
| `hysh.audio.context()` | The shared `AudioContext`. |
| `hysh.sources.register({ id, name, search(q), resolve(track) })` | Adds a music source with its own Search tab. `search` returns tracks `{ id, title, artist, album, duration, cover }`; `resolve(track)` returns `{ url }` of playable audio. |
| `hysh.player` | `current`, `playing`, `position`, `play()`, `pause()`, `toggle()`, `next()`, `prev()`, `seek(sec)`, `playList(tracks, index)`, `addToQueue(tracks)`. |
| `hysh.events.on(name, fn)` | `track`, `state`, `queue`, `likes`, `theme`, `downloads`. Returns an unsubscribe function. |
| `hysh.http(url, { method, headers, form, json })` | HTTP without CORS limits (runs in Hysh's backend). |
| `hysh.storage.get(key, fallback)` / `set(key, value)` | Small per-plugin settings. |
| `hysh.ui.toast(text, isError)` | A notification. |
| `hysh.plugin` | `{ id, name, url }`; `url` is where your plugin's files are served. |

## Themes

A theme sets Hysh's design tokens for `:root[data-theme="<id>"]` in the plugin's `style.css`
and lists the theme in `manifest.json` so it appears in the theme picker:

```css
:root[data-theme="my-theme"] {
  --bg: #101010; --bg-rgb: 16, 16, 16;
  --bg-raised: #171717; --bg-hover: #1e1e1e; --bg-active: #262626;
  --fg-rgb: 238, 238, 238;     /* text colour as r, g, b */
  --signal: 255, 102, 153;     /* accent as r, g, b */
  --r: 6px; --r-lg: 10px; --r-art: 8px;
  --font: "Segoe UI Variable Text", sans-serif;
}
```

## Examples

`plugins/reverb` (an audio effect) and `plugins/theme-sunset` (a theme) in this repository.
Copy either folder into the plugins folder to try it.
