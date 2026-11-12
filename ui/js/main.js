// Hysh - app shell. GPL-3.0-or-later
import { initEnv, appWindow } from './api.js';
import { $, $$, el, esc, icon, img, fmtTime, toast, slider, setSlider, hideAnimated, artColors, paintGlow, prompt, throttle } from './ui.js';
import { initPalette, openPalette } from './palette.js';
import { initWidgetHost, toggleWidget } from './widgethost.js';
import { THEMES } from './settings.js';
import { state, loadAll, on, isLiked, toggleLike, createPlaylist, setSetting } from './store.js';
import * as P from './player.js';
import { player } from './player.js';
import { coverOf, coverForCanvas, findArt, SOURCE_LABEL, looksLikeUrl } from './sources.js';
import { VIEWS, setAlive, runCleanups } from './views.js';
import { openImportDialog } from './importexport.js';
import { go, back, forward, setRenderer, current, canBack, canForward, trackRow, openArtist, openAlbum, refreshPlayingRows, trackMenu, download, canDownload } from './components.js';
import { mountLyrics } from './lyrics.js';
import { initDownloads } from './downloads.js';
import { applyTheme, initMaterial } from './theme.js';
import { loadPlugins } from './plugins.js';

// ---------------- boot ----------------
async function boot() {
  await initEnv();
  await loadAll();
  initDownloads();
  initMaterial(state.settings.window_material);
  await loadPlugins(); // before the theme, so a plugin theme can be the saved one
  applyLook();
  buildChrome();
  setRenderer(renderView);
  await P.restoreSession();
  go('home');
  if (!state.settings.music_folders.length && !state.history.length) setTimeout(() => toast('Search any song above and press play.', false, 5000), 800);
}


function applyLook() {
  const s = state.settings;
  applyTheme(s.theme);
  requestAnimationFrame(cacheAccent);
  document.documentElement.style.setProperty('--speed', s.anim_speed || 1);
  const systemReduced = s.motion_follow_system && matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.body.classList.toggle('reduce-fx', !!s.reduce_fx || systemReduced);
}

// ---------------- router ----------------
let viewSeq = 0;
async function renderView({ name, params }) {
  const seq = ++viewSeq;
  runCleanups();
  setAlive(() => seq === viewSeq);
  const main = $('#main');
  const root = el('<div class="view"></div>');
  main.style.scrollBehavior = 'auto';
  main.replaceChildren(root);
  main.scrollTop = 0;
  main.style.scrollBehavior = '';
  highlightNav(name, params);
  $('#nav-back').disabled = !canBack();
  $('#nav-fwd').disabled = !canForward();
  try {
    await (VIEWS[name] || VIEWS.home)(root, params || {});
  } catch (e) {
    console.error(e);
    if (seq === viewSeq) root.insertAdjacentHTML('beforeend', `<div class="empty">${icon('globe')}<h3>Something went wrong</h3><div>${esc(e.message || e)}</div></div>`);
  }
}

const NAV = [
  ['home', 'Home', 'home'], ['search', 'Search', 'search'], ['library', 'Library', 'library'],
  ['liked', 'Liked songs', 'heart'], ['downloads', 'Downloads', 'download'], ['radio', 'Radio', 'radio'], ['stats', 'Stats', 'chart'], ['settings', 'Settings', 'settings'],
];
function highlightNav(name, params) {
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name && (name !== 'playlist' || n.dataset.id === params?.id)));
}

function drawPlaylists() {
  const box = $('#nav-playlists');
  box.innerHTML = '';
  for (const p of state.playlists) {
    const cov = p.cover || coverOf(p.tracks[0]);
    const b = el(`<button class="nav-item" data-view="playlist" data-id="${p.id}" title="${esc(p.name)}">${cov ? `<img src="${esc(cov)}" alt="" loading="lazy">` : icon('list')}<span>${esc(p.name)}</span></button>`);
    b.onclick = () => go('playlist', { id: p.id });
    b.oncontextmenu = (e) => { e.preventDefault(); };
    box.append(b);
  }
  const imp = el(`<button class="nav-item">${icon('upload')}<span>Import…</span></button>`);
  imp.onclick = async () => { const p = await openImportDialog(); if (p) go('playlist', { id: p.id }); };
  box.append(imp);
  const c = current();
  if (c) highlightNav(c.name, c.params);
}

