// Hysh - shared view components: track rows, cards, shelves, menus, navigation. GPL-3.0-or-later
import { $, el, esc, icon, img, fmtTime, fmtNum, openMenu, toast, modal, prompt } from './ui.js';
import { state, isLiked, toggleLike, addToPlaylist, createPlaylist, removeFromPlaylist, emit } from './store.js';
import { player, playList, playNext, addToQueue } from './player.js';
import { coverOf, findArt, deezer, radioFor, SOURCE_LABEL, norm, watchUrl } from './sources.js';
import { invoke } from './api.js';
import { enqueue, canDownload, isDownloaded } from './downloads.js';

// ---------- router ----------
const hist = [];
let pos = -1;
let renderer = null;
export function setRenderer(fn) { renderer = fn; }
export function go(name, params = {}, { replace = false } = {}) {
  const entry = { name, params };
  if (replace && pos >= 0) hist[pos] = entry;
  else { hist.splice(pos + 1); hist.push(entry); pos = hist.length - 1; }
  renderer?.(entry);
}
export function back() { if (pos > 0) { pos--; renderer?.(hist[pos]); } }
export function forward() { if (pos < hist.length - 1) { pos++; renderer?.(hist[pos]); } }
export const current = () => hist[pos];
export const canBack = () => pos > 0;
export const canForward = () => pos < hist.length - 1;

// ---------- navigation helpers ----------
export async function openArtist(t) {
  const name = (t.artist || t.name || '').split(',')[0].trim();
  if (t.source === 'deezer' && t.artistId) return go('artist', { src: 'deezer', id: t.artistId });
  if (t.source === 'subsonic' && t.artistId) return go('artist', { src: 'subsonic', id: t.artistId.replace(/^ss:/, '') });
  if (t.source === 'local') return go('artist', { src: 'local', name: t.albumArtist || name });
  const a = await deezer.findArtist(name).catch(() => null);
  if (a) go('artist', { src: 'deezer', id: a.dzId });
  else go('search', { q: name });
}
export async function openAlbum(t) {
  if (t.source === 'deezer' && t.albumId) return go('album', { src: 'deezer', id: t.albumId });
  if (t.source === 'subsonic' && t.albumId) return go('album', { src: 'subsonic', id: t.albumId.replace(/^ss:/, '') });
  if (t.source === 'local') return go('album', { src: 'local', key: `${norm(t.albumArtist || t.artist)}|${norm(t.album)}` });
  if (t.source === 'archive') return go('album', { src: 'archive', id: t.id.slice(3).split('/')[0] });
  if (!t.album) return toast('This song has no album information');
  const r = await deezer.search(`${t.album} ${t.artist}`, 'album', 1).catch(() => []);
  if (r[0]) go('album', { src: 'deezer', id: r[0].dzId });
  else go('search', { q: `${t.album} ${t.artist}` });
}
export function openItem(it) {
  if (it.kind === 'album') {
    if (it.source === 'local') return go('album', { src: 'local', key: it.id.slice(4) });
    const map = { deezer: 'dzId', archive: 'iaId', subsonic: 'ssId', apple: 'amId' };
    return go('album', { src: it.source, id: it[map[it.source]] });
  }
  if (it.kind === 'artist') {
    if (it.source === 'local') return go('artist', { src: 'local', name: it.name });
    return go('artist', { src: it.source, id: it.dzId || it.ssId });
  }
  if (it.kind === 'playlist') return go('rplaylist', { src: it.source, id: it.dzId || it.ssId });
}

// ---------- playing a card directly ----------
export async function playItem(it) {
  try {
    const { loadItemTracks } = await import('./views.js');
    const tracks = await loadItemTracks(it);
    if (tracks.length) playList(tracks, 0, { label: it.title || it.name, item: it.id });
    else toast('Nothing to play here', true);
  } catch (e) { toast(e.message, true); }
}

// ---------- download (implemented in downloads.js) ----------
export { canDownload };
export const download = (t) => enqueue([t]);
export const downloadMany = (tracks, label) => enqueue(tracks, { label });

