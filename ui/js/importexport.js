// Hysh - import & export. GPL-3.0-or-later
//
// Import:  links (Spotify, Deezer, YouTube, SoundCloud, Bandcamp), your Spotify account
//          (Liked Songs + playlists), M3U / M3U8 / PLS files, CSV (Exportify, TuneMyMusic,
//          Soundiiz and similar), Last.fm loved tracks, Hysh backups.
// Export:  M3U8 (for other players), CSV (re-importable by Hysh, TuneMyMusic, Soundiiz...),
//          full JSON backup.
// Parsers are pure functions; only the bottom of the file touches the UI.
import { invoke, http, dialog } from './api.js';
import { state, createPlaylist, addLikes, backupData, mergeBackup, downloadedPath } from './store.js';
import { importPlaylist, spotifyApi, spTrack, looksLikeUrl, watchUrl } from './sources.js';
import { esc, icon, modal, toast } from './ui.js';

// =============================== parsers ===============================

/** RFC 4180 CSV with auto-detected delimiter (, ; or tab). Returns rows of cells. */
export function parseCsv(text) {
  const firstLine = text.slice(0, text.indexOf('\n') >>> 0);
  const delim = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const COLUMNS = {
  title: ['track name', 'track', 'title', 'name', 'song', 'song name', 'track title'],
  artist: ['artist name(s)', 'artist name', 'artist', 'artists', 'artist(s)', 'album artist'],
  album: ['album name', 'album', 'album title', 'release'],
  duration: ['duration (ms)', 'duration_ms', 'duration', 'length'],
  isrc: ['isrc'],
  link: ['link', 'url', 'spotify uri', 'track uri'],
};

/** CSV from Exportify, TuneMyMusic, Soundiiz, Hysh... into tracks (resolved when played). */
export function csvToTracks(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (k) => head.findIndex((h) => COLUMNS[k].includes(h));
  const ix = Object.fromEntries(Object.keys(COLUMNS).map((k) => [k, col(k)]));
  if (ix.title < 0) throw new Error('No title column found (expected e.g. “Track Name” or “Title”)');
  return rows.slice(1).map((r, n) => {
    const get = (k) => (ix[k] >= 0 ? (r[ix[k]] || '').trim() : '');
    const rawDur = get('duration');
    const dur = /^\d+$/.test(rawDur) ? Number(rawDur) / (Number(rawDur) > 10000 ? 1000 : 1) : rawDur.includes(':') ? rawDur.split(':').reduce((a, b) => a * 60 + Number(b), 0) : 0;
    const title = get('title');
    const artist = get('artist').replace(/\s*;\s*/g, ', ');
    const link = get('link');
    const base = { id: `imp:${title}|${artist}|${n}`.toLowerCase(), source: 'import', title, artist, album: get('album'), duration: dur || 0, isrc: get('isrc') || undefined };
    const sp = link.match(/(?:spotify:track:|open\.spotify\.com\/track\/)([A-Za-z0-9]+)/);
    if (sp) return { ...base, id: 'sp:' + sp[1], source: 'spotify' };
    if (looksLikeUrl(link) && !/spotify/.test(link)) return { ...base, ...linkTrack(link, base) };
    return base;
  }).filter((t) => t.title);
}

function linkTrack(url, base = {}) {
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|music\.youtube\.com\/watch\?v=)([\w-]{11})/);
  if (yt) return { ...base, id: 'yt:' + yt[1], source: 'youtube', videoId: yt[1] };
  if (/soundcloud\.com|bandcamp\.com/.test(url)) return { ...base, id: 'url:' + url, source: /soundcloud/.test(url) ? 'soundcloud' : 'bandcamp', pageUrl: url };
  return { ...base, id: 'stream:' + url, source: 'stream', stream: url, live: !base.duration };
}

function trackFromPath(path, title, artist, duration) {
  const known = state.library.find((t) => t.path.toLowerCase() === path.toLowerCase());
  if (known) return known;
  const stem = path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  const [a, b] = stem.includes(' - ') ? stem.split(' - ', 2) : ['', stem];
  return { id: 'local:' + path, source: 'local', path, title: title || b, artist: artist || a || 'Unknown Artist', album: '', duration: duration || 0 };
}

