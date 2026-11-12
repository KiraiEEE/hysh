// Hysh - download manager. GPL-3.0-or-later
// Queue with limited concurrency, per-job status, retry, auto-download of liked songs,
// tags + cover art written by the backend, and offline playback through the store's index.
import { invoke, env } from './api.js';
import { state, emit, on, setSetting, flushSettings, rescanLibrary, markDownloaded, downloadedPath, isLiked } from './store.js';
import { coverOf, web, subsonic, pageUrlOf, watchUrl } from './sources.js';
import { toast } from './ui.js';

const CONCURRENCY = 2;

/** @typedef {{ key: number, t: object, status: 'queued'|'active'|'done'|'error', error?: string, path?: string }} Job */
/** @type {Job[]} */
export const jobs = [];
let seq = 0;
let active = 0;
let batch = { total: 0, ok: 0, label: '' };

export const isDownloaded = (t) => !!downloadedPath(t);
export const canDownload = (t) => !!t && !t.live && t.source !== 'local';
const inQueue = (t) => jobs.some((j) => j.t.id === t.id && (j.status === 'queued' || j.status === 'active'));

/** Adds songs to the queue. Already-downloaded and already-queued songs are skipped. */
export function enqueue(tracks, { label = '', silent = false } = {}) {
  const fresh = tracks.filter((t) => canDownload(t) && !isDownloaded(t) && !inQueue(t));
  if (!fresh.length) {
    if (!silent) toast(tracks.length > 1 ? 'Everything here is already downloaded' : 'Already downloaded');
    return 0;
  }
  if (!active && !jobs.some((j) => j.status === 'queued')) batch = { total: 0, ok: 0, label };
  batch.total += fresh.length;
  for (const t of fresh) jobs.push({ key: ++seq, t, status: 'queued' });
  if (!silent) toast(fresh.length > 1 ? `Downloading ${fresh.length} songs${label ? ' ' + label : ''}` : `Downloading “${fresh[0].title}”`);
  emit('downloads');
  pump();
  return fresh.length;
}

export function retry(key) {
  const j = jobs.find((x) => x.key === key && x.status === 'error');
  if (!j) return;
  j.status = 'queued';
  j.error = undefined;
  batch.total++;
  emit('downloads');
  pump();
}

export function clearFinished() {
  for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].status === 'done' || jobs[i].status === 'error') jobs.splice(i, 1);
  emit('downloads');
}

function pump() {
  while (active < CONCURRENCY) {
    const job = jobs.find((j) => j.status === 'queued');
    if (!job) break;
    run(job);
  }
}

async function run(job) {
  active++;
  job.status = 'active';
  emit('downloads');
  try {
    const req = await buildRequest(job.t);
    job.path = await invoke('download', { req });
    job.status = 'done';
    batch.ok++;
    markDownloaded(job.t, job.path);
  } catch (e) {
    job.status = 'error';
    job.error = String(e?.message || e);
  } finally {
    active--;
    emit('downloads');
    pump();
    if (!active && !jobs.some((j) => j.status === 'queued')) finishBatch();
  }
}

/**
 * Works out where a song's audio comes from.
 * Lossless (FLAC / original files) is used whenever the source really offers it:
 * Internet Archive FLAC files, Jamendo FLAC downloads, and the original files on a Subsonic server.
 * Catalog-only songs (Deezer, Apple, Spotify imports) are matched on YouTube.
 */
async function buildRequest(t) {
  const lossless = state.settings.download_lossless !== false;
  let src, ext = '';
  const page = pageUrlOf(t);
  if (page) src = 'page:' + page;
  else switch (t.source) {
    case 'archive':
      src = lossless && t.flac ? t.flac : t.stream;
      break;
    case 'jamendo':
      if (lossless && t.download) { src = t.download; ext = 'flac'; } else { src = t.stream; ext = 'mp3'; }
      break;
    case 'subsonic': {
      const stream = await subsonic.streamUrl(t.ssId);
      if (lossless) { src = stream.replace('/rest/stream', '/rest/download'); ext = t.suffix || 'mp3'; } else { src = stream; ext = 'mp3'; }
      break;
    }
    default: {
      if (!(await web.ensure())) throw new Error('Could not set up full-length downloads; check your connection');
      const vid = await invoke('yt_match', { title: t.title, artist: t.artist || '', duration: t.duration || 0 });
      if (!vid) throw new Error('No full-length match found');
      src = 'page:' + watchUrl(vid);
    }
  }
  const cover = coverOf(t, true) || '';
  return {
    src,
    ext,
    format: state.settings.download_format || 'm4a',
    meta: {
      title: t.title || '',
      artist: t.artist || '',
      album: t.album || '',
      year: Number(t.year) || 0,
      track_no: Number(t.trackNo) || 0,
      cover: /^https?:\/\//.test(cover) && !cover.startsWith('http://127.0.0.1') ? cover : '',
    },
  };
}

/** After a batch: make sure the download folder is part of the library, then refresh it. */
async function finishBatch() {
  const { total, ok, label } = batch;
  if (!total) return;
  const failed = total - ok;
  if (total > 1 || failed) toast(failed ? `Downloaded ${ok} of ${total}${label ? ' ' + label : ''}. ${failed} failed (see Downloads).` : `Downloaded ${ok} songs`, failed > 0, 5000);
  else toast(`Downloaded “${jobs.find((j) => j.status === 'done')?.t.title || 'song'}”`);
  batch = { total: 0, ok: 0, label: '' };
  if (!ok) return;
  const dir = state.settings.download_dir || env.downloadDir;
  if (dir && !(state.settings.music_folders || []).includes(dir)) {
    setSetting('music_folders', [...(state.settings.music_folders || []), dir]);
    await flushSettings();
  }
  rescanLibrary().catch((e) => console.warn('rescan after download', e));
}

export function initDownloads() {
  on('likes', (t) => {
    if (state.settings.auto_download_likes && t && isLiked(t) && canDownload(t)) enqueue([t], { silent: true });
  });
}
