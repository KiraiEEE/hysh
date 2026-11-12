// Hysh - catalogs & sources. GPL-3.0-or-later
// Deezer (catalog, charts, artist radio), Apple Music charts + iTunes Search,
// Radio Browser (internet radio), Internet Archive, Jamendo, Subsonic / Navidrome servers,
// YouTube (through the user's yt-dlp), local files, Spotify / Deezer playlist import,
// Wikipedia + Last.fm artist info, SponsorBlock.
import { http, invoke, media, qs } from './api.js';
import { state, downloadedPath, patchTrackArt } from './store.js';
import { toast } from './ui.js';

const enc = encodeURIComponent;
export const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/\(.*?\)|\[.*?\]/g, '').replace(/feat\..*|ft\..*/g, '').replace(/[^a-z0-9Ѐ-ӿ぀-ヿ一-鿿]+/g, ' ').trim();

export function coverOf(t, big = false) {
  if (!t) return null;
  if (t.cover) return big && t.coverXL ? t.coverXL : t.cover;
  if (t.source === 'local' && t.path) return media.cover(t.path);
  return null;
}
/** CORS-safe version for canvas colour extraction */
export function coverForCanvas(t) {
  const c = coverOf(t);
  if (!c) return null;
  return c.startsWith('http://127.0.0.1') ? c : media.proxy(c);
}

export const SOURCE_LABEL = {
  local: 'Local', deezer: 'Deezer', apple: 'Apple', itunes: 'iTunes', radio: 'Radio', archive: 'Archive',
  jamendo: 'Jamendo', subsonic: 'Server', youtube: 'YouTube', spotify: 'Spotify',
  soundcloud: 'SoundCloud', bandcamp: 'Bandcamp', web: 'Web', stream: 'Stream', import: 'Imported',
};

// =============== Deezer ===============
const DZ = 'https://api.deezer.com';
async function dz(path) {
  const r = await http(DZ + path);
  if (r && r.error) throw new Error(`Deezer: ${r.error.message || r.error.type}`);
  return r;
}
const dzTrack = (t, album) => ({
  id: 'dz:' + t.id, source: 'deezer', dzId: t.id,
  title: t.title_short || t.title, artist: t.artist?.name || album?.artist?.name || '',
  artistId: t.artist?.id || album?.artist?.id, album: t.album?.title || album?.title || '', albumId: t.album?.id || album?.id,
  duration: t.duration || 0, explicit: !!t.explicit_lyrics,
  cover: t.album?.cover_medium || album?.cover_medium || '', coverXL: t.album?.cover_xl || album?.cover_xl || t.album?.cover_big || album?.cover_big,
  isrc: t.isrc,
});
const dzAlbum = (a) => ({ kind: 'album', id: 'dz:' + a.id, source: 'deezer', dzId: a.id, title: a.title, artist: a.artist?.name || '', artistId: a.artist?.id, cover: a.cover_medium || a.cover_big, year: (a.release_date || '').slice(0, 4), type: a.record_type });
const dzArtist = (a) => ({ kind: 'artist', id: 'dz:' + a.id, source: 'deezer', dzId: a.id, name: a.name, cover: a.picture_medium || a.picture_big, fans: a.nb_fan });
const dzPlaylist = (p) => ({ kind: 'playlist', id: 'dz:' + p.id, source: 'deezer', dzId: p.id, title: p.title, owner: p.user?.name || p.creator?.name || 'Deezer', cover: p.picture_medium || p.picture_big, count: p.nb_tracks });