// ---------- add to playlist dialog ----------
export async function chooseAndAdd(tracks) {
  const list = state.playlists;
  const html = `<h3>Add to playlist</h3><p>${tracks.length > 1 ? tracks.length + ' songs' : esc(tracks[0].title)}</p>
    <div style="display:flex;flex-direction:column;gap:4px;max-height:320px;overflow:auto;margin-bottom:10px">
      <button class="mi" data-new>${icon('plus')}<span>New playlist…</span></button>
      ${list.map((p) => `<button class="mi" data-id="${p.id}">${icon('list')}<span>${esc(p.name)}</span><span style="margin-left:auto;color:var(--text-3)">${p.tracks.length}</span></button>`).join('')}
    </div><div class="modal-actions"><button class="btn" data-close>Cancel</button></div>`;
  const choice = await modal(html, (card, done) => {
    card.querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => done(b.dataset.id)));
    card.querySelector('[data-new]').onclick = () => done('__new');
  });
  if (!choice) return;
  if (choice === '__new') {
    const name = await prompt('New playlist', 'Give it a name', 'My playlist', 'Create');
    if (!name) return;
    createPlaylist(name, tracks);
    toast(`Created “${name}”`);
  } else {
    const n = addToPlaylist(choice, tracks);
    toast(n ? `Added ${n} song${n > 1 ? 's' : ''}` : 'Already in that playlist');
  }
}

// ---------- context menu ----------
export function trackMenu(e, t, opts = {}) {
  e.preventDefault();
  e.stopPropagation();
  const liked = isLiked(t);
  openMenu(e.clientX, e.clientY, [
    { head: t.title },
    { label: 'Play next', icon: 'queue', action: () => playNext([t]) },
    { label: 'Add to queue', icon: 'list', action: () => addToQueue([t]) },
    { label: 'Add to playlist…', icon: 'plus', action: () => chooseAndAdd([t]) },
    { label: liked ? 'Remove from Liked' : 'Like', icon: 'heart', action: () => toggleLike(t) },
    '-',
    !t.live && { label: 'Start radio', icon: 'radio', action: async () => { toast('Building a radio…'); const more = await radioFor(t).catch(() => []); playList([t, ...more], 0, { label: `${t.title} radio` }); } },
    !t.live && t.artist && { label: 'Go to artist', icon: 'user', action: () => openArtist(t) },
    !t.live && (t.album || t.albumId) && { label: 'Go to album', icon: 'disc', action: () => openAlbum(t) },
    '-',
    canDownload(t) && !isDownloaded(t) && { label: 'Download', icon: 'download', action: () => download(t) },
    t.source === 'local' && { label: 'Show in folder', icon: 'folder', action: () => invoke('open_path', { path: t.path }) },
    t.homepage && { label: 'Station website', icon: 'external', action: () => invoke('open_url', { url: t.homepage }) },
    t.videoId && { label: 'Open on YouTube', icon: 'external', action: () => invoke('open_url', { url: watchUrl(t.videoId) }) },
    t.pageUrl && { label: `Open on ${SOURCE_LABEL[t.source] || 'the web'}`, icon: 'external', action: () => invoke('open_url', { url: t.pageUrl }) },
    { label: 'Copy “Artist – Title”', icon: 'link', action: () => { navigator.clipboard.writeText(`${t.artist} – ${t.title}`); toast('Copied'); } },
    opts.playlistId != null && '-',
    opts.playlistId != null && { label: 'Remove from this playlist', icon: 'trash', action: () => { removeFromPlaylist(opts.playlistId, opts.index); opts.onRemove?.(); } },
    opts.queueIndex != null && { label: 'Remove from queue', icon: 'trash', action: () => opts.onRemove?.() },
  ]);
}

