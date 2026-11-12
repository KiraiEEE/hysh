// Hysh - audio engine. GPL-3.0-or-later
// Two decks (HTMLAudioElement -> Web Audio) for equal-power crossfade and gapless playback,
// 10-band EQ + preamp, analyser for the visualizer, sleep timer, autoplay radio,
// SponsorBlock skipping, Windows media keys (Media Session), scrobbling and Discord presence.
import { invoke } from './api.js';
import { state, setSetting, emit, recordPlay, addListenTime, slim } from './store.js';
import { resolve, prefetch, coverOf, radioFor, web, deezer, SOURCE_LABEL } from './sources.js';
import { toast, throttle, debounce } from './ui.js';

export const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_PRESETS = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass boost': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  'Treble boost': [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  Vocal: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1],
  Rock: [5, 4, 2, 0, -1, 0, 2, 3, 4, 4],
  Pop: [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2],
  Electronic: [5, 4, 1, 0, -2, 1, 0, 1, 4, 5],
  'Hip-hop': [5, 5, 3, 1, -1, -1, 1, 0, 2, 3],
  Acoustic: [4, 3, 2, 1, 2, 2, 3, 3, 2, 1],
  Loudness: [5, 3, 0, 0, -2, 0, -1, 0, 4, 2],
};

let ctx = null, master, analyser, preamp, eqNodes = [], fxIn, fxOut;
const effectFactories = new Map(); // id -> (ctx) => { input, output }   (plugins)
const effectNodes = new Map();     // id -> live { input, output }
const decks = [];
let cur = 0;
let fading = false;
let loadSeq = 0;
let errors = 0;
let preload = null;           // { index, trackId, deck, ready: Promise }
let sleepTimer = null, sleepAfterTrack = false, sleepEndsAt = 0;
let segments = [];
let scrobbled = false, playedSecs = 0, lastTick = 0, trackStartedAt = 0;

export const player = {
  queue: [],
  index: -1,
  original: null,       // queue order before shuffle
  context: null,        // { label, id }
  current: null,
  via: '',
  live: false,
  loading: false,
  get playing() { const a = decks[cur]?.audio; return !!a && !a.paused && !a.ended; },
  get position() { return decks[cur]?.audio.currentTime || 0; },
  get duration() { const d = decks[cur]?.audio.duration; return isFinite(d) ? d : (this.current?.duration || 0); },
  get buffered() {
    const a = decks[cur]?.audio;
    if (!a || !a.buffered.length || !isFinite(a.duration)) return 0;
    return a.buffered.end(a.buffered.length - 1) / a.duration;
  },
  get sleepRemaining() { return sleepEndsAt ? Math.max(0, sleepEndsAt - Date.now()) / 1000 : sleepAfterTrack ? -1 : 0; },
  analyser: () => analyser,
};

// ---------- graph ----------
function ensureCtx() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  ctx = new AudioContext({ latencyHint: 'playback' });
  preamp = ctx.createGain();
  eqNodes = EQ_FREQS.map((f, i) => {
    const b = ctx.createBiquadFilter();
    b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
    b.frequency.value = f;
    b.Q.value = 1.1;
    return b;
  });
  master = ctx.createGain();
  analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.8;
  fxIn = ctx.createGain();
  fxOut = ctx.createGain();
  let node = preamp;
  for (const b of eqNodes) { node.connect(b); node = b; }
  node.connect(fxIn);
  fxOut.connect(master).connect(analyser).connect(ctx.destination);
  rebuildEffects();
  for (const d of decks) {
    d.src = ctx.createMediaElementSource(d.audio);
    d.gain = ctx.createGain();
    d.src.connect(d.gain).connect(preamp);
  }
  applyEq();
  applyVolume();
}

function makeDeck(i) {
  const audio = new Audio();
  audio.crossOrigin = 'anonymous';
  audio.preload = 'auto';
  audio.preservesPitch = true;
  const d = { audio, i, gain: null, src: null };
  audio.addEventListener('timeupdate', () => d === decks[cur] && onTime());
  audio.addEventListener('ended', () => d === decks[cur] && !fading && onEnded());
  audio.addEventListener('play', () => d === decks[cur] && onPlayState());
  audio.addEventListener('pause', () => d === decks[cur] && !fading && onPlayState());
  audio.addEventListener('waiting', () => d === decks[cur] && emit('buffering', true));
  audio.addEventListener('playing', () => d === decks[cur] && emit('buffering', false));
  audio.addEventListener('error', () => d === decks[cur] && onError(audio.error));
  audio.addEventListener('loadedmetadata', () => d === decks[cur] && emit('time'));
  return d;
}
decks.push(makeDeck(0), makeDeck(1));

