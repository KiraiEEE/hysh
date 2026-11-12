// Hysh - pages. GPL-3.0-or-later
import { $, el, esc, icon, img, fmtTime, fmtLong, fmtNum, toast, prompt, confirmBox, virtualList, debounce, openMenu } from './ui.js';
import { state, on, isLiked, createPlaylist, updatePlaylist, deletePlaylist, clearHistory } from './store.js';
import { player, playList, addToQueue, playNext } from './player.js';
import { deezer, apple, radio, archive, jamendo, subsonic, web, local, artistInfo, coverOf, importPlaylist, radioFor, norm, SOURCE_LABEL, pluginSources } from './sources.js';
import { go, card, shelf, lazyShelf, trackList, trackRow, emptyState, openArtist, chooseAndAdd, playItem, download, downloadMany, canDownload, mosaicHtml } from './components.js';
import { renderSettings } from './settings.js';
import { jobs, retry, clearFinished, enqueue } from './downloads.js';
import { openImportDialog, exportTracks } from './importexport.js';
import { invoke, env } from './api.js';

export const VIEWS = {};
let alive = () => true;
export const setAlive = (fn) => (alive = fn);
const cleanups = [];
export function runCleanups() { while (cleanups.length) { try { cleanups.pop()(); } catch { /* ignore */ } } }

/** tracks behind a card (album / playlist / artist) for one-click play */
export async function loadItemTracks(it) {
  if (it.kind === 'uplaylist') return state.playlists.find((p) => p.id === it.id)?.tracks || [];
  if (it.kind === 'album') {
    if (it.source === 'local') return local.albums().find((a) => a.id === it.id)?.tracks || [];
    if (it.source === 'deezer') return (await deezer.album(it.dzId)).tracks;
    if (it.source === 'archive') return (await archive.item(it.iaId)).tracks;
    if (it.source === 'subsonic') return (await subsonic.album(it.ssId)).tracks;
    if (it.source === 'apple') return (await apple.album(it.amId)).tracks;
  }
  if (it.kind === 'playlist') {
    if (it.source === 'deezer') return (await deezer.playlist(it.dzId)).tracks;
    if (it.source === 'subsonic') return (await subsonic.playlist(it.ssId)).tracks;
  }
  if (it.kind === 'artist') {
    if (it.source === 'local') return local.artists().find((a) => a.id === it.id)?.tracks || [];
    if (it.source === 'deezer') return (await deezer.artist(it.dzId)).top;
  }
  return [];
}

function heroHtml({ kind, title, cover, art = '', meta = '', desc = '', round = false, fallback = 'disc' }) {
  return `<div class="hero ${round ? 'round' : ''}"><div class="hart">${art || img(cover, fallback)}</div>
    <div style="min-width:0"><div class="kind">${esc(kind)}</div><h1>${esc(title)}</h1><div class="meta">${meta}</div>${desc ? `<div class="desc">${esc(desc)}</div>` : ''}</div></div>`;
}

function actionsBar(tracks, context, extra = []) {
  const bar = el(`<div class="actions"><button class="play-btn accent" title="Play">${icon('play')}</button>
    <button class="icon-btn lg" title="Shuffle">${icon('shuffle')}</button></div>`);
  bar.children[0].onclick = () => playList(tracks, 0, context);
  bar.children[1].onclick = () => { const s = tracks.slice().sort(() => Math.random() - 0.5); playList(s, 0, context); };
  if (tracks.some(canDownload)) {
    const dl = el(`<button class="icon-btn lg" title="Download all">${icon('download')}</button>`);
    dl.onclick = () => downloadMany(tracks, context?.label ? `from “${context.label}”` : 'songs');
    bar.append(dl);
  }
  for (const x of extra) { const b = el(`<button class="icon-btn lg" title="${esc(x.title)}">${icon(x.icon)}</button>`); b.onclick = x.action; bar.append(b); }
  const more = el(`<button class="icon-btn lg" title="More">${icon('more')}</button>`);
  more.onclick = (e) => {
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, [
      { label: 'Add all to queue', icon: 'list', action: () => addToQueue(tracks) },
      { label: 'Play all next', icon: 'queue', action: () => playNext(tracks) },
      { label: 'Add all to playlist…', icon: 'plus', action: () => chooseAndAdd(tracks) },
      { label: 'Save as new playlist', icon: 'plus', action: () => { createPlaylist(context?.label || 'Saved', tracks); toast('Saved to your playlists'); } },
      '-',
      { label: 'Export as M3U8 playlist', icon: 'upload', action: () => exportTracks(tracks, context?.label, 'm3u') },
      { label: 'Export as CSV', icon: 'upload', action: () => exportTracks(tracks, context?.label, 'csv') },
    ]);
  };
  bar.append(more);
  return bar;
}

const totalDur = (tracks) => tracks.reduce((s, t) => s + (t.duration || 0), 0);