// ---------------- chrome ----------------
function buildChrome() {
  // title bar
  $('#nav-back').innerHTML = icon('left');
  $('#nav-fwd').innerHTML = icon('right');
  $('#nav-back').onclick = back;
  $('#nav-fwd').onclick = forward;
  $('.tb-search-icon').innerHTML = icon('search');
  const win = appWindow();
  $('#win-min').innerHTML = icon('min');
  $('#win-max').innerHTML = icon('max');
  $('#win-close').innerHTML = icon('close');
  $('#win-min').onclick = () => win.minimize();
  $('#win-max').onclick = () => win.toggleMaximize();
  $('#win-close').onclick = () => win.close();
  win.onResized?.(async () => { $('#win-max').innerHTML = icon((await win.isMaximized()) ? 'restore' : 'max'); });
  $('#titlebar').addEventListener('dblclick', (e) => { if (e.target.closest('[data-tauri-drag-region]') && !e.target.closest('button,input')) win.toggleMaximize(); });

  const search = $('#global-search');
  const runSearch = throttle(() => {
    const q = search.value.trim();
    if (looksLikeUrl(q)) return; // links open on Enter
    const c = current();
    go('search', { q, tab: c?.name === 'search' && c.params.tab ? c.params.tab : 'all' }, { replace: c?.name === 'search' });
  }, 450);
  search.addEventListener('input', runSearch);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') search.blur();
    if (e.key === 'Enter' && looksLikeUrl(search.value)) go('link', { url: search.value.trim() });
  });
  search.addEventListener('focus', () => { if (current()?.name !== 'search') go('search', { q: search.value.trim() }); });

  // sidebar: full or icon rail. The user's choice wins; narrow windows collapse it on their own.
  $('#nav-toggle').innerHTML = icon('sidebar');
  $('#nav-toggle').onclick = () => { setSetting('sidebar_collapsed', !state.settings.sidebar_collapsed, { silent: true }); applySidebar(); };
  narrow.addEventListener('change', applySidebar);
  applySidebar();
  const nav = $('#nav-main');
  for (const [view, label, ic] of NAV) {
    const b = el(`<button class="nav-item" data-view="${view}" title="${label}">${icon(ic)}<span>${label}</span></button>`);
    b.onclick = () => (view === 'search' ? (search.focus(), go('search', { q: search.value.trim() })) : go(view));
    nav.append(b);
  }
  $('#new-playlist').innerHTML = icon('plus');
  $('#new-playlist').onclick = async () => { const n = await prompt('New playlist', 'Give it a name', 'My playlist', 'Create'); if (n) { const p = createPlaylist(n); go('playlist', { id: p.id }); } };
  drawPlaylists();
  on('playlists', drawPlaylists);

  // player bar
  $('#pb-prev').innerHTML = icon('prev'); $('#pb-next').innerHTML = icon('next');
  $('#pb-shuffle').innerHTML = icon('shuffle'); $('#pb-lyrics').innerHTML = icon('mic'); $('#pb-queue').innerHTML = icon('queue');
  $('#pb-widget').innerHTML = icon('widget');
  $('#pb-play').onclick = P.toggle; $('#pb-prev').onclick = P.prev; $('#pb-next').onclick = P.next;
  $('#pb-shuffle').onclick = P.toggleShuffle; $('#pb-repeat').onclick = P.cycleRepeat;
  $('#pb-mute').onclick = P.toggleMute;
  $('#pb-like').onclick = () => {
    if (!player.current) return;
    const on = toggleLike(player.current);
    drawLike();
    $('#pb-like').classList.toggle('pop', on);
  };
  $('#pb-open').onclick = openNowPlaying;
  $('#pb-title').onclick = () => player.current && !player.current.live && openAlbum(player.current);
  $('#pb-artist').onclick = () => player.current && !player.current.live && openArtist(player.current);
  $('#pb-queue').onclick = () => toggleSide('queue');
  $('#pb-lyrics').onclick = () => toggleSide('lyrics');
  $('#pb-widget').onclick = toggleWidget;
  $('#pb-cover').onerror = function () { this.removeAttribute('src'); };
  $('.pb-now').addEventListener('contextmenu', (e) => player.current && trackMenu(e, player.current));
  slider($('#pb-seek'), { onInput: (p) => previewSeek(p), onCommit: (p) => commitSeek(p) });
  slider($('#np-seek'), { onInput: (p) => previewSeek(p), onCommit: (p) => commitSeek(p) });
  slider($('#pb-vol'), { onInput: (p) => P.setVolume(p), onCommit: (p) => P.setVolume(p) });
  $('#pb-vol').addEventListener('wheel', (e) => { e.preventDefault(); P.setVolume(state.settings.volume + (e.deltaY < 0 ? 0.05 : -0.05)); }, { passive: false });

  // side panel
  $('#sp-close').innerHTML = icon('close');
  $('#sp-close').onclick = () => toggleSide(null);
  $$('.sp-tabs [data-tab]').forEach((b) => (b.onclick = () => toggleSide(b.dataset.tab, true)));

  // now playing
  $('#np-close').innerHTML = icon('down');
  $('#np-close').onclick = closeNowPlaying;
  $('#np-prev').innerHTML = icon('prev'); $('#np-next').innerHTML = icon('next'); $('#np-shuffle').innerHTML = icon('shuffle');
  $('#np-play').onclick = P.toggle; $('#np-prev').onclick = P.prev; $('#np-next').onclick = P.next;
  $('#np-shuffle').onclick = P.toggleShuffle; $('#np-repeat').onclick = P.cycleRepeat;
  $('#np-artist').onclick = () => { if (player.current && !player.current.live) { closeNowPlaying(); openArtist(player.current); } };
  $$('.np-tabs [data-np]').forEach((b) => (b.onclick = () => setNpTab(b.dataset.np)));
  $('#np-dl').innerHTML = icon('download');
  $('#np-dl').onclick = () => player.current && download(player.current);
  $('#np-more').innerHTML = icon('more');
  $('#np-more').onclick = (e) => player.current && trackMenu(e, player.current);


  // player events
  on('track', onTrack);
  on('state', drawPlayState);
  on('queue', () => { if (sideTab === 'queue') drawQueue($('#sp-body')); if (npOpen && npTab === 'queue') drawQueue($('#np-right'), true); });
  on('settings', (k) => { if (k === 'shuffle' || k === 'repeat') drawModes(); if (k === 'dynamic_color') applyAccent(); if (k === 'lyrics_size') remountLyrics(); if (k === 'reduce_fx') schedule(); });
  on('volume', drawVolume);
  on('likes', drawLike);
  on('buffering', (b) => $('#pb-play').classList.toggle('loading', b));
  on('time', () => render());
  on('theme', () => requestAnimationFrame(cacheAccent));
  pbSeek = $('#pb-seek'); npSeek = $('#np-seek');
  pbPos = $('#pb-pos'); npPos = $('#np-pos'); pbDur = $('#pb-dur'); npDur = $('#np-dur');
  drawModes(); drawVolume(); drawPlayState();
  initPalette(paletteActions());
  initWidgetHost({ onFocusMain: async () => { await win.unminimize(); await win.show(); await win.setFocus(); } });
  $('#open-palette').onclick = openPalette;
  window.addEventListener('keydown', onKey);
}