// ---------- plugin effects: preamp -> EQ -> [effects...] -> master ----------
function rebuildEffects() {
  if (!ctx) return;
  fxIn.disconnect();
  for (const fx of effectNodes.values()) { try { fx.output.disconnect(); } catch { /* not connected */ } }
  for (const [id, make] of effectFactories) {
    if (!effectNodes.has(id)) {
      try { effectNodes.set(id, make(ctx)); } catch (e) { console.warn(`effect ${id} failed`, e); effectFactories.delete(id); }
    }
  }
  let node = fxIn;
  for (const [id, fx] of effectNodes) {
    if (!effectFactories.has(id)) { effectNodes.delete(id); continue; }
    node.connect(fx.input);
    node = fx.output;
  }
  node.connect(fxOut);
}

/** Inserts an audio effect. `make(ctx)` returns { input: AudioNode, output: AudioNode }. */
export function addEffect(id, make) {
  effectFactories.set(id, make);
  effectNodes.delete(id);
  rebuildEffects();
}
export function removeEffect(id) {
  effectFactories.delete(id);
  rebuildEffects();
}
/** The shared AudioContext (created on first playback). */
export const audioContext = () => { ensureCtx(); return ctx; };

export function applyEq() {
  if (!ctx) return;
  const on = state.settings.eq_on;
  eqNodes.forEach((b, i) => b.gain.setTargetAtTime(on ? state.settings.eq[i] || 0 : 0, ctx.currentTime, 0.05));
  preamp.gain.setTargetAtTime(on ? Math.pow(10, (state.settings.preamp || 0) / 20) : 1, ctx.currentTime, 0.05);
}
export function applyVolume() {
  const v = state.settings.muted ? 0 : Math.pow(state.settings.volume, 2);
  if (ctx) master.gain.setTargetAtTime(v, ctx.currentTime, 0.03);
  else decks.forEach((d) => (d.audio.volume = v));
}
export function applySpeed() {
  decks.forEach((d) => (d.audio.playbackRate = player.live ? 1 : state.settings.speed || 1));
}

// ---------- queue ----------
function nextIndex(manual = false) {
  const n = player.queue.length;
  if (!n) return -1;
  if (state.settings.repeat === 'one' && !manual) return player.index;
  if (player.index + 1 < n) return player.index + 1;
  if (state.settings.repeat === 'all') return 0;
  return -1;
}

export async function playList(tracks, start = 0, context = null) {
  if (!tracks?.length) return;
  player.queue = tracks.map((t) => ({ ...t }));
  player.original = null;
  player.context = context;
  if (state.settings.shuffle) shuffleRest(start);
  else player.index = start;
  if (state.settings.shuffle) start = 0;
  await load(state.settings.shuffle ? 0 : start, { autoplay: true });
  emit('queue');
}

export function playNext(tracks) {
  if (!player.queue.length) return playList(tracks, 0);
  player.queue.splice(player.index + 1, 0, ...tracks.map((t) => ({ ...t })));
  invalidatePreload();
  emit('queue');
  toast(tracks.length > 1 ? `${tracks.length} songs will play next` : `“${tracks[0].title}” will play next`);
}

export function addToQueue(tracks) {
  if (!player.queue.length) return playList(tracks, 0);
  player.queue.push(...tracks.map((t) => ({ ...t })));
  invalidatePreload();
  emit('queue');
  toast(tracks.length > 1 ? `Added ${tracks.length} songs to the queue` : `Added “${tracks[0].title}” to the queue`);
}

export function removeAt(i) {
  if (i === player.index) return;
  player.queue.splice(i, 1);
  if (i < player.index) player.index--;
  invalidatePreload();
  emit('queue');
}

export function moveItem(from, to) {
  if (from === to) return;
  const [it] = player.queue.splice(from, 1);
  player.queue.splice(to, 0, it);
  if (player.index === from) player.index = to;
  else if (from < player.index && to >= player.index) player.index--;
  else if (from > player.index && to <= player.index) player.index++;
  invalidatePreload();
  emit('queue');
}

