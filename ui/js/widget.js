// Hysh widget window. GPL-3.0-or-later
// Renders what the main window sends ("widget:state") and sends commands back ("widget:cmd").
// It owns no state of its own: preferences are changed through the main window, so the two
// windows can never overwrite each other.
import { $, icon, openMenu, paintGlow } from './ui.js';

const T = window.__TAURI__;
const win = T.window.getCurrentWindow();
const { LogicalSize, LogicalPosition, currentMonitor } = T.window;
const send = (cmd, extra = {}) => T.event.emit('widget:cmd', { cmd, ...extra });

const SIZES = { full: { w: 344, h: 132 }, lyrics: { w: 344, h: 152 }, compact: { w: 312, h: 84 } };
const MARGIN = 16;

let st = null;          // last state from the main window
let placing = false;    // true while we move the window ourselves
let shown = false;
let lastCover = '', lastLyric = '';
let base = { position: 0, at: 0 }; // for smooth local progress between updates
let timer = 0;

// ---------- controls ----------
$('#w-prev').innerHTML = icon('prev');
$('#w-next').innerHTML = icon('next');
$('#w-menu').innerHTML = icon('more');
$('#w-play').onclick = () => send('toggle');
$('#w-prev').onclick = () => send('prev');
$('#w-next').onclick = () => send('next');
$('#w-like').onclick = () => send('like');
$('#card').addEventListener('dblclick', (e) => { if (!e.target.closest('button')) send('focus-main'); });
window.addEventListener('keydown', (e) => {
  if (e.key === ' ') { e.preventDefault(); send('toggle'); }
  if (e.key === 'Escape') send('close');
});

$('#w-menu').onclick = (e) => {
  e.stopPropagation();
  const p = st?.prefs || {};
  const pin = (corner) => () => send('pref', { key: 'widget_mode', value: 'pinned', also: { widget_corner: corner } });
  const tick = (on) => (on ? 'check' : 'note');
  openMenu(e.clientX - 180, e.clientY, [
    { head: 'Widget' },
    { label: 'Floating (drag anywhere)', icon: tick(p.widget_mode === 'floating'), action: () => send('pref', { key: 'widget_mode', value: 'floating' }) },
    { label: 'Pin top-left', icon: tick(p.widget_mode === 'pinned' && p.widget_corner === 'tl'), action: pin('tl') },
    { label: 'Pin top-right', icon: tick(p.widget_mode === 'pinned' && p.widget_corner === 'tr'), action: pin('tr') },
    { label: 'Pin bottom-left', icon: tick(p.widget_mode === 'pinned' && p.widget_corner === 'bl'), action: pin('bl') },
    { label: 'Pin bottom-right', icon: tick(p.widget_mode === 'pinned' && p.widget_corner === 'br'), action: pin('br') },
    '-',
    { label: 'Always on top', icon: tick(p.widget_on_top !== false), action: () => send('pref', { key: 'widget_on_top', value: p.widget_on_top === false }) },
    { label: 'Compact', icon: tick(p.widget_size === 'compact'), action: () => send('pref', { key: 'widget_size', value: p.widget_size === 'compact' ? 'full' : 'compact' }) },
    { label: 'Show lyric line', icon: tick(p.widget_lyrics !== false), action: () => send('pref', { key: 'widget_lyrics', value: p.widget_lyrics === false }) },
    '-',
    { label: 'Open Hysh', icon: 'expand', action: () => send('focus-main') },
    { label: 'Close widget', icon: 'close', action: () => send('close') },
  ]);
};

// ---------- placement ----------
function sizeFor(p) {
  if (p.widget_size === 'compact') return SIZES.compact;
  return p.widget_lyrics !== false ? SIZES.lyrics : SIZES.full;
}