// ---------------- player UI ----------------
let lastTrackId = null;
let pbSeek, npSeek, pbPos, npPos, pbDur, npDur;
function onTrack(t) {
  document.body.classList.toggle('has-track', !!t); // the dock only exists once there is a song
  if (!t) return;
  const cover = coverOf(t, true);
  $('#pb-title').textContent = t.title;
  $('#pb-artist').textContent = t.artist || '';
  for (const id of ['#pb-cover', '#np-cover']) {
    const im = $(id);
    if (!cover) { im.removeAttribute('src'); im.style.visibility = 'hidden'; continue; }
    im.style.visibility = '';
    if (im.getAttribute('src') === cover) continue;
    im.classList.remove('fade-in');
    im.onload = () => { void im.offsetWidth; im.classList.add('fade-in'); };
    im.src = cover;
  }
  $('#np-title').textContent = t.title;
  $('#np-artist').textContent = t.artist || '';
  $('#pb-badge').textContent = player.loading ? 'Loading…' : player.via && player.via !== 'Local file' ? player.via : '';
  $('#np-source').textContent = player.context?.label ? `Playing from ${player.context.label}` : (SOURCE_LABEL[t.source] || '');
  $('#np-dl').style.display = canDownload(t) ? '' : 'none';
  $('#pb-seek').classList.toggle('live', !!t.live);
  $('#np-seek').classList.toggle('live', !!t.live);
  drawLike();
  drawPlayState();
  document.title = `${t.title} · ${t.artist || ''} — Hysh`;
  if (t.id !== lastTrackId) {
    lastTrackId = t.id;
    if (!cover && !t.live) findArt(t).then((url) => { if (url && player.current === t) refreshArt(t); });
    paintBackdrop(t);
    applyAccent();
    remountLyrics();
    refreshPlayingRows();
  }
}