// ---------- track row ----------
export function trackRow(t, i, list, opts = {}) {
  const playing = player.current && player.current.id === t.id;
  const liked = isLiked(t);
  const cover = opts.noCover ? null : coverOf(t);
  const r = el(`<div class="tr ${opts.compact ? 'compact' : ''} ${playing ? 'playing' : ''}" data-id="${esc(t.id)}">
    ${opts.compact ? '' : `<div class="n"><span class="num" data-n="${opts.numbers === false ? '' : i + 1}">${playing ? '<span class="eqbars"><i></i><i></i><i></i></span>' : (opts.numbers === false ? '' : i + 1)}</span><button class="pbtn" title="Play">${icon('play')}</button></div>`}
    <div class="cov">${opts.noCover ? '' : img(cover, t.live ? 'radio' : 'note')}${opts.compact ? `<button class="pbtn">${icon('play')}</button>` : ''}</div>
    <div class="main"><div class="tt">${opts.showSource && LOUD_SOURCES.has(t.source) ? `<span class="src">${SOURCE_LABEL[t.source] || t.source}</span>` : ''}${esc(t.title)}</div>
      <div class="ta">${isDownloaded(t) ? `<span class="dl-mark" title="Downloaded">${icon('check')}</span>` : ''}${t.explicit ? '<span class="src">E</span>' : ''}<a data-artist>${esc(t.artist || '')}</a></div></div>
    ${opts.compact ? '' : `<div class="al"><a data-album>${esc(t.album || '')}</a></div>`}
    <div class="d">${t.live ? 'LIVE' : t.duration ? fmtTime(t.duration) : ''}</div>
    <div class="act">${!opts.compact && canDownload(t) && !isDownloaded(t) ? `<button class="icon-btn dl" title="Download">${icon('download')}</button>` : ''}<button class="icon-btn like ${liked ? 'on' : ''}" title="Like">${icon('heart', liked ? 'fill' : '')}</button>${opts.compact ? '' : `<button class="icon-btn more" title="More">${icon('more')}</button>`}</div>
  </div>`);
  const start = () => (opts.onPlay ? opts.onPlay(i) : playList(list, i, opts.context));
  if (!opts.noCover && !cover && !t.live) fillArt(r.querySelector('.cov'), t);
  r.ondblclick = start;
  r.querySelectorAll('.pbtn').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); start(); }));
  r.querySelector('.like').onclick = (e) => {
    e.stopPropagation();
    const on = toggleLike(t);
    e.currentTarget.classList.toggle('on', on);
    e.currentTarget.classList.toggle('pop', on);
    e.currentTarget.innerHTML = icon('heart', on ? 'fill' : '');
  };
  r.querySelector('.dl')?.addEventListener('click', (e) => { e.stopPropagation(); download(t); });
  r.querySelector('.more')?.addEventListener('click', (e) => trackMenu(e, t, { ...opts.menu, index: i }));
  r.oncontextmenu = (e) => trackMenu(e, t, { ...opts.menu, index: i });
  r.querySelector('[data-artist]').onclick = (e) => { e.stopPropagation(); if (!t.live) openArtist(t); };
  r.querySelector('[data-album]')?.addEventListener('click', (e) => { e.stopPropagation(); openAlbum(t); });
  return r;
}

export function trackList(tracks, opts = {}) {
  const box = el(`<div class="tracks ${opts.twoCol ? 'two-col' : ''}"></div>`);
  tracks.forEach((t, i) => box.append(trackRow(t, i, tracks, { compact: opts.twoCol, ...opts })));
  return box;
}

/** Swaps a placeholder for the real artwork once it is found. */
function fillArt(box, t) {
  findArt(t).then((url) => {
    const ph = url && box?.querySelector('.ph');
    if (!ph) return;
    const im = new Image();
    im.alt = '';
    im.decoding = 'async';
    im.className = 'fade-in';
    im.onload = () => ph.replaceWith(im);
    im.src = url;
  });
}

/** Only sources that change what you get are labelled; catalog and imported songs are not. */
const LOUD_SOURCES = new Set(['youtube', 'soundcloud', 'bandcamp', 'web', 'radio', 'stream', 'archive', 'jamendo', 'subsonic']);

/** Spotify-style playlist art: a 2x2 mosaic of the first four different covers, or the single cover. */
export function mosaicHtml(tracks, fallbackIcon = 'list') {
  const covers = [...new Set((tracks || []).map((t) => coverOf(t)).filter(Boolean))].slice(0, 4);
  if (covers.length < 4) return img(covers[0] || null, fallbackIcon);
  return `<div class="mosaic">${covers.map((c) => `<img src="${esc(c)}" alt="" loading="lazy" decoding="async">`).join('')}</div>`;
}