/** Sizes the window, then pins it to a corner of the work area or restores its floating spot. */
async function place(p) {
  placing = true;
  try {
    const { w, h } = sizeFor(p);
    await win.setSize(new LogicalSize(w, h));
    await win.setAlwaysOnTop(p.widget_on_top !== false);
    const mon = await currentMonitor();
    const scale = mon?.scaleFactor || 1;
    const area = mon?.workArea || { position: mon?.position || { x: 0, y: 0 }, size: mon?.size || { width: 1920, height: 1080 } };
    const ax = area.position.x / scale, ay = area.position.y / scale;
    const aw = area.size.width / scale, ah = area.size.height / scale;
    let x, y;
    if (p.widget_mode === 'floating' && p.widget_pos) {
      // keep a remembered spot on screen even if the display layout changed
      x = Math.min(Math.max(p.widget_pos.x, ax), ax + aw - w);
      y = Math.min(Math.max(p.widget_pos.y, ay), ay + ah - h);
    } else {
      const c = p.widget_corner || 'br';
      x = c.endsWith('l') ? ax + MARGIN : ax + aw - w - MARGIN;
      y = c.startsWith('t') ? ay + MARGIN : ay + ah - h - MARGIN;
    }
    await win.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
    if (!shown) { shown = true; await win.show(); }
  } finally {
    setTimeout(() => (placing = false), 250); // ignore the move events our own move causes
  }
}

let moveTimer = 0;
win.onMoved(async ({ payload }) => {
  if (placing || !st) return;
  clearTimeout(moveTimer);
  moveTimer = setTimeout(async () => {
    const scale = await win.scaleFactor();
    // dragging a pinned widget unpins it: it floats where it was dropped
    send('pref', { key: 'widget_pos', value: { x: Math.round(payload.x / scale), y: Math.round(payload.y / scale) }, also: { widget_mode: 'floating' }, silent: true });
  }, 350);
});

// ---------- rendering ----------
function setProgress() {
  if (!st?.duration || st.live) { $('#w-fill').style.transform = st?.live ? 'scaleX(1)' : 'scaleX(0)'; return; }
  const pos = base.position + (st.playing ? (performance.now() - base.at) / 1000 : 0);
  $('#w-fill').style.transform = `scaleX(${Math.min(1, pos / st.duration)})`;
}

function render(next) {
  const prev = st;
  st = next;
  const p = next.prefs || {};
  const layoutChanged = !prev || ['widget_mode', 'widget_corner', 'widget_on_top', 'widget_size', 'widget_lyrics'].some((k) => prev.prefs?.[k] !== p[k]);
  if (layoutChanged) place(p);

  document.documentElement.dataset.theme = next.theme === 'graphite' ? '' : next.theme;
  if (next.theme === 'graphite') delete document.documentElement.dataset.theme;
  if (next.accent) document.documentElement.style.setProperty('--accent', next.accent);
  document.body.classList.toggle('compact', p.widget_size === 'compact');
  document.body.classList.toggle('no-lyrics', p.widget_lyrics === false);

  const t = next.track;
  $('#w-title').textContent = t?.title || 'Nothing playing';
  $('#w-artist').textContent = t?.artist || '';
  if ((t?.cover || '') !== lastCover) {
    lastCover = t?.cover || '';
    const im = $('#w-cover');
    im.classList.remove('fade-in');
    if (lastCover) { im.onload = () => { void im.offsetWidth; im.classList.add('fade-in'); }; im.src = lastCover; } else im.removeAttribute('src');
    paintGlow($('#w-glow'), next.glow, () => st === next || st?.track?.id === t?.id);
  }
  const lyric = next.lyric || '';
  if (lyric !== lastLyric) {
    lastLyric = lyric;
    const el = $('#w-lyric');
    el.classList.add('swap');
    setTimeout(() => { el.textContent = lyric; el.classList.remove('swap'); }, 160);
  }
  $('#w-play').innerHTML = icon(next.playing ? 'pause' : 'play');
  $('#w-like').innerHTML = icon('heart', next.liked ? 'fill' : '');
  $('#w-like').classList.toggle('on', !!next.liked);

  base = { position: next.position || 0, at: performance.now() };
  setProgress();
  clearInterval(timer);
  timer = next.playing && !document.hidden ? setInterval(setProgress, 250) : 0; // idle = no timer at all
}

T.event.listen('widget:state', ({ payload }) => render(payload));
T.event.listen('widget:closing', () => document.body.classList.add('leaving'));
document.addEventListener('visibilitychange', () => st && render(st));
send('ready');