/** Artwork arrived after the song started: update every surface that shows it. */
function refreshArt(t) {
  const cover = coverOf(t, true);
  for (const id of ['#pb-cover', '#np-cover']) { const im = $(id); im.style.visibility = ''; im.src = cover; }
  paintBackdrop(t);
  applyAccent();
  P.refreshDiscord();
}

async function applyAccent() {
  const root = document.documentElement.style;
  if (!state.settings.dynamic_color || !player.current) { root.removeProperty('--accent'); return; }
  const accent = await artColors(coverForCanvas(player.current));
  if (accent) root.setProperty('--accent', accent);
  else root.removeProperty('--accent');
  cacheAccent();
}

// Now Playing backdrop and the ambient glow behind the whole app share one painter.
function paintBackdrop(t) {
  const src = coverForCanvas(t);
  const current = () => player.current === t;
  paintGlow($('#np-bg'), src, current);
  paintGlow($('#ambient'), src, current);
}

// the visualizer reads the accent once per change, not once per frame
let vizColor = '255,255,255';
function cacheAccent() {
  vizColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || vizColor;
}

function drawPlayState() {
  const playing = player.playing;
  const ic = icon(playing ? 'pause' : 'play');
  $('#pb-play').innerHTML = ic; $('#np-play').innerHTML = ic;
  $('.np-cover-wrap').classList.toggle('paused', !playing);
  document.body.classList.toggle('paused-all', !playing);
  if (pbSeek) schedule();
  if (player.current) $('#pb-badge').textContent = player.loading ? 'Loading…' : player.via && player.via !== 'Local file' ? player.via : '';
}
function drawModes() {
  const s = state.settings;
  for (const id of ['#pb-shuffle', '#np-shuffle']) $(id).classList.toggle('on', s.shuffle);
  const rep = icon(s.repeat === 'one' ? 'repeat1' : 'repeat');
  for (const id of ['#pb-repeat', '#np-repeat']) { $(id).innerHTML = rep; $(id).classList.toggle('on', s.repeat !== 'off'); $(id).title = `Repeat: ${s.repeat}`; }
}
function drawVolume() {
  const s = state.settings;
  setSlider($('#pb-vol'), s.muted ? 0 : s.volume);
  $('#pb-mute').innerHTML = icon(s.muted || s.volume === 0 ? 'mute' : s.volume < 0.5 ? 'volume1' : 'volume');
}
function drawLike() {
  const on = isLiked(player.current);
  $('#pb-like').classList.remove('pop'); // only a click should play the pop
  $('#pb-like').innerHTML = icon('heart', on ? 'fill' : '');
  $('#pb-like').classList.toggle('on', on);
}