export function clearUpcoming() {
  player.queue = player.queue.slice(0, player.index + 1);
  invalidatePreload();
  emit('queue');
}

export function jump(i) { load(i, { autoplay: true }); }

function shuffleRest(start) {
  const first = player.queue[start];
  const rest = player.queue.filter((_, i) => i !== start);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  player.original = player.queue.slice();
  player.queue = [first, ...rest];
  player.index = 0;
}

export function toggleShuffle() {
  const on = !state.settings.shuffle;
  setSetting('shuffle', on);
  if (player.queue.length) {
    if (on) {
      const curT = player.queue[player.index];
      const before = player.queue.slice(0, player.index + 1);
      const rest = player.queue.slice(player.index + 1);
      for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
      player.original = player.queue.slice();
      player.queue = [...before, ...rest];
      player.index = player.queue.indexOf(curT);
    } else if (player.original) {
      const curT = player.queue[player.index];
      player.queue = player.original;
      player.original = null;
      player.index = Math.max(0, player.queue.indexOf(curT));
    }
    invalidatePreload();
    emit('queue');
  }
}

export function cycleRepeat() {
  const order = ['off', 'all', 'one'];
  setSetting('repeat', order[(order.indexOf(state.settings.repeat) + 1) % 3]);
  invalidatePreload();
}

// ---------- loading ----------
function invalidatePreload() {
  if (preload && !fading) {
    const d = preload.deck;
    if (d !== decks[cur]) { d.audio.removeAttribute('src'); d.audio.load(); }
  }
  if (!fading) preload = null;
}

async function load(index, { autoplay = true, startAt = 0 } = {}) {
  const t = player.queue[index];
  if (!t) return;
  const seq = ++loadSeq;
  ensureCtx();
  player.index = index;
  player.current = t;
  player.loading = true;
  player.live = !!t.live;
  segments = [];
  scrobbled = false; playedSecs = 0; lastTick = 0;
  emit('track', t);
  emit('queue');

  // reuse a deck that already preloaded this track (gapless)
  if (preload && preload.trackId === t.id && preload.index === index) {
    const p = preload;
    preload = null;
    const ok = await p.ready.catch(() => null);
    if (seq !== loadSeq) return;
    if (ok) {
      const old = decks[cur];
      cur = p.deck.i;
      old.audio.pause();
      old.audio.removeAttribute('src');
      old.audio.load();
      if (ctx) { decks[cur].gain.gain.cancelScheduledValues(ctx.currentTime); decks[cur].gain.gain.setValueAtTime(1, ctx.currentTime); }
      finishLoad(t, ok, autoplay, startAt, seq);
      return;
    }
  }

  let res;
  try {
    res = await resolve(t);
  } catch (e) {
    if (seq !== loadSeq) return;
    player.loading = false;
    toast(e.message || String(e), true, 4500);
    emit('track', t);
    return skipAfterError();
  }
  if (seq !== loadSeq) return;
  invalidatePreload();
  const d = decks[cur];
  const other = decks[1 - cur];
  other.audio.pause();
  if (ctx) { d.gain.gain.cancelScheduledValues(ctx.currentTime); d.gain.gain.setValueAtTime(1, ctx.currentTime); }
  d.audio.src = res.url;
  finishLoad(t, res, autoplay, startAt, seq);
}

function finishLoad(t, res, autoplay, startAt, seq) {
  const a = decks[cur].audio;
  player.via = res.via || '';
  player.live = !!res.live || !!t.live;
  if (res.videoId) t.videoId = res.videoId;
  applySpeed();
  if (startAt) {
    const go = () => { a.currentTime = startAt; };
    if (a.readyState >= 1) go(); else a.addEventListener('loadedmetadata', go, { once: true });
  }
  if (autoplay) {
    a.play().then(() => { errors = 0; }).catch((e) => { if (seq === loadSeq && e.name !== 'AbortError') console.warn(e); });
  }
  player.loading = false;
  trackStartedAt = Math.floor(Date.now() / 1000);
  if (autoplay) recordPlay(t);
  emit('track', t);
  updateMediaSession(t);
  nowPlayingHooks(t);
  if (t.videoId && state.settings.sponsorblock) web.sponsorSegments(t.videoId).then((s) => { if (player.current === t) segments = s; });
  maybeAutoplayRefill();
  saveSession();
}