// ===================== HOME =====================
VIEWS.home = async (root) => {
  // jump back in
  const seen = new Set();
  const recent = state.history.map((h) => h.t).filter((t) => !seen.has(t.id) && seen.add(t.id)).slice(0, 12);
  const quick = quickTiles(recent);
  if (quick) root.append(quick);
  if (recent.length) root.append(shelf('Recently played', recent, { cardOpts: { context: { label: 'Recently played' } } }));

  lazyShelf(root, 'Charts', async () => (await deezer.chart()).tracks.slice(0, 12), { tracks: true, sub: 'Deezer', listOpts: { context: { label: 'Top songs' } } });
  lazyShelf(root, 'New releases', () => deezer.newReleases());
  lazyShelf(root, 'Albums in the charts', async () => {
    const d = (await deezer.chart()).albums;
    if (d.length >= 8) return d;
    const a = await apple.topAlbums(state.settings.country, 30).catch(() => []);
    return [...d, ...a];
  }, { sub: 'Deezer · Apple Music' });
  lazyShelf(root, 'Artists in the charts', async () => (await deezer.chart()).artists);
  lazyShelf(root, 'Playlists', async () => (await deezer.chart()).playlists);
  lazyShelf(root, `Most played in ${state.settings.country}`, () => apple.top(state.settings.country, 50).then((x) => x.slice(0, 12)), { tracks: true, sub: 'Apple Music', listOpts: { context: { label: 'Apple Music top songs' } } });
  if (state.library.length) {
    const albums = local.albums().sort(() => Math.random() - 0.5).slice(0, 14);
    root.append(shelf('From your library', albums, { more: () => go('library', { tab: 'albums' }) }));
  }
  if (subsonic.enabled()) lazyShelf(root, 'New on your server', () => subsonic.albums('newest', 20));
  if (jamendo.enabled()) lazyShelf(root, 'Free music this week', () => jamendo.popular(20));
  lazyShelf(root, 'Live radio', () => radio.top(20), { more: () => go('radio') });
};

/** Spotify's quick-access grid: Liked songs, your playlists, then recent songs. */
function quickTiles(recent) {
  const tiles = [];
  if (state.likes.length) tiles.push({ title: 'Liked songs', art: mosaicHtml(state.likes, 'heart'), open: () => go('liked'), play: () => playList(state.likes, 0, { label: 'Liked songs' }) });
  for (const p of state.playlists.slice(0, 5)) {
    tiles.push({ title: p.name, art: p.cover ? img(p.cover, 'list') : mosaicHtml(p.tracks), open: () => go('playlist', { id: p.id }), play: () => playList(p.tracks, 0, { label: p.name }) });
  }
  for (const t of recent) {
    if (tiles.length >= 8) break;
    tiles.push({ title: t.title, art: img(coverOf(t), 'note'), open: () => playList(recent, recent.indexOf(t), { label: 'Recently played' }), play: () => playList(recent, recent.indexOf(t), { label: 'Recently played' }) });
  }
  if (tiles.length < 2) return null;
  const grid = el('<section class="quick"></section>');
  for (const q of tiles) {
    const tile = el(`<div class="q-tile"><div class="q-art">${q.art}</div><span>${esc(q.title)}</span><button class="play-btn accent" title="Play">${icon('play')}</button></div>`);
    tile.onclick = q.open;
    tile.querySelector('.play-btn').onclick = (e) => { e.stopPropagation(); q.play(); };
    grid.append(tile);
  }
  return grid;
}

/** Spotify-style search header: the best match as a big card, the first songs beside it. */
function topResult(q, songs, artists, ctx) {
  const artistFirst = artists[0] && norm(artists[0].name) === norm(q);
  const best = artistFirst ? artists[0] : songs[0];
  const box = el(`<section class="top-result"><div><h2 class="shelf-title">Top result</h2>
    <div class="tr-card ${artistFirst ? 'round' : ''}"><div class="art">${img(best.cover, artistFirst ? 'user' : 'note')}</div>
      <div class="name">${esc(best.name || best.title)}</div>
      <div class="note">${artistFirst ? 'Artist' : `Song · ${esc(best.artist || '')}`}</div>
      <button class="play-btn accent" title="Play">${icon('play')}</button></div></div>
    <div><h2 class="shelf-title">Songs</h2></div></section>`);
  const cardEl = box.querySelector('.tr-card');
  cardEl.onclick = () => (artistFirst ? go('artist', { src: 'deezer', id: best.dzId }) : playList(songs, 0, ctx));
  cardEl.querySelector('.play-btn').onclick = async (e) => {
    e.stopPropagation();
    if (artistFirst) playItem(best); else playList(songs, 0, ctx);
  };
  box.children[1].append(trackList(songs.slice(0, 4), { compact: true, context: ctx }));
  return box;
}