let seekPreview = null;
function previewSeek(p) { seekPreview = p; if (!dragging) { dragging = true; schedule(); } }
function commitSeek(p) { seekPreview = null; dragging = false; P.seek(p * player.duration); schedule(); }

// ---------------- render scheduler ----------------
// Idle costs nothing: when paused, no timer or frame loop runs at all. While playing, progress is
// redrawn 4 times a second. Full frame rate is used only while something visible needs it
// (karaoke lyrics, the visualizer) or a slider is being dragged. Minimized = everything stops.
let lyricsCtl = null, npLyricsCtl = null;
let frameReq = 0, slowTimer = 0, dragging = false;
let lastPosText = '', lastDurText = '';

function needsFrames() {
  if (document.hidden) return false;
  if (dragging) return true;
  if (!player.playing) return false;
  return (npOpen && (npTab === 'lyrics' || !state.settings.reduce_fx)) || sideTab === 'lyrics';
}

function schedule() {
  cancelAnimationFrame(frameReq);
  clearInterval(slowTimer);
  frameReq = 0;
  slowTimer = 0;
  if (document.hidden) return;
  render();
  if (needsFrames()) frameReq = requestAnimationFrame(frame);
  else if (player.playing) slowTimer = setInterval(render, 250);
}

function frame() {
  render();
  if (needsFrames()) frameReq = requestAnimationFrame(frame);
  else schedule();
}

function render() {
  const live = !!player.current?.live;
  const d = player.duration, pos = seekPreview != null ? seekPreview * d : player.position;
  if (!live) {
    const p = d ? pos / d : 0;
    setSlider(pbSeek, p, player.buffered);
    if (npOpen) setSlider(npSeek, p, player.buffered);
  }
  const posText = live ? 'LIVE' : fmtTime(pos);
  if (posText !== lastPosText) { lastPosText = posText; pbPos.textContent = posText; npPos.textContent = posText; }
  const durText = live ? '' : fmtTime(d);
  if (durText !== lastDurText) { lastDurText = durText; pbDur.textContent = durText; npDur.textContent = durText; }
  if (player.playing || dragging) {
    lyricsCtl?.update(player.position);
    npLyricsCtl?.update(player.position);
  }
  if (npOpen && player.playing) drawViz();
}

document.addEventListener('visibilitychange', schedule);

// ---------------- side panel ----------------
let sideTab = null;
function toggleSide(tab, force = false) {
  if (!force && tab === sideTab) tab = null;
  sideTab = tab;
  if (tab) $('#sidepanel').classList.remove('hidden');
  else hideAnimated($('#sidepanel'));
  $$('.sp-tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#pb-queue').classList.toggle('on', tab === 'queue');
  $('#pb-lyrics').classList.toggle('on', tab === 'lyrics');
  lyricsCtl?.destroy(); lyricsCtl = null;
  const body = $('#sp-body');
  if (tab === 'queue') drawQueue(body);
  else if (tab === 'lyrics') lyricsCtl = mountLyrics(body, player.current, { small: true, onSeek: P.seek });
  schedule();
}

function remountLyrics() {
  if (sideTab === 'lyrics') { lyricsCtl?.destroy(); lyricsCtl = mountLyrics($('#sp-body'), player.current, { small: true, onSeek: P.seek }); }
  if (npOpen && npTab === 'lyrics') { npLyricsCtl?.destroy(); npLyricsCtl = mountLyrics($('#np-right'), player.current, { onSeek: P.seek }); }
  if (npOpen && npTab === 'about') drawAbout();
}

