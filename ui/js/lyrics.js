// Hysh - synced lyrics view (word-level karaoke when the provider has it). GPL-3.0-or-later
import { invoke, env } from './api.js';
import { esc, el, icon } from './ui.js';
import { state } from './store.js';

const cache = new Map();   // track id -> Promise<lyrics|null>
const LEAD_MS = 120;        // highlight slightly early, it feels more in time

export function fetchLyrics(t, provider = null) {
  if (!t || t.live) return Promise.resolve(null);
  const key = t.id + (provider || '');
  if (!cache.has(key)) {
    const p = invoke('lyrics_get', {
      query: { title: t.title, artist: t.artist || '', album: t.album || '', duration: t.duration || 0, video_id: t.videoId || null, provider },
    }).catch((e) => { console.warn('lyrics', e); return null; });
    cache.set(key, p);
    p.then((v) => { if (!v) setTimeout(() => cache.delete(key), 60_000); });
  }
  return cache.get(key);
}

/**
 * Mounts a lyrics view. Returns { update(posSec), destroy() }.
 * onSeek(sec) is called when a line is clicked.
 */
export function mountLyrics(host, track, { small = false, onSeek } = {}) {
  let lyr = null, lines = [], nodes = [], active = -2, userScrollUntil = 0, dead = false;
  const box = el(`<div class="lyrics ${small ? 'small' : ''}"><div class="spinner"></div></div>`);
  host.replaceChildren(box);
  box.addEventListener('wheel', () => (userScrollUntil = Date.now() + 3500), { passive: true });

  const render = (data, provider) => {
    if (dead) return;
    lyr = data;
    if (!data || !data.lines?.length) {
      box.className = 'lyrics-wrap';
      box.innerHTML = `<div class="ly-empty"><div><div class="big">${track?.live ? 'Live radio' : 'No lyrics found'}</div>
        <div>${track?.live ? 'Lyrics are not available for radio streams.' : 'None of the lyrics sources had this song.'}</div>
        ${track?.live ? '' : `<div class="ly-foot" style="justify-content:center">${providerButtons(provider)}</div>`}</div></div>`;
      wireProviders();
      return;
    }
    lines = data.lines;
    box.className = `lyrics ${small ? 'small' : ''} ${data.level === 0 ? 'plain' : ''} ${state.settings.lyrics_size === 'large' ? 'large' : ''}`;
    const frag = document.createDocumentFragment();
    nodes = lines.map((ln, i) => {
      const n = document.createElement('div');
      n.className = 'ly-line' + (ln.singer && /2|right/.test(ln.singer) ? ' right' : '');
      n.dataset.i = i;
      if (ln.words?.length && data.level === 2) {
        n.classList.add('words');
        const main = ln.words.filter((w) => !w.bg);
        const bg = ln.words.filter((w) => w.bg);
        n.innerHTML = main.map((w, j) => `<span class="w" data-j="${j}">${esc(w.text)}</span>`).join('')
          + (bg.length ? `<span class="bg-vocal">${bg.map((w) => `<span class="w">${esc(w.text)}</span>`).join('')}</span>` : '');
        n._words = [...n.querySelectorAll('.w')].map((span, k) => ({ span, w: k < main.length ? main[k] : bg[k - main.length] }));
      } else {
        n.textContent = ln.text || (data.level ? '♪' : '');
        if (!ln.text && data.level) n.classList.add('interlude');
      }
      if (data.level > 0) n.onclick = () => onSeek?.(ln.t / 1000);
      frag.append(n);
      return n;
    });
    box.replaceChildren(frag);
    const foot = el(`<div class="ly-foot">${icon('lyrics')}<span>Lyrics from ${esc(data.provider)}${data.level === 2 ? ' · word-synced' : data.level === 1 ? ' · synced' : ''}</span>${providerButtons(data.provider)}</div>`);
    box.append(foot);
    wireProviders();
    active = -2;
    if (data.level === 0) box.scrollTop = 0;
  };

  const providerButtons = (currentName) => (env.lyricProviders || [])
    .map((p) => `<button class="chip" data-prov="${p}" ${currentName && currentName.toLowerCase().startsWith(p.slice(0, 4)) ? 'style="opacity:.5"' : ''}>${p}</button>`).join('');
  const wireProviders = () => box.querySelectorAll('[data-prov]').forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    box.innerHTML = '<div class="spinner"></div>';
    render(await fetchLyrics(track, b.dataset.prov), b.dataset.prov);
  }));

  if (!track) render(null);
  else fetchLyrics(track).then((d) => render(d, d?.provider));

  return {
    update(pos) {
      if (!lyr || lyr.level === 0 || !nodes.length || dead) return;
      const ms = pos * 1000 + LEAD_MS;
      // binary search for the last line that started
      let lo = 0, hi = lines.length - 1, idx = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (lines[mid].t <= ms) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
      if (idx !== active) {
        const prevNode = nodes[active];
        if (prevNode) prevNode.classList.remove('active');
        active = idx;
        // depth by distance from the active line (opacity only: no per-line blur filters to repaint)
        nodes.forEach((n, i) => {
          n.classList.toggle('past', i < idx);
          n.style.opacity = i === idx ? '' : String(Math.max(0.35, 1 - Math.abs(i - idx) * 0.13));
        });
        const cur = nodes[idx];
        if (cur) {
          cur.classList.add('active');
          if (Date.now() > userScrollUntil) {
            const target = cur.offsetTop - box.clientHeight * (small ? 0.32 : 0.38);
            box.scrollTo({ top: target, behavior: 'smooth' });
          }
        }
      }
      const cur = nodes[idx];
      if (cur?._words) {
        for (const ws of cur._words) {
          const { span, w } = ws;
          const p = w.d > 0 ? (ms - w.t) / w.d : ms >= w.t ? 1 : 0;
          const c = Math.round(Math.max(0, Math.min(1, p)) * 200) / 2; // 0.5 % steps
          if (c === ws.last) continue; // nothing to repaint
          ws.last = c;
          span.style.setProperty('--p', `${(c * 1.06).toFixed(1)}%`);
        }
      }
    },
    destroy() { dead = true; },
  };
}
