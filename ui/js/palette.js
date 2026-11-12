// Hysh - command palette (Ctrl+K). GPL-3.0-or-later
// One keyboard-first box for everything: actions, your playlists and library, and catalog songs.
import { $, el, esc, icon, debounce } from './ui.js';
import { state } from './store.js';
import { deezer, local, coverOf, norm } from './sources.js';
import { playList } from './player.js';
import { go } from './components.js';

let actions = [];   // [{ title, hint, icon, keywords, run }]
let items = [];     // flattened, selectable results
let sel = 0;
let seq = 0;

/** The app shell hands over the actions it owns (panels, player, themes...). */
export function initPalette(appActions) {
  actions = appActions;
  const input = $('#pal-input');
  $('.pal-icon').innerHTML = icon('search');
  input.addEventListener('input', () => { sel = 0; render(input.value); searchCatalog(input.value); });
  input.addEventListener('keydown', onKey);
  $('#palette').addEventListener('mousedown', (e) => { if (e.target.id === 'palette') closePalette(); });
}

export function openPalette() {
  const box = $('#palette');
  if (!box.classList.contains('hidden')) return;
  box.classList.remove('hidden');
  const input = $('#pal-input');
  input.value = '';
  sel = 0;
  render('');
  input.focus();
}

export function closePalette() {
  $('#palette').classList.add('hidden');
}

const matches = (q, ...fields) => {
  const words = norm(q).split(' ').filter(Boolean);
  const hay = norm(fields.join(' '));
  return words.every((w) => hay.includes(w));
};

let catalog = [];
const searchCatalog = debounce(async (q) => {
  const mine = ++seq;
  catalog = [];
  if (norm(q).length < 2) return;
  const songs = await deezer.search(q, 'track', 6).catch(() => []);
  if (mine !== seq) return;
  catalog = songs;
  render($('#pal-input').value);
}, 220);

function render(q) {
  const groups = [];
  const acts = q ? actions.filter((a) => matches(q, a.title, a.keywords || '')) : actions.filter((a) => a.featured);
  if (acts.length) groups.push(['Actions', acts.slice(0, 8).map((a) => ({ ...a, kind: 'action' }))]);
  if (q) {
    const lists = state.playlists.filter((p) => matches(q, p.name)).slice(0, 4)
      .map((p) => ({ kind: 'playlist', title: p.name, sub: `${p.tracks.length} songs`, img: p.cover || coverOf(p.tracks[0]), run: () => go('playlist', { id: p.id }) }));
    if (lists.length) groups.push(['Your playlists', lists]);
    const mine = local.search(q).slice(0, 5)
      .map((t, i, all) => ({ kind: 'song', title: t.title, sub: `${t.artist} · your library`, img: coverOf(t), run: () => playList(all.map((x) => x), i, { label: 'Search' }) }));
    if (mine.length) groups.push(['In your library', mine]);
    if (catalog.length) groups.push(['Songs', catalog.map((t, i) => ({ kind: 'song', title: t.title, sub: t.artist, img: coverOf(t), run: () => playList(catalog, i, { label: `Search: ${q}` }) }))]);
    groups.push(['', [{ kind: 'search', title: `Search for “${q}”`, sub: 'Every source', icon: 'search', hint: 'Enter', run: () => go('search', { q }) }]]);
  }
  items = groups.flatMap(([, list]) => list);
  sel = Math.min(sel, Math.max(0, items.length - 1));
  const box = $('#pal-list');
  box.replaceChildren();
  let n = 0;
  for (const [name, list] of groups) {
    if (name) box.append(el(`<div class="pal-group">${esc(name)}</div>`));
    for (const it of list) {
      const i = n++;
      const row = el(`<button class="pal-item ${i === sel ? 'sel' : ''}" role="option">
        <span class="pi">${it.img ? `<img src="${esc(it.img)}" alt="" loading="lazy">` : icon(it.icon || 'note')}</span>
        <span class="pt"><b>${esc(it.title)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>
        ${it.hint ? `<span class="ph2">${it.hint.split(' ').map((k) => `<kbd>${esc(k)}</kbd>`).join('')}</span>` : ''}</button>`);
      row.onmousemove = () => { if (sel !== i) { sel = i; highlight(); } };
      row.onclick = () => run(i);
      box.append(row);
    }
  }
}

function highlight() {
  const rows = [...$('#pal-list').querySelectorAll('.pal-item')];
  rows.forEach((r, i) => r.classList.toggle('sel', i === sel));
  rows[sel]?.scrollIntoView({ block: 'nearest' });
}

function run(i) {
  const it = items[i];
  if (!it) return;
  closePalette();
  it.run();
}

function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); highlight(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); highlight(); }
  else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
}
