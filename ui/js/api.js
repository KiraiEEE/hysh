// Hysh - bridge to the Rust backend. GPL-3.0-or-later
const T = window.__TAURI__;
export const invoke = (cmd, args) => T.core.invoke(cmd, args);
export const listen = (ev, cb) => T.event.listen(ev, cb);
export const appWindow = () => T.window.getCurrentWindow();
export const dialog = T.dialog;

export const env = { port: 0, token: '', dataDir: '', downloadDir: '' };

export async function initEnv() {
  Object.assign(env, await invoke('app_env'));
}

const base = () => `http://127.0.0.1:${env.port}`;
const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

export const media = {
  file: (path) => `${base()}/file?${q({ t: env.token, p: path })}`,
  cover: (path) => `${base()}/cover?${q({ t: env.token, p: path })}`,
  proxy: (url) => `${base()}/proxy?${q({ t: env.token, u: url })}`,
  /** audio of a web page (YouTube, SoundCloud, Bandcamp...) fetched by yt-dlp */
  web: (pageUrl) => `${base()}/web?${q({ t: env.token, u: pageUrl })}`,
};

/** JSON over HTTP through Rust (no CORS). Returns the parsed body or throws. */
export async function http(url, opts = {}) {
  const r = await invoke('http_request', { req: { url, ...opts } });
  if (!r.ok) {
    const msg = typeof r.body === 'object' ? (r.body?.error?.message || r.body?.message || JSON.stringify(r.body).slice(0, 160)) : String(r.body).slice(0, 160);
    throw new Error(`HTTP ${r.status}: ${msg}`);
  }
  return r.body;
}

export const qs = q;
