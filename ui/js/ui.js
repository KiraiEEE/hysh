// Hysh - small UI toolkit: icons, DOM builder, menus, modals, toasts, virtual lists. GPL-3.0-or-later

// 24x24 stroke icons drawn for Hysh
const P = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  library: 'M4 4v16M9 4v16M14 5l5 15',
  radio: 'M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M12 12h.01',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  play: 'M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z',
  pause: 'M7 4h3.5v16H7zM13.5 4H17v16h-3.5z',
  next: 'M5 5v14l10-7zM18 5v14',
  prev: 'M19 5v14L9 12zM6 5v14',
  shuffle: 'M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5',
  repeat: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
  repeat1: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3M11 10h1v4',
  heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z',
  lyrics: 'M4 6h16M4 10h10M4 14h16M4 18h8',
  queue: 'M3 6h13M3 12h13M3 18h9M17 15l4 3-4 3z',
  volume: 'M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14',
  volume1: 'M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7',
  mute: 'M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6',
  plus: 'M12 5v14M5 12h14',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  sidebar: 'M4 5h16v14H4zM9 5v14',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  close: 'M6 6l12 12M18 6 6 18',
  min: 'M5 12h14',
  max: 'M5 5h14v14H5z',
  restore: 'M8 8h11v11H8zM5 16V5h11',
  left: 'M15 18l-6-6 6-6',
  right: 'M9 18l6-6-6-6',
  down: 'M6 9l6 6 6-6',
  folder: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  disc: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  user: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  expand: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  widget: 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM13 13h5v4h-5z',
  note: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  spark: 'M12 3l1.9 5.6L19.5 10.5 13.9 12.4 12 18l-1.9-5.6L4.5 10.5l5.6-1.9z',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  link: 'M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  upload: 'M12 21V9M7 14l5-5 5 5M5 3h14',
  check: 'M5 12l5 5L20 7',
  mic: 'M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3zM19 11a7 7 0 0 1-14 0M12 18v3',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
};
const FILLED = new Set(['play', 'pause']);

export function icon(name, cls = '') {
  const filled = FILLED.has(name) || cls.includes('fill');
  return `<svg class="i ${filled ? 'fill' : ''} ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${P[name] || P.note}"/></svg>`;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** html`...` -> DocumentFragment-less element (first child) */
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtLong(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} hr ${m} min` : `${m} min`;
}

export function fmtNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function throttle(fn, ms) {
  let last = 0, timer;
  return (...a) => {
    const now = Date.now();
    clearTimeout(timer);
    if (now - last >= ms) { last = now; fn(...a); }
    else timer = setTimeout(() => { last = Date.now(); fn(...a); }, ms - (now - last));
  };
}

// ---------- toasts ----------
export function toast(msg, isErr = false, ms = 3200) {
  const t = el(`<div class="toast ${isErr ? 'err' : ''}">${esc(msg)}</div>`);
  $('#toasts').append(t);
  setTimeout(() => {
    t.classList.add('out');
    t.addEventListener('animationend', () => t.remove(), { once: true });
    setTimeout(() => t.remove(), 400); // reduced motion: no animationend
  }, ms);
}

// ---------- context menu ----------
const menu = () => $('#menu');
export function openMenu(x, y, items) {
  const m = menu();
  m.innerHTML = '';
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.append(el('<div class="mi-sep"></div>')); continue; }
    if (it.head) { m.append(el(`<div class="mi-head">${esc(it.head)}</div>`)); continue; }
    const b = el(`<button class="mi">${icon(it.icon || 'note')}<span>${esc(it.label)}</span></button>`);
    b.onclick = (e) => { e.stopPropagation(); closeMenu(); it.action?.(); };
    m.append(b);
  }
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}
export function closeMenu() { menu().classList.add('hidden'); }
addEventListener('click', closeMenu);
addEventListener('blur', closeMenu);
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// ---------- modal ----------
export function modal(html, onMount) {
  return new Promise((resolve) => {
    const wrap = $('#modal'), card = $('#modal-card');
    card.innerHTML = html;
    wrap.classList.remove('hidden');
    const done = (v) => { wrap.classList.add('hidden'); card.innerHTML = ''; resolve(v); };
    wrap.onclick = (e) => { if (e.target === wrap) done(null); };
    card.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => done(null)));
    onMount?.(card, done);
    card.querySelector('input')?.focus();
  });
}

export function prompt(title, label, value = '', okText = 'Save') {
  return modal(`<h3>${esc(title)}</h3><p>${esc(label)}</p><input class="input" id="pv" value="${esc(value)}">
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="pok">${esc(okText)}</button></div>`,
  (card, done) => {
    const inp = card.querySelector('#pv');
    card.querySelector('#pok').onclick = () => done(inp.value.trim());
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim()); };
  });
}

export function confirmBox(title, text, okText = 'OK') {
  return modal(`<h3>${esc(title)}</h3><p>${esc(text)}</p>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="cok">${esc(okText)}</button></div>`,
  (card, done) => { card.querySelector('#cok').onclick = () => done(true); });
}

// ---------- images ----------
export function img(src, fallbackIcon = 'note', round = false) {
  if (!src) return `<div class="ph">${icon(fallbackIcon)}</div>`;
  return `<img src="${esc(src)}" loading="lazy" decoding="async" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',innerHTML:window.__phIcon('${fallbackIcon}')}))">`;
}
window.__phIcon = (n) => icon(n);