// ===================== SEARCH =====================
const TABS = [
  ['all', 'All'], ['songs', 'Songs'], ['albums', 'Albums'], ['artists', 'Artists'], ['playlists', 'Playlists'],
  ['youtube', 'YouTube'], ['soundcloud', 'SoundCloud'], ['library', 'Your library'], ['radio', 'Radio'], ['archive', 'Internet Archive'], ['itunes', 'iTunes'],
  ['server', 'Server'], ['jamendo', 'Jamendo'],
];
VIEWS.search = async (root, { q = '', tab = 'all' }) => {
  const input = $('#global-search');
  if (input.value !== q) input.value = q;
  if (!q) return browse(root);
  const tabs = [...TABS.filter(([k]) => (k !== 'server' || subsonic.enabled()) && (k !== 'jamendo' || jamendo.enabled())),
    ...[...pluginSources.values()].map((s) => [`plugin:${s.id}`, s.name || s.id])];
  const chips = el(`<div class="chips">${tabs.map(([k, l]) => `<button class="chip ${k === tab ? 'active' : ''}" data-k="${k}">${l}</button>`).join('')}</div>`);
  chips.onclick = (e) => { const k = e.target.dataset.k; if (k) go('search', { q, tab: k }, { replace: true }); };
  root.append(chips);
  const body = el('<div><div class="spinner"></div></div>');
  root.append(body);
  const done = () => body.querySelector('.spinner')?.remove();
  const ctx = { label: `Search: ${q}` };
  try {
    if (tab === 'all') {
      const [songs, albums, artists, playlists] = await Promise.all([
        deezer.search(q, 'track', 20).catch(() => []), deezer.search(q, 'album', 16).catch(() => []),
        deezer.search(q, 'artist', 12).catch(() => []), deezer.search(q, 'playlist', 12).catch(() => []),
      ]);
      if (!alive()) return;
      done();
      const mine = local.search(q).slice(0, 6);
      if (mine.length) body.append(shelf('In your library', mine, { tracks: true, listOpts: { showSource: true, context: ctx } }));
      if (songs.length || artists.length) body.append(topResult(q, songs, artists, ctx));
      if (songs.length > 4) body.append(shelf('More songs', songs.slice(4, 12), { tracks: true, more: () => go('search', { q, tab: 'songs' }, { replace: true }), listOpts: { context: ctx } }));
      if (artists.length) body.append(shelf('Artists', artists));
      if (albums.length) body.append(shelf('Albums', albums));
      if (playlists.length) body.append(shelf('Playlists', playlists));
      if (await web.ensure()) lazyShelf(body, 'YouTube', () => web.search(q, 10), { tracks: true, more: () => go('search', { q, tab: 'youtube' }, { replace: true }), listOpts: { context: ctx } });
      lazyShelf(body, 'Radio stations', () => radio.search(q, 12));
      lazyShelf(body, 'Internet Archive', () => archive.search(q, 12));
      if (!songs.length && !albums.length && !mine.length) body.append(el(emptyState('search', 'No results', `Nothing matched “${q}”.`)));
      return;
    }
    let content;
    if (tab === 'songs') content = trackList(await deezer.search(q, 'track', 60), { context: ctx });
    else if (tab === 'albums') content = gridOf(await deezer.search(q, 'album', 60));
    else if (tab === 'artists') content = gridOf(await deezer.search(q, 'artist', 40));
    else if (tab === 'playlists') content = gridOf(await deezer.search(q, 'playlist', 40));
    else if (tab === 'itunes') content = trackList(await apple.search(q, 50), { context: ctx });
    else if (tab === 'radio') content = gridOf(await radio.search(q, 60));
    else if (tab === 'archive') content = gridOf(await archive.search(q, 60));
    else if (tab === 'jamendo') content = trackList(await jamendo.search(q, 50), { context: ctx });
    else if (tab === 'library') {
      const r = local.search(q);
      content = r.length ? trackList(r, { context: ctx }) : el(emptyState('library', 'Nothing in your library', state.library.length ? `No local songs match “${q}”.` : 'Add a music folder in Settings to search your own files.'));
    } else if (tab === 'server') {
      const r = await subsonic.search(q);
      content = el('<div></div>');
      if (r.tracks.length) content.append(shelf('Songs', r.tracks, { tracks: true, listOpts: { context: ctx } }));
      if (r.albums.length) content.append(shelf('Albums', r.albums));
      if (r.artists.length) content.append(shelf('Artists', r.artists));
    } else if (tab.startsWith('plugin:')) {
      const src = pluginSources.get(tab.slice(7));
      content = src ? trackList((await src.search(q)).map((t) => ({ ...t, source: src.id })), { context: ctx }) : el(emptyState('spark', 'Plugin not loaded', ''));
    } else if (tab === 'youtube' || tab === 'soundcloud') {
      content = (await web.ensure())
        ? trackList(await web.search(q, 25, tab), { context: ctx })
        : el(emptyState('globe', 'Could not set up web search', 'Check your internet connection and try again.'));
    }
    if (!alive()) return;
    done();
    body.append(content);
  } catch (e) {
    done();
    body.append(el(emptyState('globe', 'Search failed', e.message || String(e))));
  }
};
const gridOf = (items) => {
  const g = el('<div class="grid"></div>');
  items.forEach((it, i) => g.append(card(it, { list: items, index: i })));
  if (!items.length) return el(emptyState('search', 'No results', 'Try different words.'));
  return g;
};