function drawQueue(box, big = false) {
  const q = player.queue;
  box.innerHTML = '';
  if (!q.length) { box.innerHTML = `<div class="empty">${icon('queue')}<h3>Queue is empty</h3><div>Play something to fill it.</div></div>`; return; }
  const wrap = el('<div class="tracks"></div>');
  const nowIdx = player.index;
  wrap.append(el('<div class="q-section">Now playing</div>'));
  if (q[nowIdx]) wrap.append(trackRow(q[nowIdx], nowIdx, q, { compact: true, onPlay: () => P.toggle() }));
  const upcoming = q.slice(nowIdx + 1);
  if (upcoming.length) {
    const head = el(`<div class="q-section" style="display:flex;justify-content:space-between">Next up${player.context?.label ? ' · ' + esc(player.context.label) : ''}<button class="link" style="text-transform:none;letter-spacing:0">Clear</button></div>`);
    head.querySelector('button').onclick = P.clearUpcoming;
    wrap.append(head);
    upcoming.slice(0, 150).forEach((t, k) => {
      const i = nowIdx + 1 + k;
      const r = trackRow(t, i, q, { compact: true, onPlay: () => P.jump(i), menu: { queueIndex: i, onRemove: () => P.removeAt(i) } });
      r.draggable = true;
      r.ondragstart = (e) => e.dataTransfer.setData('text/plain', String(i));
      r.ondragover = (e) => e.preventDefault();
      r.ondrop = (e) => { e.preventDefault(); P.moveItem(Number(e.dataTransfer.getData('text/plain')), i); };
      wrap.append(r);
    });
  }
  if (nowIdx > 0) {
    wrap.append(el('<div class="q-section">Played</div>'));
    q.slice(Math.max(0, nowIdx - 20), nowIdx).forEach((t, k) => { const i = Math.max(0, nowIdx - 20) + k; wrap.append(trackRow(t, i, q, { compact: true, onPlay: () => P.jump(i) })); });
  }
  box.append(wrap);
  if (big) wrap.style.cssText = 'height:100%;overflow:auto';
}

// ---------------- now playing ----------------
let npOpen = false, npTab = 'lyrics';
function openNowPlaying() {
  if (!player.current) return;
  npOpen = true;
  $('#nowplaying').classList.remove('hidden');
  setNpTab(player.current?.live ? 'queue' : npTab);
}
function closeNowPlaying() {
  if (!npOpen) return;
  npOpen = false;
  schedule();
  hideAnimated($('#nowplaying')).then(() => { if (!npOpen) { npLyricsCtl?.destroy(); npLyricsCtl = null; } });
}
function setNpTab(tab) {
  npTab = tab;
  $$('.np-tabs [data-np]').forEach((b) => b.classList.toggle('active', b.dataset.np === tab));
  npLyricsCtl?.destroy(); npLyricsCtl = null;
  const box = $('#np-right');
  if (tab === 'lyrics') npLyricsCtl = mountLyrics(box, player.current, { onSeek: P.seek });
  else if (tab === 'queue') drawQueue(box, true);
  else drawAbout();
  schedule();
}
async function drawAbout() {
  const box = $('#np-right');
  const t = player.current;
  if (!t) return;
  box.innerHTML = `<div class="about"><h3>${esc(t.title)}</h3>
    <div class="stat-grid">
      <div class="stat"><b>${esc(SOURCE_LABEL[t.source] || t.source)}</b><span>source</span></div>
      <div class="stat"><b>${esc(player.via || '—')}</b><span>playing from</span></div>
      ${t.duration ? `<div class="stat"><b>${fmtTime(t.duration)}</b><span>length</span></div>` : ''}
      ${state.stats[t.id] ? `<div class="stat"><b>${state.stats[t.id].plays}×</b><span>you played it</span></div>` : ''}
      ${t.album ? `<div class="stat"><b style="font-size:15px">${esc(t.album)}</b><span>album</span></div>` : ''}
    </div><div id="np-artist-info"><div class="spinner"></div></div></div>`;
  if (t.live) { $('#np-artist-info').innerHTML = `<p>Live internet radio${t.album ? ' · ' + esc(t.album) : ''}.</p>`; return; }
  const { artistInfo } = await import('./sources.js');
  const info = await artistInfo((t.artist || '').split(',')[0]).catch(() => null);
  if (player.current !== t) return;
  $('#np-artist-info').innerHTML = info
    ? `${info.image ? `<img class="art-img" src="${esc(info.image)}" alt="">` : ''}<h3>${esc((t.artist || '').split(',')[0])}</h3><p>${esc(info.text)}</p><span class="note">Source: ${esc(info.source)}</span>`
    : '<p class="note">No artist information found.</p>';
}