function skipAfterError() {
  errors++;
  if (errors > 4) { toast('Several songs in a row failed to play, stopping.', true); errors = 0; return; }
  const n = nextIndex(true);
  if (n >= 0 && n !== player.index) setTimeout(() => load(n, { autoplay: true }), 900);
}

function onError(err) {
  if (!player.current || player.loading) return;
  console.warn('media error', err);
  toast(`Could not play “${player.current.title}”${err?.message ? ': ' + err.message : ''}`, true);
  skipAfterError();
}

// ---------- transport ----------
export function toggle() {
  const a = decks[cur].audio;
  if (!player.current) {
    if (player.queue.length) return load(Math.max(0, player.index), { autoplay: true });
    return;
  }
  ensureCtx();
  if (a.paused) {
    if (!a.src) {
      const at = player.pendingPosition || 0;
      player.pendingPosition = 0;
      return load(player.index, { autoplay: true, startAt: at });
    }
    a.play().catch(console.warn);
  } else a.pause();
}
export function play() { if (decks[cur].audio.paused) toggle(); }
export function pause() { if (!decks[cur].audio.paused) decks[cur].audio.pause(); }

export function next() {
  const n = nextIndex(true);
  if (n >= 0) load(n, { autoplay: true });
  else if (state.settings.autoplay && player.current) refillAndContinue();
}
export function prev() {
  const a = decks[cur].audio;
  if (a.currentTime > 3 || player.index <= 0) { a.currentTime = 0; return; }
  load(player.index - 1, { autoplay: true });
}
export function seek(sec) {
  const a = decks[cur].audio;
  if (player.live || !isFinite(sec)) return;
  a.currentTime = Math.max(0, Math.min(sec, (isFinite(a.duration) ? a.duration : sec) - 0.25));
  emit('time');
  discordSoon();
}
export function seekBy(d) { seek(player.position + d); }
export function setVolume(v) {
  setSetting('volume', Math.max(0, Math.min(1, v)), { silent: true });
  if (state.settings.muted && v > 0) setSetting('muted', false, { silent: true });
  applyVolume();
  emit('volume');
}
export function toggleMute() { setSetting('muted', !state.settings.muted, { silent: true }); applyVolume(); emit('volume'); }
export function setSpeed(s) { setSetting('speed', s); applySpeed(); }

// ---------- time / transitions ----------
function onTime() {
  const a = decks[cur].audio;
  const t = a.currentTime;
  const dur = a.duration;
  // listen accounting
  if (!a.paused) {
    const delta = lastTick ? t - lastTick : 0;
    if (delta > 0 && delta < 2) { playedSecs += delta; if (player.current) addListenTime(player.current, delta); }
  }
  lastTick = t;
  maybeScrobble(dur);
  // SponsorBlock
  for (const [s, e] of segments) if (t >= s && t < e - 0.5) { a.currentTime = e; toast('Skipped a non-music section'); break; }

  if (!isFinite(dur) || player.live || state.settings.repeat === 'one') return;
  const left = dur - t;
  const cf = Math.min(state.settings.crossfade || 0, dur / 3);
  // preload the next song early (also warms the YouTube cache)
  if (!preload && !fading && left < Math.max(25, cf + 20)) startPreload();
  if (cf > 0.5 && !fading && left <= cf && left > 0.2 && preload) crossfade(cf);
  if (sleepAfterTrack && left < 0.4) { sleepAfterTrack = false; pause(); emit('sleep'); }
}

function startPreload() {
  const n = nextIndex();
  if (n < 0 || n === player.index) return;
  const t = player.queue[n];
  if (!t || t.live) return;
  const d = decks[1 - cur];
  const p = { index: n, trackId: t.id, deck: d };
  p.ready = resolve(t).then((res) => {
    if (preload !== p) return null;
    d.audio.src = res.url;
    d.audio.load();
    return res;
  });
  p.ready.catch(() => { if (preload === p) preload = null; });
  preload = p;
}