let chartMemo = null;
export const deezer = {
  chart() {
    if (!chartMemo || Date.now() - chartMemo.at > 10 * 60_000) chartMemo = { at: Date.now(), p: this._chart() };
    chartMemo.p.catch(() => (chartMemo = null));
    return chartMemo.p;
  },
  async _chart() {
    const c = await dz('/chart/0?limit=30');
    return {
      tracks: (c.tracks?.data || []).map((t) => dzTrack(t)),
      albums: (c.albums?.data || []).map(dzAlbum),
      artists: (c.artists?.data || []).map(dzArtist),
      playlists: (c.playlists?.data || []).map(dzPlaylist),
    };
  },
  async search(q, type = 'track', limit = 30) {
    const path = type === 'track' ? '/search' : `/search/${type}`;
    const r = await dz(`${path}?q=${enc(q)}&limit=${limit}`);
    const map = { track: (t) => dzTrack(t), album: dzAlbum, artist: dzArtist, playlist: dzPlaylist };
    return (r.data || []).map(map[type]);
  },
  async album(id) {
    const a = await dz(`/album/${id}`);
    return {
      album: { ...dzAlbum(a), label: a.label, fans: a.fans, duration: a.duration, genres: (a.genres?.data || []).map((g) => g.name), cover: a.cover_xl || a.cover_big },
      tracks: (a.tracks?.data || []).map((t) => dzTrack(t, a)),
    };
  },
  async artist(id) {
    const [a, top, albums, related] = await Promise.all([
      dz(`/artist/${id}`), dz(`/artist/${id}/top?limit=20`), dz(`/artist/${id}/albums?limit=60`), dz(`/artist/${id}/related?limit=16`).catch(() => ({ data: [] })),
    ]);
    return {
      artist: { ...dzArtist(a), cover: a.picture_xl || a.picture_big, albumsCount: a.nb_album },
      top: (top.data || []).map((t) => dzTrack(t)),
      albums: (albums.data || []).map((x) => ({ ...dzAlbum(x), artist: a.name, artistId: a.id })),
      related: (related.data || []).map(dzArtist),
    };
  },
  async playlist(id) {
    const p = await dz(`/playlist/${id}`);
    let tracks = (p.tracks?.data || []).map((t) => dzTrack(t));
    let next = p.tracks?.next;
    while (next && tracks.length < 1000) {
      const more = await http(next);
      tracks = tracks.concat((more.data || []).map((t) => dzTrack(t)));
      next = more.next;
    }
    return { playlist: { ...dzPlaylist(p), desc: p.description, cover: p.picture_xl || p.picture_big, duration: p.duration, fans: p.fans }, tracks };
  },
  async genres() {
    const r = await dz('/genre');
    return (r.data || []).filter((g) => g.id !== 0).map((g) => ({ id: g.id, name: g.name, cover: g.picture_medium }));
  },
  async genreArtists(id) {
    const r = await dz(`/genre/${id}/artists`);
    return (r.data || []).map(dzArtist);
  },
  async artistRadio(id) {
    const r = await dz(`/artist/${id}/radio?limit=40`);
    return (r.data || []).map((t) => dzTrack(t));
  },
  async findArtist(name) {
    const r = await dz(`/search/artist?q=${enc(name)}&limit=1`);
    return r.data?.[0] ? dzArtist(r.data[0]) : null;
  },
  async findTrack(title, artist) {
    const r = await dz(`/search?q=${enc(`track:"${title}" artist:"${artist}"`)}&limit=5`).catch(() => null);
    const list = r?.data?.length ? r.data : (await dz(`/search?q=${enc(`${title} ${artist}`)}&limit=5`)).data || [];
    return list[0] ? dzTrack(list[0]) : null;
  },
  async newReleases() {
    const r = await dz('/editorial/0/releases?limit=30');
    return (r.data || []).map(dzAlbum);
  },
};

// =============== Apple Music charts + iTunes Search ===============
export const apple = {
  async top(country = 'US', limit = 50) {
    const r = await http(`https://rss.applemarketingtools.com/api/v2/${country.toLowerCase()}/music/most-played/${limit}/songs.json`);
    return (r.feed?.results || []).map((s) => ({
      id: 'am:' + s.id, source: 'apple', title: s.name, artist: s.artistName, album: '', duration: 0,
      cover: (s.artworkUrl100 || '').replace('100x100', '300x300'), coverXL: (s.artworkUrl100 || '').replace('100x100', '1000x1000'), url: s.url,
    }));
  },
  async topAlbums(country = 'US', limit = 30) {
    const r = await http(`https://rss.applemarketingtools.com/api/v2/${country.toLowerCase()}/music/most-played/${limit}/albums.json`);
    return (r.feed?.results || []).map((a) => ({ kind: 'album', id: 'am:' + a.id, source: 'apple', title: a.name, artist: a.artistName, cover: (a.artworkUrl100 || '').replace('100x100', '300x300'), amId: a.id }));
  },
  async search(q, limit = 30) {
    const r = await http(`https://itunes.apple.com/search?${qs({ term: q, entity: 'song', limit, country: state.settings.country || 'US' })}`);
    return (r.results || []).map(itTrack);
  },
  async album(id) {
    const r = await http(`https://itunes.apple.com/lookup?${qs({ id, entity: 'song', country: state.settings.country || 'US' })}`);
    const res = r.results || [];
    const a = res.find((x) => x.wrapperType === 'collection') || {};
    return {
      album: { kind: 'album', id: 'am:' + id, source: 'apple', title: a.collectionName, artist: a.artistName, cover: (a.artworkUrl100 || '').replace('100x100', '1000x1000'), year: (a.releaseDate || '').slice(0, 4), genres: [a.primaryGenreName].filter(Boolean) },
      tracks: res.filter((x) => x.wrapperType === 'track').map(itTrack),
    };
  },
};
const itTrack = (s) => ({
  id: 'it:' + s.trackId, source: 'itunes', title: s.trackName, artist: s.artistName, album: s.collectionName || '',
  duration: (s.trackTimeMillis || 0) / 1000, cover: (s.artworkUrl100 || '').replace('100x100', '300x300'), coverXL: (s.artworkUrl100 || '').replace('100x100', '1000x1000'),
});

