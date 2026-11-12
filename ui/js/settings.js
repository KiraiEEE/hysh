// Hysh - settings page. GPL-3.0-or-later
import { invoke, dialog, env, listen } from './api.js';
import { el, esc, icon, toast, modal } from './ui.js';
import { applyTheme, setMaterial, pluginThemes } from './theme.js';
import { listPlugins, loaded as loadedPlugins } from './plugins.js';
import { openImportDialog, exportBackup, openRestore } from './importexport.js';
import { state, setSetting, rescanLibrary, flushSettings } from './store.js';
import { EQ_FREQS, EQ_PRESETS, applyEq, applySpeed, setSleep, refreshDiscord, sendDiscord, player } from './player.js';
import { web, subsonic } from './sources.js';

const S = () => state.settings;

function section(id, title, desc) {
  return el(`<section class="set-section" id="set-${id}"><h2>${esc(title)}</h2>${desc ? `<p>${desc}</p>` : ''}</section>`);
}
function row(label, sub, control) {
  const r = el(`<div class="set-row"><div class="lbl"><b>${esc(label)}</b>${sub ? `<small>${sub}</small>` : ''}</div></div>`);
  if (control) r.append(control);
  return r;
}
function toggle(key, after) {
  const b = el(`<button class="switch ${S()[key] ? 'on' : ''}" role="switch" aria-checked="${!!S()[key]}"></button>`);
  b.onclick = () => { const v = !S()[key]; setSetting(key, v); b.classList.toggle('on', v); b.setAttribute('aria-checked', v); after?.(v); };
  return b;
}
function input(key, { placeholder = '', type = 'text', width, after } = {}) {
  const i = el(`<input class="input" type="${type}" placeholder="${esc(placeholder)}" value="${esc(S()[key] ?? '')}" spellcheck="false" autocomplete="off">`);
  if (width) i.style.minWidth = width;
  i.onchange = () => { setSetting(key, type === 'number' ? Number(i.value) : i.value.trim()); after?.(i.value.trim()); };
  return i;
}
function select(key, options, after) {
  const s = el(`<select class="input" style="min-width:180px">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(S()[key]) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`);
  s.onchange = () => { const v = typeof S()[key] === 'number' ? Number(s.value) : s.value; setSetting(key, v); after?.(v); };
  return s;
}
function btn(label, iconName, onClick, cls = '') {
  const b = el(`<button class="btn ${cls}">${iconName ? icon(iconName) : ''}${esc(label)}</button>`);
  b.onclick = onClick;
  return b;
}
function group(...nodes) { const g = el('<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"></div>'); nodes.forEach((n) => g.append(n)); return g; }

// Each skin changes palette, corner radius and type, not just the accent colour.
export const THEMES = [
  { id: 'graphite', name: 'Graphite', note: 'Warm dark, the default', bg: '#0f0f0e', fg: '#ecebe6', ac: '#ff5b37' },
  { id: 'void', name: 'Void', note: 'True black for OLED', bg: '#000000', fg: '#f0f0f0', ac: '#ff5b37' },
  { id: 'paper', name: 'Paper', note: 'Light, ink on paper', bg: '#f3f0e8', fg: '#1d1b17', ac: '#d64020' },
  { id: 'studio', name: 'Studio', note: 'Hi-fi hardware, amber', bg: '#121212', fg: '#e2ded2', ac: '#ffb000' },
  { id: 'frost', name: 'Frost', note: 'Cool blue, soft corners', bg: '#0e141b', fg: '#e2eaf2', ac: '#6cb6ff' },
  { id: 'phosphor', name: 'Phosphor', note: 'Green CRT terminal', bg: '#040704', fg: '#8cff96', ac: '#33ff66' },
  { id: 'velvet', name: 'Velvet', note: 'Plum with serif type', bg: '#140d14', fg: '#f4e8f0', ac: '#ff6fae' },
  { id: 'dune', name: 'Dune', note: 'Warm desert dark', bg: '#17130f', fg: '#f0e4d2', ac: '#e0a458' },
];