// ---------- cards ----------
export function card(it, opts = {}) {
  const round = it.kind === 'artist';
  const sub = it.kind === 'album' ? [it.year, it.artist].filter(Boolean).join(' · ')
    : it.kind === 'artist' ? (it.fans ? fmtNum(it.fans) + ' fans' : it.count ? it.count + ' songs' : 'Artist')
    : it.kind === 'playlist' ? `${it.owner || ''}${it.count ? ' · ' + it.count + ' songs' : ''}`
    : it.artist || '';
  const c = el(`<div class="card ${round ? 'round' : ''}">
    <div class="art">${img(it.cover || coverOf(it), it.kind === 'artist' ? 'user' : it.live ? 'radio' : it.kind === 'playlist' ? 'list' : 'disc')}
      <button class="fab" title="Play">${icon('play')}</button></div>
    <div class="t" title="${esc(it.title || it.name)}">${esc(it.title || it.name)}</div><div class="s">${esc(sub)}</div></div>`);
  if (!it.kind && !it.cover && !coverOf(it)) fillArt(c.querySelector('.art'), it);
  c.onclick = () => (opts.onOpen ? opts.onOpen(it) : it.kind ? openItem(it) : playList(opts.list || [it], opts.index || 0));
  c.querySelector('.fab').onclick = (e) => {
    e.stopPropagation();
    if (!it.kind) playList(opts.list || [it], opts.index || 0, opts.context);
    else playItem(it);
  };
  if (!it.kind) c.oncontextmenu = (e) => trackMenu(e, it);
  return c;
}

export function shelf(title, items, opts = {}) {
  const s = el(`<section class="shelf"><div class="shelf-head"><h2 class="shelf-title">${esc(title)}</h2>${opts.sub ? `<span class="sub">${esc(opts.sub)}</span>` : ''}${opts.more ? '<button class="link">Show all</button>' : ''}</div></section>`);
  if (opts.more) s.querySelector('.link').onclick = opts.more;
  if (opts.tracks) s.append(trackList(items, { twoCol: true, ...opts.listOpts }));
  else {
    const row = el(`<div class="${opts.grid ? 'grid' : 'row-scroll'}"></div>`);
    items.forEach((it, i) => row.append(card(it, { list: items, index: i, ...opts.cardOpts })));
    s.append(row);
  }
  return s;
}

/** Placeholder shelf that fills itself when the promise resolves (or disappears on error). */
/**
 * Placeholder shelf that loads only when it scrolls near the viewport, so a page never fetches
 * or decodes artwork the user does not reach. Removes itself if the source fails or is empty.
 */
const shelfObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    shelfObserver.unobserve(e.target);
    e.target._load?.();
  }
}, { rootMargin: '600px 0px' });

export function lazyShelf(parent, title, loader, opts = {}) {
  const ph = el(`<section class="shelf"><div class="shelf-head"><h2 class="shelf-title">${esc(title)}</h2></div><div class="row-scroll">${'<div><div class="skeleton" style="aspect-ratio:1"></div><div class="skeleton" style="height:12px;margin-top:10px;width:70%"></div></div>'.repeat(6)}</div></section>`);
  ph._load = () => {
    ph._load = null;
    Promise.resolve().then(loader).then((items) => {
      if (!ph.isConnected) return; // the user navigated away
      if (!items || !items.length) return ph.remove();
      ph.replaceWith(shelf(title, items, opts));
    }).catch((e) => { console.warn(title, e); ph.remove(); });
  };
  parent.append(ph);
  shelfObserver.observe(ph);
}

export function emptyState(iconName, title, text, actionHtml = '') {
  return `<div class="empty">${icon(iconName)}<h3>${esc(title)}</h3><div>${esc(text)}</div>${actionHtml ? `<div style="margin-top:16px">${actionHtml}</div>` : ''}</div>`;
}

export function refreshPlayingRows() {
  document.querySelectorAll('.tr').forEach((r) => {
    const on = player.current && r.dataset.id === player.current.id;
    if (on === r.classList.contains('playing')) return;
    r.classList.toggle('playing', on);
    const num = r.querySelector('.num');
    if (num && on) { num.dataset.n = num.textContent; num.innerHTML = '<span class="eqbars"><i></i><i></i><i></i></span>'; }
    else if (num && !on && num.querySelector('.eqbars')) num.textContent = num.dataset.n || '';
  });
}

export { emit };