async function browse(root) {
  root.append(el('<h1 class="page">Browse</h1>'));
  const sec = el('<section class="shelf"><div class="shelf-head"><h2 class="shelf-title">Genres</h2></div><div class="tiles"><div class="spinner"></div></div></section>');
  root.append(sec);
  lazyShelf(root, 'Stations by mood', async () => {
    const tags = ['chillout', 'lofi', 'jazz', 'classical', 'ambient', 'rock', 'hiphop', 'dance', 'news', 'pop'];
    const lists = await Promise.all(tags.slice(0, 5).map((t) => radio.byTag(t, 4).catch(() => [])));
    return lists.flat();
  });
  try {
    const genres = await deezer.genres();
    const tiles = sec.querySelector('.tiles');
    tiles.innerHTML = '';
    for (const g of genres) {
      const c = el(`<button class="tile"><img src="${esc(g.cover)}" alt="" loading="lazy"><span>${esc(g.name)}</span></button>`);
      c.onclick = () => go('genre', { id: g.id, name: g.name });
      tiles.append(c);
    }
  } catch (e) { sec.remove(); }
}

// ===================== PASTED LINK =====================
VIEWS.link = async (root, { url }) => {
  root.append(el('<div class="spinner"></div>'));
  if (!(await web.ensure())) {
    root.innerHTML = emptyState('link', 'Could not open links right now', 'Check your internet connection and try again.');
    return;
  }
  const r = await web.extract(url);
  if (!alive()) return;
  root.innerHTML = '';
  if (!r.tracks.length) { root.append(el(emptyState('link', 'Nothing playable here', url))); return; }
  const label = r.title || r.tracks[0].title;
  const origin = SOURCE_LABEL[r.tracks[0].source] || 'Web';
  root.append(el(heroHtml({ kind: `${r.isList ? 'Playlist' : 'Song'} · ${origin}`, title: label, cover: r.tracks[0].cover, fallback: 'link', meta: `${esc(r.owner || '')}${r.owner ? ' · ' : ''}${r.tracks.length} song${r.tracks.length > 1 ? 's' : ''} · ${fmtLong(totalDur(r.tracks))}` })));
  root.append(actionsBar(r.tracks, { label }, [{ icon: 'plus', title: 'Save to your playlists', action: () => { createPlaylist(label, r.tracks, { cover: r.tracks[0].cover, origin }); toast('Saved to your playlists'); } }]));
  root.append(trackList(r.tracks, { showSource: true, context: { label } }));
};

// ===================== GENRE =====================
VIEWS.genre = async (root, { id, name }) => {
  root.append(el(`<h1 class="page">${esc(name)}</h1>`));
  lazyShelf(root, 'Artists', () => deezer.genreArtists(id), { grid: true });
  lazyShelf(root, `${name} radio stations`, () => radio.byTag(name.toLowerCase().split(/[ /&]/)[0], 20));
};

