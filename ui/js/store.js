// Hysh - app state + persistence. GPL-3.0-or-later
import { invoke } from './api.js';
import { debounce } from './ui.js';

export const DEFAULTS = {
  music_folders: [],
  volume: 0.8,
  muted: false,
  speed: 1,
  crossfade: 0,
  gapless: true,
  autoplay: true,
  shuffle: false,
  repeat: 'off', // off | all | one
  eq_on: false,
  eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  preamp: 0,
  dynamic_color: true,
  theme: 'graphite',
  reduce_fx: false,
  anim_speed: 1,
  lyrics_size: 'normal',
  country: 'US',
  resolver: ['local', 'subsonic', 'youtube'],
  cache_mb: 1024,
  sponsorblock: true,
  download_format: 'm4a', // web sources: m4a (tagged, plays everywhere) | best (Opus/WebM)
  download_lossless: true, // FLAC / original files when the source offers them
  auto_download_likes: false,
  scrobble_enabled: true,
  discord_enabled: false,
  discord_app_id: '',
  lastfm_api_key: '',
  lastfm_secret: '',
  listenbrainz_token: '',
  jamendo_client_id: '',
  subsonic_url: '',
  subsonic_user: '',
  subsonic_pass: '',
  spotify_client_id: '',
  spotify_client_secret: '',
  ytdlp_path: '',
  render_mode: 'balanced', // balanced | ultralight (applied at start-up)
  window_material: 'none', // none | mica | mica-alt | acrylic (Windows 11)
  plugins_enabled: [],
  sidebar_collapsed: false,
  motion_follow_system: false, // honour Windows' "Animation effects" switch
  download_dir: '',
};

const listeners = new Map();
export function on(ev, fn) { (listeners.get(ev) || listeners.set(ev, new Set()).get(ev)).add(fn); return () => listeners.get(ev).delete(fn); }
export function emit(ev, data) { listeners.get(ev)?.forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }

export const state = {
  settings: { ...DEFAULTS },
  library: [],
  likes: [],          // tracks, newest first
  playlists: [],      // { id, name, desc, cover, tracks: [], created, origin }
  history: [],        // { t: track, at }
  stats: {},          // id -> { t, plays, secs, last }
  downloads: {},      // track id -> { t, path, at }  (offline copies)
};
const likeSet = new Set();

const saveSettingsNow = () => invoke('settings_set', { value: state.settings }).catch(console.error);
const saveSettingsSoon = debounce(saveSettingsNow, 400);
const savers = {};
function saveStore(name) {
  (savers[name] ||= debounce(() => invoke('store_save', { name, value: state[name] }).catch(console.error), 600))();
}

export async function loadAll() {
  const [settings, library, likes, playlists, history, stats, downloads] = await Promise.all([
    invoke('settings_get'),
    invoke('library_get'),
    invoke('store_load', { name: 'likes' }),
    invoke('store_load', { name: 'playlists' }),
    invoke('store_load', { name: 'history' }),
    invoke('store_load', { name: 'stats' }),
    invoke('store_load', { name: 'downloads' }),
  ]);
  state.settings = { ...DEFAULTS, ...(settings || {}) };
  // previews are gone: full songs only
  state.settings.resolver = (state.settings.resolver || DEFAULTS.resolver).filter((k) => DEFAULTS.resolver.includes(k));
  for (const k of DEFAULTS.resolver) if (!state.settings.resolver.includes(k)) state.settings.resolver.push(k);
  state.library = (library || []).map(localToTrack);
  state.likes = Array.isArray(likes) ? likes : [];
  state.playlists = Array.isArray(playlists) ? playlists : [];
  state.history = Array.isArray(history) ? history : [];
  state.stats = stats && typeof stats === 'object' ? stats : {};
  state.downloads = downloads && typeof downloads === 'object' ? downloads : {};
  await pruneDownloads();
  likeSet.clear();
  state.likes.forEach((t) => likeSet.add(t.id));
}

export function setSetting(key, value, { silent = false } = {}) {
  state.settings[key] = value;
  saveSettingsSoon();
  if (!silent) emit('settings', key);
}
export const flushSettings = saveSettingsNow;