// =============== Radio Browser ===============
const RB = ['https://de1.api.radio-browser.info', 'https://fi1.api.radio-browser.info', 'https://de2.api.radio-browser.info'];
async function rb(path) {
  let last;
  for (const host of RB) {
    try { return await http(host + path, { timeout: 10 }); } catch (e) { last = e; }
  }
  throw last;
}
const station = (s) => ({
  id: 'radio:' + s.stationuuid, source: 'radio', uuid: s.stationuuid, title: s.name.trim(), live: true,
  artist: [s.country, ...(s.tags || '').split(',').slice(0, 2)].filter(Boolean).join(' · ') || 'Internet radio',
  album: s.codec ? `${s.codec} ${s.bitrate ? s.bitrate + ' kbps' : ''}`.trim() : '', duration: 0,
  cover: s.favicon || '', stream: s.url_resolved || s.url, homepage: s.homepage,
});
export const radio = {
  top: async (n = 40) => (await rb(`/json/stations/topvote/${n}?hidebroken=true`)).map(station),
  search: async (q, n = 60) => (await rb(`/json/stations/search?${qs({ name: q, limit: n, hidebroken: true, order: 'votes', reverse: true })}`)).map(station),
  byTag: async (tag, n = 60) => (await rb(`/json/stations/search?${qs({ tag, limit: n, hidebroken: true, order: 'votes', reverse: true })}`)).map(station),
  byCountry: async (cc, n = 60) => (await rb(`/json/stations/search?${qs({ countrycode: cc, limit: n, hidebroken: true, order: 'votes', reverse: true })}`)).map(station),
  tags: async () => (await rb('/json/tags?order=stationcount&reverse=true&limit=40&hidebroken=true')).map((t) => t.name),
  click: (uuid) => rb(`/json/url/${uuid}`).catch(() => {}),
};