// ===================== LIBRARY =====================
VIEWS.library = async (root, { tab = 'songs' }) => {
  const head = el(`<div style="display:flex;align-items:center;gap:12px;margin-bottom:6px"><h1 class="page" style="margin:0;flex:1">Your library</h1>
    <button class="btn" id="lib-rescan">${icon('refresh')}Rescan</button><button class="btn" id="lib-folders">${icon('folder')}Folders</button></div>`);
  root.append(head);
  head.querySelector('#lib-rescan').onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { const { rescanLibrary } = await import('./store.js'); const n = await rescanLibrary(); toast(`Library: ${n} songs`); go('library', { tab }, { replace: true }); }
    catch (err) { toast(String(err), true); } finally { b.disabled = false; }
  };
  head.querySelector('#lib-folders').onclick = () => go('settings', { section: 'library' });
  const tabs = [['songs', 'Songs'], ['albums', 'Albums'], ['artists', 'Artists'], ['playlists', 'Playlists']];
  const chips = el(`<div class="chips">${tabs.map(([k, l]) => `<button class="chip ${k === tab ? 'active' : ''}" data-k="${k}">${l}</button>`).join('')}</div>`);
  chips.onclick = (e) => e.target.dataset.k && go('library', { tab: e.target.dataset.k }, { replace: true });
  root.append(chips);

  if (tab === 'playlists') {
    const items = state.playlists.map((p) => ({ kind: 'uplaylist', id: p.id, title: p.name, cover: p.cover || coverOf(p.tracks[0]), owner: p.origin ? `Imported from ${p.origin}` : 'You', count: p.tracks.length }));
    const g = el('<div class="grid"></div>');
    const imp = el(`<div class="card"><div class="art"><div class="ph">${icon('upload')}</div></div><div class="t">Import</div><div class="s">Spotify, links, files, Last.fm</div></div>`);
    imp.onclick = async () => { const p = await openImportDialog(); if (p) go('playlist', { id: p.id }); else go('library', { tab: 'playlists' }, { replace: true }); };
    g.append(imp);
    const liked = el(`<div class="card"><div class="art"><div class="ph">${icon('heart', 'fill')}</div></div><div class="t">Liked songs</div><div class="s">${state.likes.length} songs</div></div>`);
    liked.onclick = () => go('liked');
    g.append(liked);
    items.forEach((it) => g.append(card(it, { onOpen: () => go('playlist', { id: it.id }) })));
    if (subsonic.enabled()) lazyShelf(root, 'Playlists on your server', () => subsonic.playlists());
    root.append(g);
    return;
  }
  if (!state.library.length) {
    root.append(el(emptyState('folder', 'Your library is empty', 'Add the folders where you keep music. Hysh reads MP3, FLAC, M4A/AAC, OGG, Opus and WAV.', '<button class="btn primary" id="lib-add">Add a music folder</button>')));
    root.querySelector('#lib-add').onclick = () => go('settings', { section: 'library' });
    return;
  }
  if (tab === 'albums') { root.append(gridOf(local.albums().sort((a, b) => a.title.localeCompare(b.title)))); return; }
  if (tab === 'artists') { root.append(gridOf(local.artists())); return; }

  // songs: sortable, filterable, virtualized
  let sortKey = 'artist', dir = 1, filter = '';
  const bar = el(`<div style="display:flex;gap:10px;align-items:center;margin-bottom:12px">
    <input class="input" placeholder="Filter ${state.library.length} songs…" style="flex:1;max-width:360px">
    <span class="note">${fmtLong(totalDur(state.library))}</span></div>`);
  root.append(bar);
  const headRow = el(`<div class="tracks-head"><span></span><span></span><span data-s="title">Title</span><span data-s="album">Album</span><span data-s="duration" style="text-align:right">${icon('clock')}</span><span data-s="added" style="text-align:right">Added</span></div>`);
  root.append(headRow);
  const box = el('<div class="tracks"></div>');
  root.append(box);
  let vl;
  const draw = () => {
    const f = norm(filter);
    let list = state.library.filter((t) => !f || norm(`${t.title} ${t.artist} ${t.album}`).includes(f));
    const key = { artist: (t) => `${t.albumArtist} ${t.album} ${String(t.disc).padStart(2, '0')} ${String(t.trackNo).padStart(3, '0')}`.toLowerCase(), title: (t) => t.title.toLowerCase(), album: (t) => `${t.album} ${String(t.trackNo).padStart(3, '0')}`.toLowerCase(), duration: (t) => t.duration, added: (t) => -t.added }[sortKey];
    list = list.slice().sort((a, b) => { const x = key(a), y = key(b); return (x > y ? 1 : x < y ? -1 : 0) * dir; });
    vl?.destroy();
    vl = virtualList($('#main'), box, list, 56, (t, i) => trackRow(t, i, list, { context: { label: 'Your library' } }));
  };
  bar.querySelector('input').oninput = debounce((e) => { filter = e.target.value; draw(); }, 120);
  headRow.onclick = (e) => { const s = e.target.closest('[data-s]')?.dataset.s; if (!s) return; if (s === sortKey) dir = -dir; else { sortKey = s; dir = 1; } draw(); };
  draw();
  cleanups.push(() => vl?.destroy());
  cleanups.push(on('library', () => draw()));
};



// ===================== LIKED =====================
VIEWS.liked = async (root) => {
  const tracks = state.likes;
  root.append(el(heroHtml({ kind: 'Playlist', title: 'Liked songs', art: mosaicHtml(tracks, 'heart'), meta: `${tracks.length} songs · ${fmtLong(totalDur(tracks))}` })));
  if (!tracks.length) { root.append(el(emptyState('heart', 'Songs you like will appear here', 'Tap the heart on any song.'))); return; }
  root.append(actionsBar(tracks, { label: 'Liked songs' }));
  root.append(trackList(tracks, { showSource: true, context: { label: 'Liked songs' } }));
  cleanups.push(on('likes', () => go('liked', {}, { replace: true })));
};

// ===================== USER PLAYLIST =====================
VIEWS.playlist = async (root, { id }) => {
  const p = state.playlists.find((x) => x.id === id);
  if (!p) { root.append(el(emptyState('list', 'Playlist not found', 'It may have been deleted.'))); return; }
  const tracks = p.tracks;
  root.append(el(heroHtml({ kind: p.origin ? `Playlist · imported from ${p.origin}` : 'Playlist', title: p.name, art: p.cover ? img(p.cover, 'list') : mosaicHtml(tracks), fallback: 'list', meta: `${tracks.length} songs · ${fmtLong(totalDur(tracks))}`, desc: p.desc })));
  root.append(actionsBar(tracks, { label: p.name }, [
    { icon: 'edit', title: 'Rename', action: async () => { const n = await prompt('Rename playlist', 'New name', p.name); if (n) { updatePlaylist(id, { name: n }); go('playlist', { id }, { replace: true }); } } },
    { icon: 'trash', title: 'Delete', action: async () => { if (await confirmBox('Delete playlist?', `“${p.name}” will be removed. This cannot be undone.`, 'Delete')) { deletePlaylist(id); go('library', { tab: 'playlists' }, { replace: true }); } } },
  ]));
  if (!tracks.length) { root.append(el(emptyState('note', 'This playlist is empty', 'Right-click any song and choose “Add to playlist”.'))); return; }
  root.append(trackList(tracks, { showSource: true, context: { label: p.name }, menu: { playlistId: id, onRemove: () => go('playlist', { id }, { replace: true }) } }));
};