export function localToTrack(t) {
  return {
    id: t.id, source: 'local', path: t.path, title: t.title, artist: t.artist, album: t.album,
    albumArtist: t.album_artist || t.artist, genre: t.genre, year: t.year, trackNo: t.track_no, disc: t.disc,
    duration: t.duration, added: t.added, cover: null, // cover URL is built on demand (needs the server token)
  };
}

export async function rescanLibrary() {
  await invoke('library_scan');
  state.library = (await invoke('library_get')).map(localToTrack);
  emit('library');
  return state.library.length;
}

// ---------- likes ----------
/**
 * Compact, persistable copy of a track: every plain field a source needs to play it again
 * (ssId, pageUrl, flac, uuid...), without empty values or nested objects.
 */
const slim = (t) => Object.fromEntries(Object.entries(t).filter(([, v]) => v != null && v !== '' && typeof v !== 'object' && typeof v !== 'function'));
export { slim };
export const isLiked = (t) => !!t && likeSet.has(t.id);
export function toggleLike(t) {
  if (likeSet.has(t.id)) {
    likeSet.delete(t.id);
    state.likes = state.likes.filter((x) => x.id !== t.id);
  } else {
    likeSet.add(t.id);
    state.likes.unshift(slim(t));
  }
  saveStore('likes');
  emit('likes', t);
  return likeSet.has(t.id);
}

/** Adds many tracks to Liked songs at once (one save, one event). Skips duplicates by id and by title+artist. */
export function addLikes(tracks) {
  const key = (t) => `${String(t.title).toLowerCase()}|${String(t.artist).split(',')[0].trim().toLowerCase()}`;
  const seen = new Set(state.likes.map(key));
  const fresh = [];
  for (const t of tracks) {
    if (likeSet.has(t.id) || seen.has(key(t))) continue;
    likeSet.add(t.id);
    seen.add(key(t));
    fresh.push(slim(t));
  }
  if (fresh.length) {
    state.likes = [...fresh, ...state.likes];
    saveStore('likes');
    emit('likes');
  }
  return fresh.length;
}

// ---------- artwork found later (imports arrive without covers) ----------
/** Writes found artwork into every saved copy of the song, so the lookup happens only once. */
export function patchTrackArt(id, cover, coverXL) {
  const fix = (t) => { if (t && t.id === id && !t.cover) { t.cover = cover; if (coverXL) t.coverXL = coverXL; return true; } return false; };
  if (state.likes.some(fix)) saveStore('likes');
  if (state.playlists.some((p) => p.tracks.map(fix).includes(true))) saveStore('playlists');
  if (state.history.map((h) => fix(h.t)).includes(true)) saveStore('history');
  if (fix(state.stats[id]?.t)) saveStore('stats');
  emit('art', id);
}

// ---------- backup / restore ----------
const SECRET_KEYS = ['lastfm_secret', 'lastfm_session', 'subsonic_pass', 'spotify_client_secret', 'spotify_refresh', 'listenbrainz_token'];
const MACHINE_KEYS = ['music_folders', 'download_dir', 'ytdlp_path'];

export function backupData() {
  const settings = Object.fromEntries(Object.entries(state.settings).filter(([k]) => !SECRET_KEYS.includes(k) && !MACHINE_KEYS.includes(k)));
  return { format: 'hysh-backup', version: 1, exportedAt: new Date().toISOString(), likes: state.likes, playlists: state.playlists, history: state.history, stats: state.stats, settings };
}