const isAbsolute = (p) => /^[a-zA-Z]:[\\/]|^\\\\/.test(p);
const joinPath = (dir, rel) => (dir ? dir.replace(/[\\/]+$/, '') + '\\' + rel.replace(/\//g, '\\') : rel);

/** M3U / M3U8 (with #EXTINF), relative paths resolved against the playlist's folder. */
export function m3uToTracks(text, baseDir = '') {
  const out = [];
  let info = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const m = line.match(/^#EXTINF:(-?\d+(?:\.\d+)?)[^,]*,(.*)$/);
      if (m) {
        const [artist, title] = m[2].includes(' - ') ? m[2].split(' - ', 2) : ['', m[2]];
        info = { duration: Math.max(0, Number(m[1])), artist: artist.trim(), title: title.trim() };
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    if (/^https?:\/\//i.test(line)) out.push(linkTrack(line, { title: info?.title || line, artist: info?.artist || '', album: '', duration: info?.duration || 0 }));
    else {
      const path = decodeURIComponent(line.replace(/^file:\/\/\/?/i, ''));
      out.push(trackFromPath(isAbsolute(path) ? path : joinPath(baseDir, path), info?.title, info?.artist, info?.duration));
    }
    info = null;
  }
  return out;
}

/** PLS playlists (internet radio and players like Winamp). */
export function plsToTracks(text, baseDir = '') {
  const entries = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(File|Title|Length)(\d+)=(.*)$/i);
    if (m) (entries[m[2]] ||= {})[m[1].toLowerCase()] = m[3].trim();
  }
  return Object.keys(entries).sort((a, b) => a - b).map((k) => {
    const e = entries[k];
    if (!e.file) return null;
    const duration = Math.max(0, Number(e.length) || 0);
    if (/^https?:\/\//i.test(e.file)) return linkTrack(e.file, { title: e.title || e.file, artist: '', album: '', duration });
    return trackFromPath(isAbsolute(e.file) ? e.file : joinPath(baseDir, e.file), e.title, '', duration);
  }).filter(Boolean);
}

// =============================== services ===============================

/** Your Spotify Liked Songs (needs "Connect Spotify"). */
export async function spotifyLiked(onProgress) {
  const out = [];
  let next = 'https://api.spotify.com/v1/me/tracks?limit=50';
  while (next) {
    const page = await spotifyApi(next, { user: true });
    for (const it of page.items || []) if (it.track?.name) out.push(spTrack(it.track));
    onProgress?.(out.length, page.total);
    next = page.next;
  }
  return out;
}

export async function spotifyPlaylists() {
  const out = [];
  let next = 'https://api.spotify.com/v1/me/playlists?limit=50';
  while (next) {
    const page = await spotifyApi(next, { user: true });
    for (const p of page.items || []) if (p) out.push({ id: p.id, name: p.name, count: p.tracks?.total || 0, cover: p.images?.[0]?.url || '' });
    next = page.next;
  }
  return out;
}

/** Last.fm loved tracks of any public profile. */
export async function lastfmLoved(user) {
  const key = state.settings.lastfm_api_key;
  if (!key) throw new Error('Add a Last.fm API key in Settings › Scrobbling first');
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const r = await http(`https://ws.audioscrobbler.com/2.0/?method=user.getlovedtracks&user=${encodeURIComponent(user)}&api_key=${key}&format=json&limit=200&page=${page}`);
    const list = r.lovedtracks?.track || [];
    for (const t of list) {
      out.push({ id: `lfm:${t.name}|${t.artist?.name}`.toLowerCase(), source: 'import', title: t.name, artist: t.artist?.name || '', album: '', duration: 0, cover: '' });
    }
    if (page >= Number(r.lovedtracks?.['@attr']?.totalPages || 1)) break;
  }
  return out;
}

// =============================== export ===============================

function locationOf(t) {
  if (t.source === 'local') return t.path;
  const offline = downloadedPath(t);
  if (offline) return offline;
  if (t.videoId) return watchUrl(t.videoId);
  return t.pageUrl || t.stream || '';
}

export function toM3U(tracks) {
  const lines = ['#EXTM3U'];
  for (const t of tracks) {
    const loc = locationOf(t);
    const label = `${t.artist ? t.artist + ' - ' : ''}${t.title}`;
    if (!loc) { lines.push(`# not available as a file or link: ${label}`); continue; }
    lines.push(`#EXTINF:${Math.round(t.duration || -1)},${label}`, loc);
  }
  return lines.join('\r\n') + '\r\n';
}

const csvCell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function toCsv(tracks) {
  const head = ['Track Name', 'Artist Name(s)', 'Album Name', 'Duration (ms)', 'ISRC', 'Source', 'Link'];
  const rows = tracks.map((t) => [
    t.title, t.artist, t.album, Math.round((t.duration || 0) * 1000), t.isrc || '', t.source,
    t.source === 'spotify' && t.id.startsWith('sp:') && !t.id.includes('-') ? `https://open.spotify.com/track/${t.id.slice(3)}` : locationOf(t),
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

async function saveText(defaultName, contents, filterName, extensions) {
  const path = await dialog.save({ defaultPath: defaultName, filters: [{ name: filterName, extensions }] });
  if (!path) return null;
  await invoke('write_text_file', { path, contents });
  return path;
}

const safeFileName = (s) => String(s || 'playlist').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120);

export async function exportTracks(tracks, name, format) {
  const ok = format === 'csv'
    ? await saveText(`${safeFileName(name)}.csv`, toCsv(tracks), 'CSV', ['csv'])
    : await saveText(`${safeFileName(name)}.m3u8`, toM3U(tracks), 'M3U8 playlist', ['m3u8', 'm3u']);
  if (ok) toast(`Exported ${tracks.length} songs to ${ok}`, false, 4500);
}

export async function exportBackup() {
  const stamp = new Date().toISOString().slice(0, 10);
  const ok = await saveText(`hysh-backup-${stamp}.json`, JSON.stringify(backupData(), null, 1), 'Hysh backup', ['json']);
  if (ok) toast('Backup saved: likes, playlists, history, stats and preferences (no passwords or tokens)', false, 5000);
}

// =============================== UI ===============================

async function pickFile(filters) {
  const path = await dialog.open({ multiple: false, directory: false, filters });
  return typeof path === 'string' ? path : null;
}

async function importFile() {
  const path = await pickFile([{ name: 'Playlists and lists', extensions: ['m3u', 'm3u8', 'pls', 'csv', 'txt', 'json'] }]);
  if (!path) return;
  const text = await invoke('read_text_file', { path });
  const fileName = path.split(/[\\/]/).pop();
  const baseDir = path.slice(0, path.length - fileName.length);
  const ext = fileName.split('.').pop().toLowerCase();
  if (ext === 'json') return restoreFrom(text);
  const tracks = ext === 'csv' || ext === 'txt' ? csvToTracks(text) : ext === 'pls' ? plsToTracks(text, baseDir) : m3uToTracks(text, baseDir);
  if (!tracks.length) throw new Error('No songs found in that file');
  return { name: fileName.replace(/\.[^.]+$/, ''), tracks, origin: ext.toUpperCase() };
}

function restoreFrom(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('That is not a valid JSON file'); }
  const r = mergeBackup(data);
  toast(`Restored ${r.likes} likes, ${r.playlists} playlists and ${r.history} history entries`, false, 5000);
  return null;
}

async function chooseSpotifyPlaylists() {
  const lists = await spotifyPlaylists();
  if (!lists.length) throw new Error('No playlists on this Spotify account');
  const picked = await modal(`<h3>Spotify playlists</h3><p>Choose which to import.</p>
    <div style="max-height:340px;overflow:auto;margin-bottom:8px">${lists.map((p, i) => `<label class="mi"><input type="checkbox" data-i="${i}" checked> <span>${esc(p.name)}</span><span style="margin-left:auto;color:var(--text-3)">${p.count}</span></label>`).join('')}</div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="spok">Import</button></div>`,
  (card, done) => { card.querySelector('#spok').onclick = () => done([...card.querySelectorAll('input:checked')].map((c) => lists[c.dataset.i])); });
  if (!picked?.length) return;
  for (const p of picked) {
    toast(`Importing “${p.name}”…`);
    const r = await importPlaylist(`https://open.spotify.com/playlist/${p.id}`);
    createPlaylist(r.name, r.tracks, { cover: r.cover || p.cover, origin: 'Spotify' });
  }
  toast(`Imported ${picked.length} playlist${picked.length > 1 ? 's' : ''}`);
}

/** One dialog for every import source. Returns the created playlist (if any). */
export async function openImportDialog() {
  const spotifyReady = !!state.settings.spotify_user;
  const choice = await modal(`<h3>Import</h3><p>Bring your music in from anywhere. Songs are matched to your sources when you play them.</p>
    <div style="display:flex;flex-direction:column;gap:2px;margin-bottom:8px">
      <button class="mi" data-c="link">${icon('link')}<span>Paste a link</span><span class="note" style="margin-left:auto">Spotify · Deezer · YouTube · SoundCloud · Bandcamp</span></button>
      <button class="mi" data-c="sp-liked">${icon('heart')}<span>Spotify Liked Songs</span><span class="note" style="margin-left:auto">${spotifyReady ? esc(state.settings.spotify_user) : 'connect first'}</span></button>
      <button class="mi" data-c="sp-lists">${icon('list')}<span>Spotify playlists</span><span class="note" style="margin-left:auto">${spotifyReady ? 'choose' : 'connect first'}</span></button>
      <button class="mi" data-c="file">${icon('folder')}<span>File</span><span class="note" style="margin-left:auto">M3U · M3U8 · PLS · CSV · backup</span></button>
      <button class="mi" data-c="lastfm">${icon('heart')}<span>Last.fm loved tracks</span></button>
    </div><div class="modal-actions"><button class="btn" data-close>Close</button></div>`,
  (card, done) => card.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => done(b.dataset.c))));
  if (!choice) return null;
  try {
    let result = null;
    if ((choice === 'sp-liked' || choice === 'sp-lists') && !spotifyReady) {
      toast('Connect Spotify first: Settings › Sources › Spotify', true, 5000);
      return null;
    }
    if (choice === 'link') {
      const url = await modal(`<h3>Paste a link</h3><p>A playlist, album or song from Spotify, Deezer, YouTube, SoundCloud or Bandcamp.</p><input class="input" id="lnk" placeholder="https://…">
        <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="lok">Import</button></div>`,
      (card, done) => { const i = card.querySelector('#lnk'); card.querySelector('#lok').onclick = () => done(i.value.trim()); i.onkeydown = (e) => e.key === 'Enter' && done(i.value.trim()); });
      if (!url) return null;
      toast('Importing…');
      result = await importPlaylist(url);
    } else if (choice === 'sp-liked') {
      toast('Reading your Spotify Liked Songs…');
      const tracks = await spotifyLiked((n, total) => n % 500 === 0 && toast(`Read ${n} of ${total}…`));
      const added = addLikes(tracks);
      toast(`Added ${added} songs to Liked songs (${tracks.length - added} were already there)`, false, 5000);
      return null;
    } else if (choice === 'sp-lists') {
      await chooseSpotifyPlaylists();
      return null;
    } else if (choice === 'file') {
      result = await importFile();
    } else if (choice === 'lastfm') {
      const user = state.settings.lastfm_user || (await modal(`<h3>Last.fm user</h3><input class="input" id="lu" placeholder="username"><div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="lok">Import</button></div>`,
        (card, done) => { card.querySelector('#lok').onclick = () => done(card.querySelector('#lu').value.trim()); }));
      if (!user) return null;
      const tracks = await lastfmLoved(user);
      const added = addLikes(tracks);
      toast(`Added ${added} loved tracks to Liked songs`);
      return null;
    }
    if (!result) return null;
    const p = createPlaylist(result.name, result.tracks, { cover: result.cover || '', origin: result.origin });
    toast(`Imported “${result.name}” · ${result.tracks.length} songs`);
    return p;
  } catch (e) {
    toast(e.message || String(e), true, 6000);
    return null;
  }
}

export async function openRestore() {
  const path = await pickFile([{ name: 'Hysh backup', extensions: ['json'] }]);
  if (!path) return;
  try { restoreFrom(await invoke('read_text_file', { path })); } catch (e) { toast(e.message || String(e), true); }
}