// ===================== REMOTE PLAYLIST =====================
VIEWS.rplaylist = async (root, { src, id }) => {
  root.append(el('<div class="spinner"></div>'));
  const r = src === 'subsonic' ? await subsonic.playlist(id) : await deezer.playlist(id);
  if (!alive()) return;
  root.innerHTML = '';
  const p = r.playlist;
  root.append(el(heroHtml({ kind: `Playlist · ${SOURCE_LABEL[src]}`, title: p.title, cover: p.cover, fallback: 'list', meta: `${esc(p.owner || '')} · ${r.tracks.length} songs · ${fmtLong(totalDur(r.tracks))}${p.fans ? ' · ' + fmtNum(p.fans) + ' fans' : ''}`, desc: p.desc })));
  root.append(actionsBar(r.tracks, { label: p.title }, [{ icon: 'download', title: 'Save to your playlists', action: () => { createPlaylist(p.title, r.tracks, { cover: p.cover, origin: SOURCE_LABEL[src] }); toast('Saved to your playlists'); } }]));
  root.append(trackList(r.tracks, { context: { label: p.title } }));
};

// ===================== ALBUM =====================
VIEWS.album = async (root, { src, id, key }) => {
  root.append(el('<div class="spinner"></div>'));
  let album, tracks;
  if (src === 'local') {
    const a = local.albums().find((x) => x.id === 'lal:' + key);
    if (!a) { root.innerHTML = emptyState('disc', 'Album not found', ''); return; }
    album = a; tracks = a.tracks.slice().sort((x, y) => (x.disc - y.disc) || (x.trackNo - y.trackNo));
  } else {
    const r = src === 'deezer' ? await deezer.album(id) : src === 'archive' ? await archive.item(id) : src === 'subsonic' ? await subsonic.album(id) : await apple.album(id);
    album = r.album; tracks = r.tracks;
  }
  if (!alive()) return;
  root.innerHTML = '';
  const meta = [`<a class="link" data-artist>${esc(album.artist || '')}</a>`, album.year, `${tracks.length} songs`, fmtLong(totalDur(tracks)), album.label].filter(Boolean).join(' · ');
  root.append(el(heroHtml({ kind: album.type === 'single' ? 'Single' : album.type === 'ep' ? 'EP' : 'Album', title: album.title, cover: album.cover, meta, desc: album.desc })));
  root.querySelector('[data-artist]').onclick = () => openArtist({ ...album, ...(tracks[0] || {}), artist: album.artist });
  root.append(actionsBar(tracks, { label: album.title }));
  root.append(trackList(tracks, { noCover: src !== 'archive' && src !== 'apple', context: { label: album.title } }));
  if (src === 'deezer' && album.artistId) lazyShelf(root, `More by ${album.artist}`, async () => (await deezer.artist(album.artistId)).albums.filter((a) => a.dzId !== album.dzId).slice(0, 16));
  if (album.genres?.length) root.append(el(`<div class="note" style="margin-top:20px">${esc(album.genres.join(' · '))}</div>`));
};

// ===================== ARTIST =====================
VIEWS.artist = async (root, { src, id, name }) => {
  root.append(el('<div class="spinner"></div>'));
  if (src === 'local') {
    const a = local.artists().find((x) => norm(x.name) === norm(name));
    root.innerHTML = '';
    if (!a) { root.append(el(emptyState('user', 'Artist not found', ''))); return; }
    root.append(el(heroHtml({ kind: 'Artist · your library', title: a.name, cover: a.cover, round: true, fallback: 'user', meta: `${a.tracks.length} songs` })));
    root.append(actionsBar(a.tracks, { label: a.name }, [{ icon: 'radio', title: 'Artist radio', action: async () => playList([a.tracks[0], ...(await radioFor(a.tracks[0]))], 0, { label: `${a.name} radio` }) }]));
    root.append(shelf('Albums', local.albums().filter((x) => norm(x.artist) === norm(a.name))));
    root.append(shelf('Songs', a.tracks, { tracks: true }));
    const dz = await deezer.findArtist(a.name).catch(() => null);
    if (dz && alive()) root.append(shelf('Discover more on Deezer', [dz]));
    aboutSection(root, a.name);
    return;
  }
  if (src === 'subsonic') {
    const r = await subsonic.artist(id);
    if (!alive()) return;
    root.innerHTML = '';
    root.append(el(heroHtml({ kind: 'Artist · your server', title: r.artist.name, cover: r.artist.cover, round: true, fallback: 'user', meta: `${r.albums.length} albums` })));
    root.append(shelf('Albums', r.albums, { grid: true }));
    aboutSection(root, r.artist.name);
    return;
  }
  const r = await deezer.artist(id);
  if (!alive()) return;
  root.innerHTML = '';
  const a = r.artist;
  root.append(el(heroHtml({ kind: 'Artist', title: a.name, cover: a.cover, round: true, fallback: 'user', meta: `${fmtNum(a.fans || 0)} fans${a.albumsCount ? ' · ' + a.albumsCount + ' releases' : ''}` })));
  root.append(actionsBar(r.top, { label: a.name }, [{ icon: 'radio', title: 'Artist radio', action: async () => { toast('Starting radio…'); playList(await deezer.artistRadio(a.dzId), 0, { label: `${a.name} radio` }); } }]));
  root.append(shelf('Popular', r.top.slice(0, 10), { tracks: true, listOpts: { context: { label: a.name } } }));
  const mine = state.library.filter((t) => norm(t.artist).includes(norm(a.name)));
  if (mine.length) root.append(shelf('In your library', mine.slice(0, 8), { tracks: true }));
  const albums = r.albums.filter((x) => x.type === 'album');
  const singles = r.albums.filter((x) => x.type !== 'album');
  if (albums.length) root.append(shelf('Albums', albums));
  if (singles.length) root.append(shelf('Singles & EPs', singles));
  if (r.related.length) root.append(shelf('Similar artists', r.related));
  aboutSection(root, a.name);
};