// =============== Internet Archive ===============
export const archive = {
  async search(q, rows = 40) {
    const query = `(${q}) AND mediatype:(audio) AND NOT collection:(podcasts)`;
    const r = await http(`https://archive.org/advancedsearch.php?${qs({ q: query, 'fl[]': 'identifier', rows, output: 'json', 'sort[]': 'downloads desc' })}&fl[]=title&fl[]=creator&fl[]=year`);
    return (r.response?.docs || []).map((d) => ({
      kind: 'album', id: 'ia:' + d.identifier, source: 'archive', iaId: d.identifier,
      title: Array.isArray(d.title) ? d.title[0] : d.title || d.identifier,
      artist: (Array.isArray(d.creator) ? d.creator[0] : d.creator) || 'Internet Archive',
      cover: `https://archive.org/services/img/${d.identifier}`, year: d.year || '',
    }));
  },
  async item(id) {
    const r = await http(`https://archive.org/metadata/${enc(id)}`);
    const md = r.metadata || {};
    const creator = Array.isArray(md.creator) ? md.creator[0] : md.creator || '';
    const files = (r.files || []).filter((f) => /\.(mp3|ogg|flac|m4a)$/i.test(f.name));
    const stemOf = (name) => name.replace(/\.[^.]+$/, '').replace(/_vbr$|_64kb$|_128kb$/i, '');
    const flacByStem = new Map(files.filter((f) => /\.flac$/i.test(f.name)).map((f) => [stemOf(f.name), f.name]));
    const fileUrl = (name) => `https://archive.org/download/${enc(id)}/${name.split('/').map(enc).join('/')}`;
    // prefer one format per track: mp3 originals or VBR derivatives
    const byStem = new Map();
    const rank = (f) => (/\.mp3$/i.test(f.name) ? 0 : /\.ogg$/i.test(f.name) ? 1 : /\.m4a$/i.test(f.name) ? 2 : 3);
    for (const f of files) {
      const stem = f.name.replace(/\.[^.]+$/, '').replace(/_vbr$|_64kb$|_128kb$/i, '');
      const cur = byStem.get(stem);
      if (!cur || rank(f) < rank(cur) || (rank(f) === rank(cur) && /_64kb/i.test(cur.name))) byStem.set(stem, f);
    }
    const cover = `https://archive.org/services/img/${id}`;
    const parseLen = (l) => { if (!l) return 0; if (String(l).includes(':')) { return String(l).split(':').reduce((a, b) => a * 60 + Number(b), 0); } return Number(l) || 0; };
    const tracks = [...byStem.values()]
      .sort((a, b) => (Number(a.track) || 0) - (Number(b.track) || 0) || a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((f, i) => ({
        id: `ia:${id}/${f.name}`, source: 'archive', title: f.title || f.name.replace(/\.[^.]+$/, '').replace(/_/g, ' '),
        artist: f.creator || f.artist || creator || 'Unknown', album: md.title || id, duration: parseLen(f.length),
        cover, stream: fileUrl(f.name), trackNo: i + 1,
        flac: flacByStem.has(stemOf(f.name)) ? fileUrl(flacByStem.get(stemOf(f.name))) : '',
      }));
    return {
      album: { kind: 'album', id: 'ia:' + id, source: 'archive', iaId: id, title: md.title || id, artist: creator, cover, year: md.year || md.date || '', desc: typeof md.description === 'string' ? md.description.replace(/<[^>]+>/g, ' ') : '' },
      tracks,
    };
  },
};

// =============== Jamendo ===============
const jmTrack = (t) => ({
  id: 'jm:' + t.id, source: 'jamendo', title: t.name, artist: t.artist_name, album: t.album_name, duration: t.duration,
  cover: t.album_image || t.image, stream: t.audio, download: t.audiodownload_allowed ? t.audiodownload : '', // FLAC, see audiodlformat
});
export const jamendo = {
  enabled: () => !!state.settings.jamendo_client_id,
  async search(q, limit = 40) {
    const r = await http(`https://api.jamendo.com/v3.0/tracks/?${qs({ client_id: state.settings.jamendo_client_id, format: 'json', limit, search: q, audioformat: 'mp32', order: 'relevance', audiodlformat: 'flac' })}`);
    return (r.results || []).map(jmTrack);
  },
  async popular(limit = 30) {
    const r = await http(`https://api.jamendo.com/v3.0/tracks/?${qs({ client_id: state.settings.jamendo_client_id, format: 'json', limit, order: 'popularity_week', audioformat: 'mp32', audiodlformat: 'flac' })}`);
    return (r.results || []).map(jmTrack);
  },
};

// =============== Subsonic / Navidrome / Airsonic / Gonic ===============
let ssAuthCache = null;
async function ssAuth() {
  const s = state.settings;
  if (!s.subsonic_url || !s.subsonic_user) throw new Error('Subsonic server is not configured');
  const key = s.subsonic_url + s.subsonic_user + s.subsonic_pass;
  if (ssAuthCache?.key === key) return ssAuthCache.params;
  const salt = Math.random().toString(36).slice(2, 12);
  const token = await invoke('md5_hex', { text: s.subsonic_pass + salt });
  const params = { u: s.subsonic_user, t: token, s: salt, v: '1.16.1', c: 'Hysh', f: 'json' };
  ssAuthCache = { key, params };
  return params;
}
const ssBase = () => state.settings.subsonic_url.replace(/\/+$/, '');
async function ssUrl(method, params = {}) {
  return `${ssBase()}/rest/${method}?${qs({ ...(await ssAuth()), ...params })}`;
}
async function ss(method, params) {
  const r = await http(await ssUrl(method, params));
  const body = r['subsonic-response'];
  if (!body || body.status !== 'ok') throw new Error('Subsonic: ' + (body?.error?.message || 'request failed'));
  return body;
}
let ssCoverAuth = '';
const ssCover = (id) => (id ? `${ssBase()}/rest/getCoverArt?${ssCoverAuth}&id=${enc(id)}&size=500` : '');
const ssTrack = (t) => ({
  id: 'ss:' + t.id, source: 'subsonic', ssId: t.id, title: t.title, artist: t.artist || '', artistId: t.artistId ? 'ss:' + t.artistId : '',
  album: t.album || '', albumId: t.albumId ? 'ss:' + t.albumId : '', duration: t.duration || 0, cover: ssCover(t.coverArt), trackNo: t.track,
  suffix: t.suffix || '', lossless: /^(flac|alac|wav|aiff?|ape|wv)$/i.test(t.suffix || ''),
});
const ssAlbum = (a) => ({ kind: 'album', id: 'ss:' + a.id, source: 'subsonic', ssId: a.id, title: a.name || a.title, artist: a.artist || '', cover: ssCover(a.coverArt), year: a.year || '' });
const ssArtist = (a) => ({ kind: 'artist', id: 'ss:' + a.id, source: 'subsonic', ssId: a.id, name: a.name, cover: ssCover(a.coverArt || a.id) });
export const subsonic = {
  enabled: () => !!(state.settings.subsonic_url && state.settings.subsonic_user),
  async prepare() { ssCoverAuth = qs(await ssAuth()); },
  async ping() { await this.prepare(); return ss('ping'); },
  async search(q) {
    await this.prepare();
    const r = (await ss('search3', { query: q, songCount: 40, albumCount: 20, artistCount: 12 })).searchResult3 || {};
    return { tracks: (r.song || []).map(ssTrack), albums: (r.album || []).map(ssAlbum), artists: (r.artist || []).map(ssArtist) };
  },
  async albums(type = 'newest', size = 30) {
    await this.prepare();
    return ((await ss('getAlbumList2', { type, size })).albumList2?.album || []).map(ssAlbum);
  },
  async album(id) {
    await this.prepare();
    const a = (await ss('getAlbum', { id })).album;
    return { album: { ...ssAlbum(a), cover: ssCover(a.coverArt) }, tracks: (a.song || []).map(ssTrack) };
  },
  async artist(id) {
    await this.prepare();
    const a = (await ss('getArtist', { id })).artist;
    return { artist: ssArtist(a), albums: (a.album || []).map(ssAlbum) };
  },
  async playlists() {
    await this.prepare();
    return ((await ss('getPlaylists')).playlists?.playlist || []).map((p) => ({ kind: 'playlist', id: 'ss:' + p.id, source: 'subsonic', ssId: p.id, title: p.name, owner: p.owner, cover: ssCover(p.coverArt), count: p.songCount }));
  },
  async playlist(id) {
    await this.prepare();
    const p = (await ss('getPlaylist', { id })).playlist;
    return { playlist: { kind: 'playlist', id: 'ss:' + p.id, source: 'subsonic', title: p.name, owner: p.owner, cover: ssCover(p.coverArt), count: p.songCount }, tracks: (p.entry || []).map(ssTrack) };
  },
  streamUrl: async (ssId) => ssUrl('stream', { id: ssId }),
};

// =============== web sources (yt-dlp): YouTube, SoundCloud, Bandcamp, pasted links ===============
let webAvailable = null;
let installing = null; // the one-time yt-dlp setup, shared by everyone who needs it
export const watchUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;
/** page URL yt-dlp should read for a track, if it has one */
export const pageUrlOf = (t) => (t.videoId ? watchUrl(t.videoId) : t.pageUrl || null);
export const looksLikeUrl = (s) => /^https:\/\/\S+\.\S+/.test(String(s).trim());
export const web = {
  async available(force = false) {
    if (webAvailable === null || force) webAvailable = (await invoke('yt_status').catch(() => ({ available: false }))).available;
    return webAvailable;
  },
  /**
   * Full-length playback works out of the box: the first time it is needed, yt-dlp is fetched
   * from its official GitHub release in the background (one time, about 18 MB).
   */
  async ensure() {
    if (await this.available()) return true;
    if (!installing) {
      toast('Setting up full-length playback (one time, a few seconds)…', false, 6000);
      installing = invoke('yt_install')
        .then(() => this.available(true))
        .catch((e) => { console.warn('yt-dlp install failed', e); return false; })
        .finally(() => { installing = null; });
    }
    return installing;
  },
  search: (q, limit = 20, provider = 'youtube') => invoke('yt_search', { query: q, limit, provider }),
  extract: (url) => invoke('yt_extract', { url: url.trim() }),
  async sponsorSegments(videoId) {
    try {
      const r = await http(`https://sponsor.ajay.app/api/skipSegments?videoID=${enc(videoId)}&categories=${enc('["music_offtopic","sponsor","selfpromo"]')}`, { timeout: 6 });
      return Array.isArray(r) ? r.map((s) => s.segment) : [];
    } catch { return []; }
  },
};

// =============== local library ===============
export const local = {
  search(q) {
    const n = norm(q);
    if (!n) return [];
    const words = n.split(' ');
    return state.library.filter((t) => { const h = norm(`${t.title} ${t.artist} ${t.album}`); return words.every((w) => h.includes(w)); }).slice(0, 200);
  },
  albums() {
    const map = new Map();
    for (const t of state.library) {
      const key = `${norm(t.albumArtist)}|${norm(t.album)}`;
      let a = map.get(key);
      if (!a) { a = { kind: 'album', id: 'lal:' + key, source: 'local', title: t.album, artist: t.albumArtist || t.artist, year: t.year || '', tracks: [], coverPath: t.path }; map.set(key, a); }
      a.tracks.push(t);
    }
    return [...map.values()].map((a) => ({ ...a, cover: media.cover(a.coverPath), count: a.tracks.length }));
  },
  artists() {
    const map = new Map();
    for (const t of state.library) {
      const name = t.albumArtist || t.artist;
      const key = norm(name);
      let a = map.get(key);
      if (!a) { a = { kind: 'artist', id: 'lar:' + key, source: 'local', name, tracks: [], coverPath: t.path }; map.set(key, a); }
      a.tracks.push(t);
    }
    return [...map.values()].map((a) => ({ ...a, cover: media.cover(a.coverPath), count: a.tracks.length })).sort((a, b) => a.name.localeCompare(b.name));
  },
  match(title, artist, duration) {
    const nt = norm(title), na = norm(artist).split(' ')[0];
    return state.library.find((t) => norm(t.title) === nt && norm(t.artist).includes(na) && (!duration || !t.duration || Math.abs(t.duration - duration) < 10));
  },
};

// =============== artist info: Wikipedia + Last.fm ===============
export async function artistInfo(name) {
  const tries = [name, `${name} (musician)`, `${name} (band)`, `${name} (singer)`, `${name} (rapper)`];
  for (const title of tries) {
    try {
      const r = await http(`https://en.wikipedia.org/api/rest_v1/page/summary/${enc(title.replace(/ /g, '_'))}`, { timeout: 8 });
      if (r.type === 'disambiguation' || !r.extract) continue;
      if (title === name && !/(singer|musician|band|rapper|group|songwriter|DJ|producer|composer|duo|artist|record)/i.test(r.extract + ' ' + (r.description || ''))) continue;
      return { source: 'Wikipedia', text: r.extract, image: r.originalimage?.source || r.thumbnail?.source, url: r.content_urls?.desktop?.page };
    } catch { /* try next */ }
  }
  const key = state.settings.lastfm_api_key;
  if (key) {
    try {
      const r = await http(`https://ws.audioscrobbler.com/2.0/?${qs({ method: 'artist.getinfo', artist: name, api_key: key, format: 'json' })}`);
      const text = (r.artist?.bio?.summary || '').replace(/<a [^>]*>.*?<\/a>\.?/g, '').trim();
      if (text) return { source: 'Last.fm', text, url: r.artist?.url, listeners: r.artist?.stats?.listeners };
    } catch { /* ignore */ }
  }
  return null;
}

// =============== playlist import ===============
export async function importPlaylist(url) {
  url = url.trim();
  let m;
  if ((m = url.match(/deezer\.com\/(?:[a-z]{2}\/)?playlist\/(\d+)/))) {
    const r = await deezer.playlist(m[1]);
    return { name: r.playlist.title, cover: r.playlist.cover, tracks: r.tracks, origin: 'Deezer' };
  }
  if ((m = url.match(/spotify\.com\/(?:intl-[a-z]+\/)?playlist\/([A-Za-z0-9]+)/) || url.match(/^spotify:playlist:([A-Za-z0-9]+)/))) {
    return importSpotify(m[1]);
  }
  if ((m = url.match(/deezer\.com\/(?:[a-z]{2}\/)?album\/(\d+)/))) {
    const r = await deezer.album(m[1]);
    return { name: r.album.title, cover: r.album.cover, tracks: r.tracks, origin: 'Deezer' };
  }
  if (looksLikeUrl(url) && (await web.available())) {
    const r = await web.extract(url);
    if (r.tracks.length) return { name: r.title || 'Imported', cover: r.tracks[0].cover || '', tracks: r.tracks, origin: SOURCE_LABEL[r.tracks[0].source] || 'Web' };
  }
  throw new Error('Paste a Spotify, Deezer, YouTube, SoundCloud or Bandcamp playlist link');
}

// =============== Spotify Web API ===============
let appToken = null; // client-credentials token (public data only)

/**
 * GET from the Spotify Web API. Uses your account token when Spotify is connected (needed for
 * Liked Songs and private playlists), otherwise an app token from Client ID + Secret.
 */
export async function spotifyApi(url, { user = false } = {}) {
  let token;
  if (state.settings.spotify_user) token = await invoke('spotify_token');
  else if (user) throw new Error('Connect Spotify first (Settings › Sources)');
  else {
    const { spotify_client_id: cid, spotify_client_secret: sec } = state.settings;
    if (!cid || !sec) throw new Error('Connect Spotify (or add a Client ID and Secret) in Settings › Sources first');
    if (!appToken || appToken.until < Date.now()) {
      const tok = await http('https://accounts.spotify.com/api/token', {
        method: 'POST', form: { grant_type: 'client_credentials' }, headers: { Authorization: 'Basic ' + btoa(`${cid}:${sec}`) },
      });
      appToken = { value: tok.access_token, until: Date.now() + (tok.expires_in - 60) * 1000 };
    }
    token = appToken.value;
  }
  return http(url, { headers: { Authorization: 'Bearer ' + token } });
}

export const spTrack = (t) => ({
  id: 'sp:' + (t.id || `${t.name}-${t.artists?.[0]?.name}`), source: 'spotify', title: t.name,
  artist: (t.artists || []).map((a) => a.name).join(', '), album: t.album?.name || '', duration: (t.duration_ms || 0) / 1000,
  cover: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || '', coverXL: t.album?.images?.[0]?.url || '', isrc: t.external_ids?.isrc,
});

async function importSpotify(id) {
  const meta = await spotifyApi(`https://api.spotify.com/v1/playlists/${id}?fields=name,images,description`);
  let next = `https://api.spotify.com/v1/playlists/${id}/tracks?limit=100&fields=next,items(track(id,name,duration_ms,artists(name),album(name,images),external_ids))`;
  const tracks = [];
  while (next && tracks.length < 5000) {
    const page = await spotifyApi(next);
    for (const it of page.items || []) if (it.track?.name) tracks.push(spTrack(it.track));
    next = page.next;
  }
  return { name: meta.name, cover: meta.images?.[0]?.url || '', tracks, origin: 'Spotify' };
}

// =============== plugin sources ===============
/** id -> { id, name, search(query) => tracks, resolve(track) => { url, via?, live? } } */
export const pluginSources = new Map();
export function registerSource(src) {
  if (!src?.id || typeof src.search !== 'function' || typeof src.resolve !== 'function') throw new Error('A source needs id, search() and resolve()');
  pluginSources.set(src.id, src);
  SOURCE_LABEL[src.id] = src.name || src.id;
}

// =============== stream resolution ===============
const resolved = new Map();

/**
 * Turns any track into something the audio element can play.
 * Metadata-only tracks (Deezer, Apple, iTunes, Spotify imports) go through the resolver chain:
 * local library -> Subsonic server -> YouTube Music audio (full songs only, never previews).
 */
export async function resolve(t) {
  const offline = downloadedPath(t);
  if (offline) return { url: media.file(offline), via: 'Downloaded' };
  if (pluginSources.has(t.source)) {
    const r = await pluginSources.get(t.source).resolve(t);
    if (!r?.url) throw new Error(`${SOURCE_LABEL[t.source]} could not play this song`);
    // plugin URLs go through the proxy so EQ, crossfade and effects still apply
    return { via: SOURCE_LABEL[t.source], ...r, url: /^https?:\/\//.test(r.url) && !r.url.startsWith('http://127.0.0.1') ? media.proxy(r.url) : r.url };
  }
  switch (t.source) {
    case 'local': return { url: media.file(t.path), via: 'Local file' };
    case 'youtube': return { url: media.web(watchUrl(t.videoId)), via: 'YouTube' };
    case 'soundcloud':
    case 'bandcamp':
    case 'web': return { url: media.web(t.pageUrl), via: SOURCE_LABEL[t.source] };
    case 'stream': return { url: media.proxy(t.stream), via: t.live ? 'Live stream' : 'Stream', live: !!t.live };
    case 'subsonic': return { url: media.proxy(await subsonic.streamUrl(t.ssId)), via: 'Server' };
    case 'radio': radio.click(t.uuid); return { url: media.proxy(t.stream), via: 'Live radio', live: true };
    case 'archive':
    case 'jamendo': return { url: media.proxy(t.stream), via: SOURCE_LABEL[t.source] };
  }
  if (resolved.has(t.id)) return resolved.get(t.id);
  const order = state.settings.resolver || ['local', 'subsonic', 'youtube'];
  let out = null;
  for (const step of order) {
    try {
      if (step === 'local') {
        const m = local.match(t.title, t.artist, t.duration);
        if (m) out = { url: media.file(m.path), via: 'Local file', path: m.path };
      } else if (step === 'subsonic' && subsonic.enabled()) {
        const r = await subsonic.search(`${t.title} ${t.artist.split(',')[0]}`);
        const nt = norm(t.title);
        const m = r.tracks.find((x) => norm(x.title) === nt && (!t.duration || Math.abs(x.duration - t.duration) < 10));
        if (m) out = { url: media.proxy(await subsonic.streamUrl(m.ssId)), via: 'Server' };
      } else if (step === 'youtube' && (await web.ensure())) {
        const vid = t.videoId || (await rememberedMatch(t.id)) || (await invoke('yt_match', { title: t.title, artist: t.artist, duration: t.duration || 0 }));
        if (vid) { t.videoId = vid; remember(t.id, vid); out = { url: media.web(watchUrl(vid)), via: 'YouTube', videoId: vid }; }
      }
    } catch (e) { console.warn('resolver step failed', step, e); }
    if (out) break;
  }
  if (!out) throw new Error('No playable source found. Add a music folder, a Subsonic server or enable YouTube in Settings.');
  resolved.set(t.id, out);
  return out;
}

// ---------- artwork for songs that arrive without any (imports, CSV, Last.fm) ----------
// Deezer first, then iTunes, then the matched YouTube video; three lookups at a time so the
// public APIs are never flooded; every result is saved into the library.
const artMemo = new Map();
const artQueue = [];
let artBusy = 0;

export function findArt(t) {
  if (!t || t.live) return Promise.resolve(null);
  const have = coverOf(t);
  if (have) return Promise.resolve(have);
  if (!artMemo.has(t.id)) {
    artMemo.set(t.id, new Promise((done) => { artQueue.push({ t, done }); pumpArt(); }));
  }
  return artMemo.get(t.id);
}

function pumpArt() {
  while (artBusy < 3 && artQueue.length) {
    const { t, done } = artQueue.shift();
    artBusy++;
    lookupArt(t)
      .catch(() => null)
      .then((url) => { if (!url) artMemo.delete(t.id); done(url); }) // misses may succeed later (after a match)
      .finally(() => { artBusy--; pumpArt(); });
  }
}

async function lookupArt(t) {
  const artist = (t.artist || '').split(',')[0].trim();
  const nt = norm(t.title);
  let cover = null, xl = null;
  const d = await deezer.findTrack(t.title, artist).catch(() => null);
  if (d && norm(d.title).includes(nt.split(' ')[0])) { cover = d.cover; xl = d.coverXL; }
  if (!cover) {
    const it = (await apple.search(`${t.title} ${artist}`, 3).catch(() => [])).find((x) => norm(x.title).includes(nt.split(' ')[0]));
    if (it) { cover = it.cover; xl = it.coverXL; }
  }
  if (!cover) {
    // last resort: the thumbnail of the YouTube Music track it plays from
    const vid = t.videoId || (await rememberedMatch(t.id));
    if (vid) cover = `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
  }
  if (!cover) return null;
  t.cover = cover;
  if (xl) t.coverXL = xl;
  patchTrackArt(t.id, cover, xl);
  return cover;
}

// ---------- remembered matches: a catalog song is searched on YouTube Music only once ----------
let matches = null; // track id -> videoId, persisted in store/matches.json
const saveMatches = (() => { let t; return () => { clearTimeout(t); t = setTimeout(() => invoke('store_save', { name: 'matches', value: matches }).catch(() => {}), 1000); }; })();
async function rememberedMatch(id) {
  if (!matches) matches = (await invoke('store_load', { name: 'matches' }).catch(() => null)) || {};
  return matches[id] || null;
}
function remember(id, vid) {
  if (!matches || matches[id] === vid) return;
  matches[id] = vid;
  saveMatches();
}

/**
 * Gets a song ready before it is needed: matched, and its stream link resolved, so pressing
 * Next or reaching the end of a song starts the following one almost at once.
 */
export async function prefetch(t) {
  if (!t || t.live) return;
  try {
    const r = await resolve(t);
    const page = t.videoId ? watchUrl(t.videoId) : t.pageUrl;
    // only songs served from a web page need their stream link resolved ahead
    if (page && r.url.includes('/web?')) await invoke('web_warm', { url: page });
  } catch { /* the real play attempt reports errors */ }
}

/** "Radio" / autoplay: similar tracks for endless listening. */
export async function radioFor(t) {
  let artistId = t.source === 'deezer' ? t.artistId : null;
  if (!artistId && t.artist) artistId = (await deezer.findArtist(t.artist.split(',')[0]).catch(() => null))?.dzId;
  let list = artistId ? await deezer.artistRadio(artistId).catch(() => []) : [];
  if (t.source === 'local') {
    const same = state.library.filter((x) => x.id !== t.id && (x.artist === t.artist || (t.genre && x.genre === t.genre)));
    list = [...same.sort(() => Math.random() - 0.5).slice(0, 15), ...list];
  }
  return list.filter((x) => x.id !== t.id);
}
