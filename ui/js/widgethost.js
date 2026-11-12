// Hysh - main-window side of the widget. GPL-3.0-or-later
// Owns the widget's preferences and pushes the player's state to it. Pushes happen on events
// (track, play/pause, seek, likes, theme) plus a light 2 Hz tick while playing, for the lyric line.
import { invoke, listen } from './api.js';
import { state, on, setSetting, isLiked, toggleLike } from './store.js';
import { player, toggle, next, prev } from './player.js';
import { coverOf, coverForCanvas } from './sources.js';
import { fetchLyrics } from './lyrics.js';

const T = window.__TAURI__;
const PREF_KEYS = ['widget_mode', 'widget_corner', 'widget_on_top', 'widget_size', 'widget_lyrics', 'widget_pos'];

let isOpen = false;
let lyrics = null, lyricsFor = null;
let lastLyric = '';
let tick = 0;
let focusMain = () => {};

export const widgetOpen = () => isOpen;

function currentLyric() {
  const lines = lyrics?.level ? lyrics.lines : null;
  if (!lines?.length) return '';
  const ms = player.position * 1000 + 150;
  let lo = 0, hi = lines.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (lines[mid].t <= ms) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  return idx >= 0 ? lines[idx].text || '♪' : '';
}

function snapshot() {
  const t = player.current;
  const p = Object.fromEntries(PREF_KEYS.map((k) => [k, state.settings[k]]));
  return {
    track: t ? { id: t.id, title: t.title, artist: t.artist || '', cover: coverOf(t, true) || '', live: !!t.live } : null,
    glow: t ? coverForCanvas(t) : '',
    playing: player.playing,
    position: player.position,
    duration: player.duration,
    live: !!t?.live,
    liked: isLiked(t),
    lyric: state.settings.widget_lyrics === false ? '' : currentLyric(),
    theme: state.settings.theme === 'dark' ? 'graphite' : state.settings.theme || 'graphite',
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    prefs: p,
  };
}

function push() {
  if (!isOpen) return;
  const s = snapshot();
  lastLyric = s.lyric;
  T.event.emitTo('widget', 'widget:state', s).catch(() => {});
}

function loadLyrics() {
  const t = player.current;
  if (!t || t.id === lyricsFor) return;
  lyricsFor = t.id;
  lyrics = null;
  fetchLyrics(t).then((l) => { if (player.current?.id === t.id) { lyrics = l; push(); } });
}

/** 2 Hz while open and playing: push only when the lyric line changes, plus a resync every 5 s. */
function schedule() {
  clearInterval(tick);
  tick = 0;
  if (!isOpen || !player.playing) return;
  let n = 0;
  tick = setInterval(() => {
    n++;
    if (currentLyric() !== lastLyric || n % 10 === 0) push();
  }, 500);
}

export async function openWidget() {
  if (isOpen) return;
  isOpen = true;
  setSetting('widget_open', true, { silent: true });
  loadLyrics();
  await invoke('widget_open');
  schedule();
}

export async function closeWidget() {
  if (!isOpen) return;
  isOpen = false;
  setSetting('widget_open', false, { silent: true });
  schedule();
  await T.event.emitTo('widget', 'widget:closing').catch(() => {});
  setTimeout(() => invoke('widget_close'), 180); // let its exit animation play
}

export const toggleWidget = () => (isOpen ? closeWidget() : openWidget());

function handle({ cmd, key, value, also, silent }) {
  switch (cmd) {
    case 'ready': push(); break;
    case 'toggle': toggle(); break;
    case 'next': next(); break;
    case 'prev': prev(); break;
    case 'like': if (player.current) toggleLike(player.current); break;
    case 'close': closeWidget(); break;
    case 'focus-main': focusMain(); break;
    case 'pref':
      if (!PREF_KEYS.includes(key)) return;
      setSetting(key, value, { silent: true });
      for (const [k, v] of Object.entries(also || {})) if (PREF_KEYS.includes(k)) setSetting(k, v, { silent: true });
      if (!silent) push();
      break;
  }
}

export function initWidgetHost({ onFocusMain }) {
  focusMain = onFocusMain;
  listen('widget:cmd', ({ payload }) => handle(payload || {}));
  on('track', () => { loadLyrics(); push(); });
  on('state', () => { push(); schedule(); });
  on('time', push);
  on('likes', push);
  on('art', (id) => { if (player.current?.id === id) push(); });
  on('theme', () => requestAnimationFrame(push));
  if (state.settings.widget_open) openWidget();
}