function themePicker() {
  const current = { dark: 'graphite', oled: 'void' }[S().theme] || S().theme || 'graphite';
  const box = el('<div class="themes" role="radiogroup" aria-label="Theme"></div>');
  for (const t of [...THEMES, ...pluginThemes]) {
    const c = el(`<button class="theme-card ${t.id === current ? 'active' : ''}" role="radio" aria-checked="${t.id === current}">
      <div class="sw" style="background:${t.bg}"><i style="background:${t.ac}"></i><div class="bars"><b style="background:${t.fg};width:70%"></b><b style="background:${t.fg};opacity:.45;width:45%"></b></div></div>
      <div class="nm">${esc(t.name)}<small>${esc(t.note || (t.plugin ? 'From a plugin' : ''))}</small></div></button>`);
    c.onclick = () => {
      setSetting('theme', t.id);
      applyTheme(t.id);
      box.querySelectorAll('.theme-card').forEach((n) => { n.classList.toggle('active', n === c); n.setAttribute('aria-checked', n === c); });
    };
    box.append(c);
  }
  return box;
}

export async function renderSettings(root, params = {}) {
  root.classList.add('settings');
  root.append(el('<h1 class="page">Settings</h1>'));

  // ---------- library ----------
  const lib = section('library', 'Library', 'Folders Hysh watches for music. Tags and covers are read locally; nothing leaves your PC.');
  const list = el('<div class="folder-list"></div>');
  const drawFolders = () => {
    list.innerHTML = '';
    (S().music_folders || []).forEach((f, i) => {
      const r = el(`<div class="folder">${icon('folder')}<span>${esc(f)}</span><button class="icon-btn small" title="Remove">${icon('close')}</button></div>`);
      r.querySelector('button').onclick = () => { const a = S().music_folders.slice(); a.splice(i, 1); setSetting('music_folders', a); drawFolders(); };
      list.append(r);
    });
    if (!(S().music_folders || []).length) list.append(el('<div class="note">No folders yet.</div>'));
  };
  drawFolders();
  lib.append(list);
  const status = el(`<span class="note">${state.library.length} songs in library</span>`);
  const scan = async () => {
    status.textContent = 'Scanning…';
    const un = await listen('scan-progress', (e) => (status.textContent = `Scanning… ${e.payload} files`));
    try { await flushSettings(); const n = await rescanLibrary(); status.textContent = `${n} songs in library`; toast(`Library updated: ${n} songs`); }
    catch (e) { status.textContent = String(e); }
    finally { un(); }
  };
  lib.append(group(
    btn('Add folder', 'plus', async () => {
      const picked = await dialog.open({ directory: true, multiple: true, title: 'Choose music folders' });
      const arr = Array.isArray(picked) ? picked : picked ? [picked] : [];
      if (!arr.length) return;
      setSetting('music_folders', [...new Set([...(S().music_folders || []), ...arr])]);
      drawFolders();
      scan();
    }, 'primary'),
    btn('Rescan', 'refresh', scan), status,
  ));
  root.append(lib);

  // ---------- sources ----------
  const src = section('sources', 'Sources', 'Search and charts come from Deezer, Apple Music, Radio Browser and the Internet Archive with no setup. For full-length catalog songs, Hysh looks for a playable copy in the order below.');
  const order = el('<div class="folder-list"></div>');
  const names = { local: 'Your music folders', subsonic: 'Your Subsonic / Navidrome server', youtube: 'YouTube Music audio (via yt-dlp)' };
  const drawOrder = () => {
    order.innerHTML = '';
    const arr = S().resolver;
    arr.forEach((k, i) => {
      const r = el(`<div class="folder"><b style="width:18px;color:var(--text-3)">${i + 1}</b><span>${names[k] || k}</span>
        <button class="icon-btn small" title="Up" ${i === 0 ? 'disabled' : ''}>${icon('left')}</button><button class="icon-btn small" title="Down" ${i === arr.length - 1 ? 'disabled' : ''}>${icon('right')}</button></div>`);
      r.querySelector('[title=Up]').style.transform = 'rotate(90deg)';
      r.querySelector('[title=Down]').style.transform = 'rotate(90deg)';
      const mv = (d) => { const a = arr.slice(); [a[i], a[i + d]] = [a[i + d], a[i]]; setSetting('resolver', a); drawOrder(); };
      r.querySelector('[title=Up]').onclick = () => mv(-1);
      r.querySelector('[title=Down]').onclick = () => mv(1);
      order.append(r);
    });
  };
  drawOrder();
  src.append(order);

  // YouTube
  const ytStatus = el('<span class="note">Checking…</span>');
  const ytInstall = btn('Install yt-dlp', 'download', async () => {
    ytInstall.disabled = true; ytStatus.textContent = 'Downloading yt-dlp from GitHub…';
    try { const s = await invoke('yt_install'); await web.available(true); ytStatus.innerHTML = `<span class="ok">Installed ${esc(s.version || '')}</span>`; }
    catch (e) { ytStatus.innerHTML = `<span class="bad">${esc(String(e))}</span>`; } finally { ytInstall.disabled = false; }
  });
  invoke('yt_status').then((s) => { ytStatus.innerHTML = s.available ? `<span class="ok">yt-dlp ${esc(s.version)} found</span>` : 'Not installed'; ytInstall.lastChild.textContent = s.available ? 'Update yt-dlp' : 'Install yt-dlp'; });
  src.append(row('Full-length playback (YouTube, SoundCloud, Bandcamp & links)', 'Powered by <b>yt-dlp</b>, an open-source tool that Hysh sets up automatically the first time it is needed. Played songs are cached (see Playback). Streaming from these sites may go against their terms of service.', group(ytStatus, ytInstall)));
  src.append(row('Custom yt-dlp path', 'Leave empty to use the installed copy or the one on your PATH.', input('ytdlp_path', { placeholder: 'C:\\tools\\yt-dlp.exe', after: () => web.available(true) })));

  // Subsonic
  const ssState = el('<span class="note"></span>');
  src.append(row('Subsonic / Navidrome / Airsonic / Gonic', 'Stream your own music server. Password is sent as a salted token, never in clear.', group(
    input('subsonic_url', { placeholder: 'https://music.example.com', width: '220px' }),
    input('subsonic_user', { placeholder: 'user', width: '120px' }),
    input('subsonic_pass', { placeholder: 'password', type: 'password', width: '140px' }),
    btn('Test', 'check', async () => { ssState.textContent = '…'; try { await flushSettings(); await subsonic.ping(); ssState.innerHTML = '<span class="ok">Connected</span>'; } catch (e) { ssState.innerHTML = `<span class="bad">${esc(e.message || e)}</span>`; } }),
    ssState,
  )));
  src.append(row('Jamendo', 'Free, legal music. Get a free client ID at devportal.jamendo.com.', input('jamendo_client_id', { placeholder: 'client id' })));
  // Spotify: official login (PKCE). The user signs in on spotify.com; Hysh never sees the password.
  const spState = el(`<span class="note">${S().spotify_user ? `<span class="ok">Connected as ${esc(S().spotify_user)}</span>` : 'Not connected'}</span>`);
  const spButton = btn(S().spotify_user ? 'Disconnect' : 'Connect Spotify', 'link', async () => {
    if (S().spotify_user) {
      await invoke('spotify_disconnect');
      state.settings.spotify_user = null; state.settings.spotify_refresh = null;
      spState.textContent = 'Not connected'; spButton.lastChild.textContent = 'Connect Spotify';
      return;
    }
    await flushSettings();
    spState.textContent = 'Waiting for you to sign in, in your browser…';
    try {
      const r = await invoke('spotify_connect');
      state.settings.spotify_user = r.user;
      spState.innerHTML = `<span class="ok">Connected as ${esc(r.user)}</span>`;
      spButton.lastChild.textContent = 'Disconnect';
    } catch (e) { spState.innerHTML = `<span class="bad">${esc(String(e))}</span>`; }
  });
  src.append(row('Spotify',
    'Imports your Liked Songs and playlists (Library › Import). One-time setup: at <b>developer.spotify.com/dashboard</b> create an app, add the Redirect URI <b>http://127.0.0.1:43821/callback</b>, tick <b>Web API</b>, then paste the app’s Client ID here and press Connect. You sign in on Spotify’s own page.',
    group(input('spotify_client_id', { placeholder: 'Client ID', width: '200px' }), spButton, spState)));
  src.append(row('Country', 'For charts and local radio.', select('country', ['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'ES', 'IT', 'NL', 'SE', 'BR', 'MX', 'JP', 'KR', 'IN', 'TR', 'SA', 'AE', 'EG', 'MA', 'DZ', 'TN', 'NG', 'ZA'].map((c) => [c, c]))));
  root.append(src);

  // ---------- playback ----------
  const pb = section('playback', 'Playback');
  const cfVal = el(`<span class="note" style="width:36px">${S().crossfade}s</span>`);
  const cf = el(`<input type="range" min="0" max="12" step="1" value="${S().crossfade}">`);
  cf.oninput = () => { cfVal.textContent = cf.value + 's'; setSetting('crossfade', Number(cf.value)); };
  pb.append(row('Crossfade', 'Blend the end of a song into the next one. 0 = gapless.', group(cf, cfVal)));
  pb.append(row('Autoplay', 'When the queue ends, keep playing similar music.', toggle('autoplay')));
  pb.append(row('Playback speed', '', select('speed', [[0.5, '0.5×'], [0.75, '0.75×'], [0.9, '0.9×'], [1, 'Normal'], [1.1, '1.1×'], [1.25, '1.25×'], [1.5, '1.5×'], [2, '2×']], () => applySpeed())));
  pb.append(row('Skip non-music parts', 'Uses SponsorBlock to skip intros, talking and ads inside YouTube music videos.', toggle('sponsorblock')));
  pb.append(row('YouTube cache size', 'Songs fetched with yt-dlp are kept so replays are instant.', select('cache_mb', [[256, '256 MB'], [512, '512 MB'], [1024, '1 GB'], [2048, '2 GB'], [5120, '5 GB'], [10240, '10 GB']])));
  const sleepState = el('<span class="note"></span>');
  const drawSleep = () => { const r = player.sleepRemaining; sleepState.textContent = r === -1 ? 'After this song' : r > 0 ? `${Math.ceil(r / 60)} min left` : 'Off'; };
  drawSleep();
  pb.append(row('Sleep timer', '', group(...[15, 30, 45, 60, 90].map((m) => btn(`${m}m`, null, () => { setSleep(m); drawSleep(); })), btn('End of song', null, () => { setSleep('track'); drawSleep(); }), btn('Off', null, () => { setSleep(0); drawSleep(); }), sleepState)));

  // EQ
  const eqBox = el('<div class="eq"></div>');
  const pre = el(`<div class="band"><input type="range" min="-12" max="12" step="0.5" value="${S().preamp || 0}"><span>Pre</span></div>`);
  pre.querySelector('input').oninput = (e) => { setSetting('preamp', Number(e.target.value), { silent: true }); applyEq(); };
  eqBox.append(pre, el('<div style="width:1px;align-self:stretch;background:var(--line)"></div>'));
  const bands = EQ_FREQS.map((f, i) => {
    const b = el(`<div class="band"><input type="range" min="-12" max="12" step="0.5" value="${S().eq[i] || 0}"><span>${f >= 1000 ? f / 1000 + 'k' : f}</span></div>`);
    b.querySelector('input').oninput = (e) => { const a = S().eq.slice(); a[i] = Number(e.target.value); setSetting('eq', a, { silent: true }); applyEq(); };
    eqBox.append(b);
    return b.querySelector('input');
  });
  const presets = el(`<select class="input" style="min-width:150px"><option value="">Preset…</option>${Object.keys(EQ_PRESETS).map((p) => `<option>${p}</option>`).join('')}</select>`);
  presets.onchange = () => { const p = EQ_PRESETS[presets.value]; if (!p) return; setSetting('eq', p.slice(), { silent: true }); bands.forEach((b, i) => (b.value = p[i])); applyEq(); };
  pb.append(row('Equalizer', '10-band EQ, applied live to every source.', group(presets, toggle('eq_on', () => applyEq()))));
  pb.append(eqBox);
  root.append(pb);

  // ---------- lyrics & look ----------
  const look = section('appearance', 'Lyrics & appearance');
  look.append(row('Lyrics text size', 'Lyrics come from LyricsPlus (word-by-word), LRCLIB, SimpMusic, KuGou and NetEase.', select('lyrics_size', [['normal', 'Normal'], ['large', 'Large']])));
  look.append(row('Colours from album art', 'Tint the app with the colours of what is playing.', toggle('dynamic_color')));
  look.append(themePicker());
  look.append(row('Reduce effects', 'Turns off animation and the visualizer. Uses the least CPU.', toggle('reduce_fx', (v) => document.body.classList.toggle('reduce-fx', v))));
  look.append(row('Follow Windows animation setting', 'When Windows “Animation effects” is off, Hysh turns its animations off too.',
    toggle('motion_follow_system', (v) => document.body.classList.toggle('reduce-fx', !!S().reduce_fx || (v && matchMedia('(prefers-reduced-motion: reduce)').matches)))));
  look.append(row('Window material', 'Windows 11 backdrop behind the app. Your theme stays on top as a light tint, so only the edges pick up the wallpaper colour. Off uses the least GPU.',
    select('window_material', [['none', 'Off'], ['mica', 'Mica'], ['mica-alt', 'Mica Alt'], ['acrylic', 'Acrylic']], async (v) => {
      if (!(await setMaterial(v))) toast('Restart Hysh to turn the window material on');
    })));
  look.append(row('Rendering', '<b>Balanced</b> draws on the CPU and composites on the GPU: smooth and light. <b>Ultra-light</b> turns the GPU off for the smallest memory use (about 140 MB); animation gets less smooth. Takes effect after a restart.',
    select('render_mode', [['balanced', 'Balanced (recommended)'], ['ultralight', 'Ultra-light']], () => toast('Restart Hysh to apply'))));
  look.append(row('Animation speed', '', select('anim_speed', [[0.6, 'Fast'], [1, 'Normal'], [1.4, 'Relaxed']], (v) => document.documentElement.style.setProperty('--speed', v))));
  root.append(look);

  // ---------- scrobbling ----------
  const sc = section('scrobbling', 'Scrobbling', 'Songs count after you hear half of them (or 4 minutes), like the official clients.');
  sc.append(row('Scrobble', 'Send what you listen to the services below.', toggle('scrobble_enabled')));
  const lfState = el(`<span class="note">${S().lastfm_user ? `<span class="ok">Signed in as ${esc(S().lastfm_user)}</span>` : 'Not signed in'}</span>`);
  sc.append(row('Last.fm', 'Needs an API key and secret from last.fm/api/account/create.', group(input('lastfm_api_key', { placeholder: 'API key', width: '180px' }), input('lastfm_secret', { placeholder: 'shared secret', type: 'password', width: '160px' }),
    btn('Sign in', 'user', async () => {
      await flushSettings();
      const res = await modal(`<h3>Sign in to Last.fm</h3><p>Your password is only used once to get a session key; it is not stored.</p>
        <input class="input" id="lu" placeholder="Username"><input class="input" id="lp" type="password" placeholder="Password">
        <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="lok">Sign in</button></div>`,
      (card, done) => { card.querySelector('#lok').onclick = () => done({ u: card.querySelector('#lu').value, p: card.querySelector('#lp').value }); });
      if (!res?.u) return;
      try { const name = await invoke('lastfm_login', { user: res.u, pass: res.p }); state.settings.lastfm_user = name; lfState.innerHTML = `<span class="ok">Signed in as ${esc(name)}</span>`; }
      catch (e) { lfState.innerHTML = `<span class="bad">${esc(String(e))}</span>`; }
    }), lfState)));
  sc.append(row('ListenBrainz', 'Paste your user token from listenbrainz.org/settings.', input('listenbrainz_token', { placeholder: 'user token', type: 'password' })));
  root.append(sc);

  // ---------- discord ----------
  const dc = section('discord', 'Discord “Listening to” status', 'Shows the song, artist, album art, a live progress bar and a “Listen” button on your Discord profile. The Discord desktop app must be running.');
  dc.append(row('Show my music on Discord', '', toggle('discord_enabled', () => refreshDiscord())));
  const dcState = el('<span class="note"></span>');
  dc.append(row('Application ID',
    'One-time setup: open <b>discord.com/developers/applications</b> › New Application › name it <b>Hysh</b> (that name appears as “Listening to Hysh”) › copy the <b>Application ID</b> here.',
    group(input('discord_app_id', { placeholder: '123456789012345678', after: () => refreshDiscord() }),
      btn('Test', 'check', async () => {
        dcState.textContent = '…';
        await flushSettings();
        if (!S().discord_enabled) { dcState.innerHTML = '<span class="bad">Turn the switch on first</span>'; return; }
        try { await sendDiscord(); dcState.innerHTML = player.current ? '<span class="ok">Sent, check your Discord profile</span>' : '<span class="ok">Connected, play a song to see it</span>'; }
        catch (e) { dcState.innerHTML = `<span class="bad">${esc(String(e))}</span>`; }
      }), dcState)));
  dc.append(row('Album art', 'Online songs use their cover. Local files use a matching cover from Deezer, because Discord can only show images from the web.', null));
  root.append(dc);

  // ---------- downloads ----------
  const dl = section('downloads', 'Downloads', 'Downloaded songs play offline and also appear in your library.');
  const dlPath = el(`<span class="note">${esc(S().download_dir || env.downloadDir)}</span>`);
  dl.append(row('Download folder', '', group(dlPath,
    btn('Change', 'folder', async () => { const p = await dialog.open({ directory: true }); if (p) { setSetting('download_dir', p); dlPath.textContent = p; } }),
    btn('Open', 'external', () => invoke('open_path', { path: S().download_dir || env.downloadDir })))));
  dl.append(row('Lossless when available', 'Downloads <b>FLAC</b> or the original file when the source has one: Internet Archive, Jamendo and your Subsonic / Navidrome server. Sources that only stream lossy audio are never “upscaled”.', toggle('download_lossless')));
  dl.append(row('YouTube / SoundCloud format', 'These sites only stream lossy audio. <b>M4A</b> keeps title, artist, album and cover art in the file. <b>Original</b> keeps the site’s own stream (Opus on YouTube, slightly better, no embedded tags).',
    select('download_format', [['m4a', 'M4A (AAC) with tags'], ['best', 'Original stream (Opus)']])));
  dl.append(row('Download songs I like', 'Every song you like is downloaded automatically.', toggle('auto_download_likes')));
  root.append(dl);

  // ---------- plugins ----------
  const pl = section('plugins', 'Plugins', 'Add audio effects, music sources and themes made by the community. A plugin runs with the same access as Hysh, so only install ones from people you trust.');
  const plList = el('<div class="folder-list"><div class="note">Loading…</div></div>');
  pl.append(plList);
  listPlugins().then(({ dir, plugins }) => {
    plList.innerHTML = '';
    if (!plugins.length) plList.append(el('<div class="note">No plugins installed. Copy a plugin folder into the plugins folder, then press Reload.</div>'));
    for (const p of plugins) {
      const enabled = (S().plugins_enabled || []).includes(p.id);
      const status = loadedPlugins.get(p.id);
      const r = el(`<div class="folder">${icon('spark')}<span><b>${esc(p.name)}</b> ${esc(p.version || '')} <span class="note">${esc(p.author ? 'by ' + p.author + ' · ' : '')}${esc(p.error || status?.error || p.description || '')}</span></span></div>`);
      const sw = el(`<button class="switch ${enabled ? 'on' : ''}" role="switch" aria-checked="${enabled}" ${p.error ? 'disabled' : ''}></button>`);
      sw.onclick = () => {
        const set = new Set(S().plugins_enabled || []);
        if (set.has(p.id)) set.delete(p.id); else set.add(p.id);
        setSetting('plugins_enabled', [...set]);
        sw.classList.toggle('on', set.has(p.id));
        toast('Press Reload to apply plugin changes');
      };
      r.append(sw);
      plList.append(r);
    }
    pl.append(group(
      btn('Open plugins folder', 'folder', () => invoke('open_path', { path: dir })),
      btn('Reload', 'refresh', async () => { await flushSettings(); location.reload(); }),
    ));
  });
  root.append(pl);

  // ---------- data ----------
  const data = section('data', 'Your data', 'Bring music in from other apps, or take everything with you.');
  data.append(row('Import', 'Spotify Liked Songs and playlists, links from Spotify, Deezer, YouTube, SoundCloud and Bandcamp, M3U / PLS / CSV files (Exportify, TuneMyMusic, Soundiiz…) and Last.fm loved tracks.',
    btn('Import…', 'upload', () => openImportDialog())));
  data.append(row('Backup', 'Likes, playlists, history, stats and preferences in one JSON file. Passwords and tokens are never included.',
    group(btn('Save backup…', 'download', () => exportBackup()), btn('Restore…', 'upload', () => openRestore()))));
  data.append(row('Export a playlist', 'Open any playlist or album, then use ⋯ › Export as M3U8 (other players) or CSV (TuneMyMusic, Soundiiz and Hysh can import it).', null));
  root.append(data);

  // ---------- about ----------
  const ab = section('about', 'About Hysh');
  ab.append(el(`<div class="set-row" style="display:block;user-select:text"><b>Hysh ${esc(env.version)}</b> · made by <a href="#" data-dev>KiraiEEE</a> · free software under the GNU GPL v3 or later.<br>
    <span class="note">Designed after studying <b>Myspoti</b> (kota-zo), <b>BitChord</b> (kushagrasinghx), <b>Mochy Music</b> (realidkroo) and <b>Metrolist</b> (mostafaalagamy), all GPL-3.0. Thanks to the services and projects it talks to:
    Deezer API, Apple Marketing Tools RSS and iTunes Search, Radio Browser, Internet Archive, Jamendo, the Subsonic API, LRCLIB, LyricsPlus/YouLyPlus (binimum, ibratabian17), SimpMusic, KuGou, NetEase, Wikipedia, Last.fm, ListenBrainz, SponsorBlock and yt-dlp.</span><br>
    <span class="note">Data folder: ${esc(env.dataDir)}</span></div>`));
  ab.querySelector('[data-dev]').onclick = (e) => { e.preventDefault(); invoke('open_url', { url: 'https://kiraieee.github.io/' }); };
  root.append(ab);

  if (params.section) requestAnimationFrame(() => document.getElementById('set-' + params.section)?.scrollIntoView({ behavior: 'smooth' }));
}