function aboutSection(root, name) {
  const sec = el(`<section class="shelf"><div class="shelf-head"><h2 class="shelf-title">About</h2></div><div class="note">Loading…</div></section>`);
  root.append(sec);
  artistInfo(name).then((info) => {
    if (!info) return sec.remove();
    sec.querySelector('.note').outerHTML = `<div style="display:flex;gap:20px;align-items:flex-start;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px">
      ${info.image ? `<img src="${esc(info.image)}" style="width:160px;height:160px;object-fit:cover;border-radius:12px" alt="">` : ''}
      <div style="user-select:text"><p style="margin:0 0 10px;color:var(--text-2);line-height:1.65">${esc(info.text)}</p><span class="note">Source: ${esc(info.source)}</span></div></div>`;
  }).catch(() => sec.remove());
}

// ===================== RADIO =====================
VIEWS.radio = async (root, { tag = '' }) => {
  root.append(el('<h1 class="page">Radio</h1>'));
  const bar = el(`<div style="display:flex;gap:10px;margin-bottom:16px"><input class="input" placeholder="Find a station by name…" style="flex:1;max-width:420px"></div>`);
  root.append(bar);
  bar.querySelector('input').onkeydown = (e) => { if (e.key === 'Enter' && e.target.value.trim()) go('search', { q: e.target.value.trim(), tab: 'radio' }); };
  const chips = el('<div class="chips"></div>');
  root.append(chips);
  radio.tags().then((tags) => {
    chips.innerHTML = [`<button class="chip ${!tag ? 'active' : ''}" data-t="">Top</button>`, ...tags.slice(0, 24).map((t) => `<button class="chip ${t === tag ? 'active' : ''}" data-t="${esc(t)}">${esc(t)}</button>`)].join('');
  }).catch(() => {});
  chips.onclick = (e) => { if (e.target.dataset.t != null) go('radio', { tag: e.target.dataset.t }, { replace: true }); };
  if (tag) lazyShelf(root, tag, () => radio.byTag(tag, 60), { grid: true });
  else {
    lazyShelf(root, 'Most loved stations', () => radio.top(40), { grid: true });
    lazyShelf(root, `Stations in ${state.settings.country}`, () => radio.byCountry(state.settings.country, 30));
  }
};