// visualizer: mirrored bars along the bottom of the cover
let vizData = null;
function drawViz() {
  const an = P.player.analyser();
  const c = $('#np-viz');
  if (!an || !c || state.settings.reduce_fx) return;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * devicePixelRatio) { c.width = w * devicePixelRatio; c.height = h * devicePixelRatio; }
  const g = c.getContext('2d');
  vizData ||= new Uint8Array(an.frequencyBinCount);
  an.getByteFrequencyData(vizData);
  g.clearRect(0, 0, c.width, c.height);
  const bars = 48, bw = c.width / bars;
  const grad = g.createLinearGradient(0, c.height, 0, 0);
  grad.addColorStop(0, `rgba(${vizColor},.85)`);
  grad.addColorStop(1, 'rgba(255,255,255,.0)');
  g.fillStyle = grad;
  for (let i = 0; i < bars; i++) {
    const v = vizData[Math.floor(Math.pow(i / bars, 1.6) * vizData.length * 0.85)] / 255;
    const bh = Math.max(2, v * v * c.height);
    g.fillRect(i * bw + bw * 0.2, c.height - bh, bw * 0.6, bh);
  }
}

// ---------------- sidebar rail ----------------
const narrow = matchMedia('(max-width: 1100px)');
function applySidebar() {
  const collapsed = !!state.settings.sidebar_collapsed || narrow.matches;
  document.body.classList.toggle('nav-collapsed', collapsed);
  $('#nav-toggle').setAttribute('aria-expanded', String(!collapsed));
  $('#nav-toggle').title = collapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)';
}
function toggleSidebar() { $('#nav-toggle').click(); }

// ---------------- command palette actions ----------------
function paletteActions() {
  const nav = (view, title, ic, keywords = '', params = {}) => ({ title, icon: ic, keywords, featured: true, run: () => go(view, params) });
  return [
    { title: 'Play / pause', icon: 'play', hint: 'Space', keywords: 'resume stop', featured: true, run: P.toggle },
    { title: 'Next song', icon: 'next', keywords: 'skip', run: P.next },
    { title: 'Previous song', icon: 'prev', keywords: 'back', run: P.prev },
    { title: 'Open Now Playing', icon: 'expand', hint: 'F', keywords: 'full screen immersive', featured: true, run: openNowPlaying },
    { title: 'Lyrics', icon: 'mic', hint: 'L', keywords: 'karaoke words', run: () => toggleSide('lyrics', true) },
    { title: 'Queue', icon: 'queue', hint: 'Q', keywords: 'up next', run: () => toggleSide('queue', true) },
    { title: 'Shuffle on / off', icon: 'shuffle', hint: 'S', keywords: 'random', run: P.toggleShuffle },
    { title: 'Repeat mode', icon: 'repeat', hint: 'R', keywords: 'loop', run: P.cycleRepeat },
    { title: 'Widget', icon: 'widget', hint: 'W', keywords: 'mini player floating pinned desktop', featured: true, run: toggleWidget },
    { title: 'Collapse / expand sidebar', icon: 'sidebar', hint: 'Ctrl B', keywords: 'menu rail navigation', run: toggleSidebar },
    { title: 'Sleep timer: 30 minutes', icon: 'clock', keywords: 'sleep stop timer', run: () => P.setSleep(30) },
    { title: 'Import music…', icon: 'upload', keywords: 'spotify playlist csv m3u', featured: true, run: async () => { const p = await openImportDialog(); if (p) go('playlist', { id: p.id }); } },
    nav('home', 'Home', 'home'), nav('library', 'Library', 'library', 'songs albums artists'), nav('liked', 'Liked songs', 'heart', 'favourites'),
    nav('downloads', 'Downloads', 'download', 'offline'), nav('radio', 'Radio', 'radio', 'stations live'), nav('stats', 'Stats', 'chart', 'wrapped top'),
    nav('settings', 'Settings', 'settings', 'preferences options'),
    ...THEMES.map((t) => ({ title: `Theme: ${t.name}`, icon: 'spark', keywords: `skin look ${t.note}`, run: () => { setSetting('theme', t.id); applyTheme(t.id); } })),
  ];
}