/** Merges a backup into the current data; nothing existing is deleted. */
export function mergeBackup(data) {
  if (!data || data.format !== 'hysh-backup') throw new Error('This is not a Hysh backup file');
  const likes = addLikes(Array.isArray(data.likes) ? data.likes : []);
  let playlists = 0;
  const have = new Set(state.playlists.map((p) => p.id));
  for (const p of Array.isArray(data.playlists) ? data.playlists : []) {
    if (!p?.id || have.has(p.id) || !Array.isArray(p.tracks)) continue;
    state.playlists.push({ ...p, tracks: p.tracks.map(slim) });
    playlists++;
  }
  const histKeys = new Set(state.history.map((h) => h.t.id + h.at));
  const incoming = (Array.isArray(data.history) ? data.history : []).filter((h) => h?.t?.id && !histKeys.has(h.t.id + h.at));
  state.history = [...state.history, ...incoming].sort((a, b) => b.at - a.at).slice(0, 400);
  for (const [id, s] of Object.entries(data.stats || {})) {
    const cur = state.stats[id];
    if (!cur) state.stats[id] = s;
    else { cur.plays = Math.max(cur.plays, s.plays || 0); cur.secs = Math.max(cur.secs, s.secs || 0); cur.last = Math.max(cur.last, s.last || 0); }
  }
  for (const [k, v] of Object.entries(data.settings || {})) {
    if (!SECRET_KEYS.includes(k) && !MACHINE_KEYS.includes(k) && k in DEFAULTS) state.settings[k] = v;
  }
  saveSettingsSoon();
  ['playlists', 'history', 'stats'].forEach(saveStore);
  emit('playlists'); emit('history'); emit('settings', 'restore');
  return { likes, playlists, history: incoming.length };
}

// ---------- playlists ----------
export function createPlaylist(name, tracks = [], extra = {}) {
  const p = { id: 'pl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, desc: '', tracks: tracks.map(slim), created: Date.now(), ...extra };
  state.playlists.unshift(p);
  saveStore('playlists');
  emit('playlists');
  return p;
}
export function updatePlaylist(id, patch) {
  const p = state.playlists.find((x) => x.id === id);
  if (!p) return;
  Object.assign(p, patch);
  saveStore('playlists');
  emit('playlists');
}
export function deletePlaylist(id) {
  state.playlists = state.playlists.filter((x) => x.id !== id);
  saveStore('playlists');
  emit('playlists');
}
export function addToPlaylist(id, tracks) {
  const p = state.playlists.find((x) => x.id === id);
  if (!p) return 0;
  const have = new Set(p.tracks.map((t) => t.id));
  const fresh = tracks.filter((t) => !have.has(t.id)).map(slim);
  p.tracks.push(...fresh);
  saveStore('playlists');
  emit('playlists');
  return fresh.length;
}
export function removeFromPlaylist(id, index) {
  const p = state.playlists.find((x) => x.id === id);
  if (!p) return;
  p.tracks.splice(index, 1);
  saveStore('playlists');
  emit('playlists');
}

// ---------- history + stats ----------
export function recordPlay(t) {
  state.history = [{ t: slim(t), at: Date.now() }, ...state.history.filter((h, i) => i < 400 && !(h.t.id === t.id && Date.now() - h.at < 60_000))];
  const s = (state.stats[t.id] ||= { t: slim(t), plays: 0, secs: 0, last: 0 });
  s.plays++;
  s.last = Date.now();
  saveStore('history');
  saveStore('stats');
  emit('history');
}
export function addListenTime(t, secs) {
  const s = state.stats[t.id];
  if (s) { s.secs += secs; saveStore('stats'); }
}
export function clearHistory() {
  state.history = [];
  saveStore('history');
  emit('history');
}

// ---------- downloads index ----------
export const downloadedPath = (t) => (t && state.downloads[t.id]?.path) || null;
export function markDownloaded(t, path) {
  state.downloads[t.id] = { t: slim(t), path, at: Date.now() };
  saveStore('downloads');
  emit('downloads');
}
export function forgetDownload(id) {
  delete state.downloads[id];
  saveStore('downloads');
  emit('downloads');
}
/** Drops entries whose file was deleted or moved outside the app. */
async function pruneDownloads() {
  const ids = Object.keys(state.downloads);
  if (!ids.length) return;
  const exists = await invoke('files_exist', { paths: ids.map((id) => state.downloads[id].path) }).catch(() => null);
  if (!exists) return;
  let changed = false;
  ids.forEach((id, i) => { if (!exists[i]) { delete state.downloads[id]; changed = true; } });
  if (changed) saveStore('downloads');
}