// ===================== STATS ("your year in music") =====================
VIEWS.stats = async (root) => {
  root.append(el('<h1 class="page">Stats</h1>'));
  const stats = Object.values(state.stats);
  if (!stats.length) { root.append(el(emptyState('chart', 'No listening yet', 'Play some music and your stats will appear here.'))); return; }
  const totalSecs = stats.reduce((s, x) => s + x.secs, 0);
  const totalPlays = stats.reduce((s, x) => s + x.plays, 0);
  const artists = new Map();
  for (const s of stats) {
    const n = (s.t.artist || 'Unknown').split(',')[0].trim();
    const a = artists.get(n) || { name: n, plays: 0, secs: 0, t: s.t };
    a.plays += s.plays; a.secs += s.secs; artists.set(n, a);
  }
  const topArtists = [...artists.values()].sort((a, b) => b.secs - a.secs || b.plays - a.plays).slice(0, 10);
  const topTracks = stats.slice().sort((a, b) => b.plays - a.plays || b.secs - a.secs).slice(0, 15);
  const sources = new Map();
  for (const s of stats) sources.set(s.t.source, (sources.get(s.t.source) || 0) + s.plays);
  root.append(el(`<div class="stat-grid">
    <div class="stat"><b>${fmtLong(totalSecs)}</b><span>listened</span></div>
    <div class="stat"><b>${fmtNum(totalPlays)}</b><span>plays</span></div>
    <div class="stat"><b>${fmtNum(stats.length)}</b><span>different songs</span></div>
    <div class="stat"><b>${fmtNum(artists.size)}</b><span>artists</span></div>
    ${[...sources.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `<div class="stat"><b>${fmtNum(v)}</b><span>plays from ${esc(SOURCE_LABEL[k] || k)}</span></div>`).join('')}
  </div>`));
  const maxA = topArtists[0]?.secs || 1;
  const sa = el(`<section class="shelf"><div class="shelf-head"><h2 class="shelf-title">Top artists</h2></div><div class="bars"></div></section>`);
  topArtists.forEach((a, i) => {
    const row = el(`<div class="bar-row"><span class="rank">${i + 1}</span><div class="cov">${img(coverOf(a.t), 'user')}</div>
      <div><span class="name">${esc(a.name)}</span><div class="barbg"><div class="barfg" style="width:${(a.secs / maxA) * 100}%"></div></div></div><span class="note" style="text-align:right">${fmtLong(a.secs)}</span></div>`);
    row.querySelector('.name').onclick = () => openArtist(a.t);
    sa.querySelector('.bars').append(row);
  });
  root.append(sa);
  const tracks = topTracks.map((s) => s.t);
  const st = shelf('Top songs', tracks, { tracks: true, listOpts: { context: { label: 'Your top songs' } } });
  st.querySelectorAll('.tr .d').forEach((d, i) => (d.textContent = `${topTracks[i].plays}×`));
  root.append(st);
  const recent = el(`<section class="shelf"><div class="shelf-head"><h2 class="shelf-title">Recently played</h2><button class="link">Clear history</button></div></section>`);
  recent.querySelector('.link').onclick = async () => { if (await confirmBox('Clear history?', 'Recently played will be emptied. Your stats stay.', 'Clear')) { clearHistory(); go('stats', {}, { replace: true }); } };
  const hist = state.history.slice(0, 50).map((h) => h.t);
  recent.append(trackList(hist, { showSource: true, numbers: false }));
  root.append(recent);
};

// ===================== DOWNLOADS =====================
const JOB_LABEL = { queued: 'Waiting', active: 'Downloading…', done: 'Done', error: 'Failed' };
VIEWS.downloads = async (root) => {
  const dir = state.settings.download_dir || env.downloadDir;
  const head = el(`<div class="page-head"><h1 class="page">Downloads</h1>
    <div class="page-actions"><button class="btn" data-a="likes">${icon('heart')}Download liked songs</button>
    <button class="btn" data-a="folder">${icon('folder')}Open folder</button><button class="btn" data-a="clear">Clear finished</button></div></div>`);
  head.querySelector('[data-a=likes]').onclick = () => enqueue(state.likes, { label: 'from Liked songs' });
  head.querySelector('[data-a=folder]').onclick = () => invoke('open_path', { path: dir });
  head.querySelector('[data-a=clear]').onclick = clearFinished;
  root.append(head, el(`<p class="note">Saved to ${esc(dir)} · ${state.settings.download_format === 'best' ? 'best quality (Opus)' : 'M4A with tags and cover art'} · change this in Settings › Downloads</p>`));
  const queueBox = el('<section class="shelf"></section>');
  const doneBox = el('<section class="shelf"></section>');
  root.append(queueBox, doneBox);
  const draw = () => {
    queueBox.innerHTML = '';
    if (jobs.length) {
      queueBox.append(el(`<div class="shelf-head"><h2 class="shelf-title">Queue</h2><span class="sub">${jobs.filter((j) => j.status === 'done').length} of ${jobs.length} done</span></div>`));
      const list = el('<div class="jobs"></div>');
      for (const j of jobs) {
        const row = el(`<div class="job ${j.status}"><div class="cov">${img(coverOf(j.t), 'note')}</div>
          <div class="main"><div class="tt">${esc(j.t.title)}</div><div class="ta">${esc(j.error || j.t.artist || '')}</div></div>
          <span class="job-status">${j.status === 'active' ? '<span class="mini-spin"></span>' : ''}${JOB_LABEL[j.status]}</span>
          ${j.status === 'error' ? `<button class="btn small" data-retry>Retry</button>` : ''}</div>`);
        row.querySelector('[data-retry]')?.addEventListener('click', () => retry(j.key));
        list.append(row);
      }
      queueBox.append(list);
    }
    const done = Object.values(state.downloads).sort((a, b) => b.at - a.at).map((d) => d.t);
    doneBox.innerHTML = '';
    doneBox.append(el(`<div class="shelf-head"><h2 class="shelf-title">On this PC</h2><span class="sub">${done.length} songs, play offline</span></div>`));
    doneBox.append(done.length ? trackList(done, { showSource: true, context: { label: 'Downloads' } })
      : el(emptyState('download', 'No downloads yet', 'Use the download button on any song, album or playlist.')));
  };
  draw();
  cleanups.push(on('downloads', draw));
};

VIEWS.settings = renderSettings;