// ---------------- keyboard ----------------
const SHORTCUTS = [
  ['Space', 'Play / pause'], ['Ctrl + → / ←', 'Next / previous song'], ['→ / ←', 'Seek 5 seconds'],
  ['↑ / ↓', 'Volume'], ['M', 'Mute'], ['S', 'Shuffle'], ['R', 'Repeat'], ['L', 'Lyrics panel'], ['Q', 'Queue panel'],
  ['F', 'Now Playing'], ['W', 'Widget'], ['Ctrl + K', 'Command palette'], ['Ctrl + B', 'Collapse sidebar'], ['/ or Ctrl + F', 'Search'], ['Alt + ← / →', 'Back / forward'], ['Esc', 'Close'], ['?', 'This list'],
];
function showShortcuts() {
  import('./ui.js').then(({ modal }) => modal(`<h3>Keyboard shortcuts</h3>
    <div class="shortcuts">${SHORTCUTS.map(([k, d]) => `<kbd>${esc(k)}</kbd><span>${esc(d)}</span>`).join('')}</div>
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`));
}

function onKey(e) {
  const typing = e.target.closest('input, textarea, select');
  if (e.key === '/' && !typing) { e.preventDefault(); $('#global-search').focus(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#global-search').focus(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); return; }
  if (e.altKey && e.key === 'ArrowLeft') { back(); return; }
  if (e.altKey && e.key === 'ArrowRight') { forward(); return; }
  if (typing) return;
  switch (e.key) {
    case ' ': e.preventDefault(); P.toggle(); break;
    case 'ArrowRight': e.ctrlKey ? P.next() : P.seekBy(5); break;
    case 'ArrowLeft': e.ctrlKey ? P.prev() : P.seekBy(-5); break;
    case 'ArrowUp': e.preventDefault(); P.setVolume(state.settings.volume + 0.05); break;
    case 'ArrowDown': e.preventDefault(); P.setVolume(state.settings.volume - 0.05); break;
    case 'm': case 'M': P.toggleMute(); break;
    case 's': case 'S': P.toggleShuffle(); break;
    case 'r': case 'R': P.cycleRepeat(); break;
    case 'l': case 'L': toggleSide('lyrics'); break;
    case 'q': case 'Q': toggleSide('queue'); break;
    case 'f': case 'F': npOpen ? closeNowPlaying() : openNowPlaying(); break;
    case 'w': case 'W': if (player.current) toggleWidget(); break;
    case 'Escape': if (npOpen) closeNowPlaying(); break;
    case '?': showShortcuts(); break;
  }
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<div style="position:fixed;inset:40% 20%;z-index:99;background:#300;padding:20px;border-radius:12px">Hysh failed to start: ${esc(e.message || e)}</div>`);
});