/** Fixed-height virtual list - keeps 10k-song libraries smooth. */
export function virtualList(scroller, container, items, rowH, render) {
  container.classList.add('vlist');
  container.style.height = items.length * rowH + 'px';
  const inner = el('<div class="vlist-inner"></div>');
  container.innerHTML = '';
  container.append(inner);
  let start = -1, end = -1;
  const draw = () => {
    const top = container.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const visTop = Math.max(0, -top);
    const s = Math.max(0, Math.floor(visTop / rowH) - 8);
    const e = Math.min(items.length, Math.ceil((visTop + scroller.clientHeight) / rowH) + 8);
    if (s === start && e === end) return;
    start = s; end = e;
    inner.style.transform = `translateY(${s * rowH}px)`;
    const frag = document.createDocumentFragment();
    for (let i = s; i < e; i++) frag.append(render(items[i], i));
    inner.replaceChildren(frag);
  };
  const onScroll = () => requestAnimationFrame(draw);
  scroller.addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll);
  draw();
  return { redraw: () => { start = -1; draw(); }, destroy: () => { scroller.removeEventListener('scroll', onScroll); removeEventListener('resize', onScroll); } };
}

// ---------- artwork colour ----------
const colorCache = new Map();
/** Picks one vivid, readable accent ("r,g,b") from an image. Needs CORS (the local server sends it). */
export function artColors(src) {
  if (!src) return Promise.resolve(null);
  if (colorCache.has(src)) return Promise.resolve(colorCache.get(src));
  return new Promise((resolve) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(im, 0, 0, 24, 24);
        const d = x.getImageData(0, 0, 24, 24).data;
        const buckets = new Map();
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const l = (max + min) / 510;
          const sat = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
          const w = sat * sat * (l > 0.2 && l < 0.8 ? 1 : 0.1);
          const key = `${r >> 5},${g >> 5},${b >> 5}`;
          const cur = buckets.get(key) || { r: 0, g: 0, b: 0, w: 0 };
          cur.r += r * w; cur.g += g * w; cur.b += b * w; cur.w += w;
          buckets.set(key, cur);
        }
        const best = [...buckets.values()].sort((a, b) => b.w - a.w)[0];
        // greyscale artwork: keep the default signal colour
        const res = best && best.w > 2 ? liftColor([best.r / best.w, best.g / best.w, best.b / best.w]).join(',') : null;
        colorCache.set(src, res);
        resolve(res);
      } catch { resolve(null); }
    };
    im.onerror = () => resolve(null);
    im.src = src;
  });
}
function liftColor([r, g, b]) {
  // keep the accent visible on a near-black background
  const l = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
  if (l < 120) { const k = 120 / Math.max(l, 1); r = Math.min(255, r * k); g = Math.min(255, g * k); b = Math.min(255, b * k); }
  return [r, g, b].map(Math.round);
}

/**
 * Paints an image into a tiny canvas with a light blur; CSS stretches the canvas, so the
 * compositor produces what looks like a heavy blur for almost no CPU, GPU or memory.
 * `stillWanted()` lets callers drop a result that arrives after the song changed.
 */
export function paintGlow(canvas, src, stillWanted = () => true) {
  canvas.classList.remove('ready');
  if (!src) return;
  const im = new Image();
  im.crossOrigin = 'anonymous';
  im.onload = () => {
    if (!stillWanted()) return;
    const g = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    g.filter = 'blur(2px) saturate(1.25)';
    g.drawImage(im, -w * 0.12, -h * 0.12, w * 1.24, h * 1.24);
    g.filter = 'none';
    canvas.classList.add('ready');
  };
  im.src = src;
}

/** Pointer-driven slider (seek / volume). */
export function slider(node, { onInput, onCommit }) {
  const pct = (e) => { const r = node.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  node.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    node.setPointerCapture(e.pointerId);
    node.classList.add('drag');
    onInput?.(pct(e));
    const move = (ev) => onInput?.(pct(ev));
    const up = (ev) => {
      node.classList.remove('drag');
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      onCommit?.(pct(ev));
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
  });
}
const sliderParts = new WeakMap();
/** Moves a slider with transforms only (no layout), skipping updates that would not change a pixel. */
export function setSlider(node, p, buffered) {
  let parts = sliderParts.get(node);
  if (!parts) {
    parts = { fill: node.querySelector('.fill'), knob: node.querySelector('.knob'), buffer: node.querySelector('.buffer'), p: -1, b: -1 };
    sliderParts.set(node, parts);
  }
  const v = Math.min(1, Math.max(0, p || 0));
  if (Math.abs(v - parts.p) > 0.0004) {
    parts.p = v;
    parts.fill.style.transform = `scaleX(${v})`;
    if (parts.knob) parts.knob.style.left = v * 100 + '%';
  }
  if (buffered != null && parts.buffer && Math.abs(buffered - parts.b) > 0.005) {
    parts.b = buffered;
    parts.buffer.style.transform = `scaleX(${Math.min(1, buffered)})`;
  }
}

/** Plays the element's exit animation (class "leaving"), then hides it. */
export function hideAnimated(node, hiddenClass = 'hidden') {
  if (node.classList.contains(hiddenClass)) return Promise.resolve();
  const reduce = document.body.classList.contains('reduce-fx') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { node.classList.add(hiddenClass); return Promise.resolve(); }
  return new Promise((resolve) => {
    node.classList.add('leaving');
    const done = () => { node.classList.remove('leaving'); node.classList.add(hiddenClass); resolve(); };
    node.addEventListener('animationend', done, { once: true });
    setTimeout(() => { if (node.classList.contains('leaving')) done(); }, 400); // safety net
  });
}