async function crossfade(cf) {
  const p = preload;
  const res = await p.ready.catch(() => null);
  if (!res || preload !== p || fading) return;
  ensureCtx();
  fading = true;
  const from = decks[cur], to = p.deck;
  const now = ctx.currentTime;
  const steps = 64;
  const outCurve = new Float32Array(steps), inCurve = new Float32Array(steps);
  for (let i = 0; i < steps; i++) { const x = i / (steps - 1); outCurve[i] = Math.cos(x * Math.PI / 2); inCurve[i] = Math.sin(x * Math.PI / 2); }
  to.gain.gain.cancelScheduledValues(now);
  from.gain.gain.cancelScheduledValues(now);
  to.gain.gain.setValueAtTime(0, now);
  to.gain.gain.setValueCurveAtTime(inCurve, now, cf);
  from.gain.gain.setValueCurveAtTime(outCurve, now, cf);
  to.audio.playbackRate = state.settings.speed || 1;
  to.audio.play().catch(console.warn);
  // the new song becomes "current" right away so the UI follows the music
  preload = null;
  cur = to.i;
  const t = player.queue[p.index];
  player.index = p.index;
  player.current = t;
  scrobbled = false; playedSecs = 0; lastTick = 0; segments = [];
  player.via = res.via || '';
  trackStartedAt = Math.floor(Date.now() / 1000);
  recordPlay(t);
  emit('track', t);
  emit('queue');
  updateMediaSession(t);
  nowPlayingHooks(t);
  maybeAutoplayRefill();
  setTimeout(() => {
    from.audio.pause();
    from.audio.removeAttribute('src');
    from.audio.load();
    fading = false;
    saveSession();
  }, cf * 1000 + 80);
}

function onEnded() {
  if (state.settings.repeat === 'one') { seek(0); decks[cur].audio.play(); return; }
  const n = nextIndex();
  if (n >= 0) load(n, { autoplay: true });
  else if (state.settings.autoplay) refillAndContinue();
  else { emit('state'); }
}

async function refillAndContinue() {
  const added = await refill();
  if (added) load(player.index + 1, { autoplay: true });
}

let refilling = false;
async function refill() {
  const seed = player.current || player.queue[player.queue.length - 1];
  if (!seed || refilling) return 0;
  refilling = true;
  try {
    const have = new Set(player.queue.map((t) => t.id));
    const more = (await radioFor(seed)).filter((t) => !have.has(t.id)).slice(0, 25);
    if (more.length) { player.queue.push(...more); emit('queue'); }
    return more.length;
  } catch { return 0; } finally { refilling = false; }
}
let warmTimer = 0;
/** A few seconds after a song starts (so it gets the bandwidth first), prepare the next two. */
function warmAhead() {
  clearTimeout(warmTimer);
  warmTimer = setTimeout(async () => {
    for (let k = 1; k <= 2; k++) {
      const t = player.queue[player.index + k];
      if (t) await prefetch(t);
    }
  }, 3000);
}

function maybeAutoplayRefill() {
  warmAhead();
  if (state.settings.autoplay && state.settings.repeat === 'off' && player.index >= player.queue.length - 2 && !player.current?.live) refill();
}

function onPlayState() {
  emit('state');
  if (navigator.mediaSession) navigator.mediaSession.playbackState = player.playing ? 'playing' : 'paused';
  discordSoon();
}

// ---------- sleep timer ----------
export function setSleep(minutes) {
  clearTimeout(sleepTimer);
  sleepTimer = null; sleepEndsAt = 0; sleepAfterTrack = false;
  if (minutes === 'track') { sleepAfterTrack = true; toast('Will stop after this song'); }
  else if (minutes > 0) {
    sleepEndsAt = Date.now() + minutes * 60_000;
    sleepTimer = setTimeout(fadeOutAndPause, minutes * 60_000);
    toast(`Sleep timer: ${minutes} min`);
  } else toast('Sleep timer off');
  emit('sleep');
}
function fadeOutAndPause() {
  sleepEndsAt = 0;
  if (!ctx) return pause();
  const g = master.gain, now = ctx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(0, now + 8);
  setTimeout(() => { pause(); applyVolume(); emit('sleep'); }, 8200);
}

// ---------- scrobble / discord / media session ----------
const scrobbleTrack = (t) => ({ title: t.title, artist: (t.artist || '').split(',')[0].trim(), album: t.album || '', duration: player.duration || t.duration || 0 });
function nowPlayingHooks(t) {
  if (state.settings.scrobble_enabled && !t.live) invoke('scrobble_now', { track: scrobbleTrack(t) }).catch((e) => console.warn('now playing', e));
  discordSoon();
}
function maybeScrobble(dur) {
  const t = player.current;
  if (scrobbled || !t || t.live || !state.settings.scrobble_enabled) return;
  if (!isFinite(dur) || dur < 30) return;
  if (playedSecs >= Math.min(dur / 2, 240)) {
    scrobbled = true;
    invoke('scrobble_submit', { track: scrobbleTrack(t), timestamp: trackStartedAt }).catch((e) => console.warn('scrobble', e));
  }
}
// Discord only shows web images, so local files borrow the matching Deezer cover.
const webCovers = new Map();
async function webCover(t) {
  const c = coverOf(t, true);
  if (c && c.startsWith('https://')) return c;
  if (t.live || !t.title) return '';
  if (!webCovers.has(t.id)) webCovers.set(t.id, deezer.findTrack(t.title, t.artist || '').then((d) => d?.coverXL || d?.cover || '').catch(() => ''));
  return webCovers.get(t.id);
}
function shareLink(t) {
  if (t.videoId) return { url: `https://music.youtube.com/watch?v=${t.videoId}`, url_label: 'Listen on YouTube Music' };
  if (t.source === 'deezer' && t.dzId) return { url: `https://www.deezer.com/track/${t.dzId}`, url_label: 'Listen on Deezer' };
  if (t.source === 'radio' && t.homepage?.startsWith('https://')) return { url: t.homepage, url_label: 'Station website' };
  if (t.pageUrl) return { url: t.pageUrl, url_label: `Listen on ${SOURCE_LABEL[t.source] || 'the web'}` };
  if (t.source === 'archive' && t.stream) return { url: t.stream.replace('/download/', '/details/').split('/').slice(0, 5).join('/'), url_label: 'Internet Archive' };
  return { url: '', url_label: '' };
}
export async function sendDiscord() {
  const t = player.current;
  const activity = t ? {
    title: t.title, artist: t.artist || 'Unknown artist', album: t.album || '', cover: await webCover(t),
    position: player.position, duration: player.live ? 0 : player.duration, playing: player.playing, ...shareLink(t),
  } : null;
  return invoke('discord_update', { activity });
}
const discordSoon = throttle(() => {
  if (!state.settings.discord_enabled || !state.settings.discord_app_id) {
    invoke('discord_update', { activity: null }).catch(() => {}); // clears a status that was showing
    return;
  }
  sendDiscord().catch((e) => console.warn('discord', e));
}, 2000);
export const refreshDiscord = () => discordSoon();

function updateMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  const cover = coverOf(t, true);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist || '', album: t.album || '',
    artwork: cover ? [{ src: cover, sizes: '512x512' }] : [],
  });
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => play());
  ms.setActionHandler('pause', () => pause());
  ms.setActionHandler('nexttrack', () => next());
  ms.setActionHandler('previoustrack', () => prev());
  ms.setActionHandler('seekto', (e) => seek(e.seekTime));
  ms.setActionHandler('seekforward', () => seekBy(10));
  ms.setActionHandler('seekbackward', () => seekBy(-10));
}
setInterval(() => {
  if (!('mediaSession' in navigator) || !player.current || player.live) return;
  const d = player.duration;
  if (isFinite(d) && d > 0) { try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(player.position, d), playbackRate: state.settings.speed || 1 }); } catch { /* ignore */ } }
}, 5000);

// ---------- session restore ----------
const saveSession = debounce(() => {
  invoke('store_save', {
    name: 'session',
    value: { queue: player.queue.slice(0, 500).map(slim), index: player.index, position: player.position, context: player.context },
  }).catch(() => {});
}, 1500);
setInterval(() => player.playing && saveSession(), 15000);

export async function restoreSession() {
  const s = await invoke('store_load', { name: 'session' }).catch(() => null);
  if (!s?.queue?.length) return;
  player.queue = s.queue;
  player.index = Math.min(s.index || 0, s.queue.length - 1);
  player.current = player.queue[player.index];
  player.context = s.context;
  player.pendingPosition = s.position || 0;
  emit('track', player.current);
  emit('queue');
}

applyVolume();
