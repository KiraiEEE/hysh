# Hysh

A quiet, lightweight music player for Windows. One app for your own files, your music server,
internet radio, free catalogs and the web, with synced lyrics, downloads, scrobbling and themes.

Made by **KiraiEEE** · https://kiraieee.github.io/

## What it does

- **Play from everywhere:** local folders (MP3, FLAC, M4A/AAC, OGG, Opus, WAV), Subsonic / Navidrome /
  Airsonic / Gonic servers, internet radio (Radio Browser), the Internet Archive, Jamendo, and, with
  the user's own [yt-dlp](https://github.com/yt-dlp/yt-dlp), YouTube, SoundCloud, Bandcamp and pasted links.
- **Discover:** Deezer and Apple Music charts, new releases, genres, artist pages with Wikipedia / Last.fm bios,
  endless "radio" based on what is playing.
- **Catalog songs play in full:** a Deezer, Apple or Spotify track is matched to a playable copy:
  your files → your server → YouTube → the 30-second preview.
- **Lyrics:** word-by-word karaoke (LyricsPlus) with LRCLIB, SimpMusic, KuGou and NetEase as fallbacks.
- **Downloads:** queue, tags + cover art written into the file, auto-download liked songs, offline playback.
  Lossless (FLAC / original files) where the source offers it: Internet Archive, Jamendo, your Subsonic server.
- **Import / export:** Spotify Liked Songs and playlists (official login), links, M3U / M3U8 / PLS,
  CSV (Exportify, TuneMyMusic, Soundiiz), Last.fm loved tracks; export to M3U8 / CSV; full JSON backup.
- **Playback:** gapless, crossfade, 10-band EQ, speed, sleep timer, SponsorBlock skipping, Windows media keys.
- **Social:** Discord "Listening to" status, Last.fm and ListenBrainz scrobbling.
- **Look:** 8 skins (each with its own palette, corners and type), album-art accent, Windows 11 Mica / Acrylic,
  immersive Now Playing, mini player.
- **Plugins:** community audio effects, sources and themes. See [PLUGINS.md](PLUGINS.md).

## How it works

| Layer | Technology | Job |
|---|---|---|
| Shell | [Tauri 2](https://tauri.app) (Rust) + WebView2 | Native window; the UI is HTML/CSS/JS rendered by the WebView2 engine that ships with Windows 11, so no browser is bundled. |
| Backend | Rust, Tokio, Axum, reqwest | Library scanning and tag reading (lofty), a loopback media server, lyrics aggregation, scrobbling, Discord IPC, Spotify login, downloads and tag writing. |
| Media server | `127.0.0.1:<random port>`, per-launch secret token | Streams local files with seeking, proxies remote audio so Web Audio can process it, serves the yt-dlp cache and plugin files. |
| Audio | Web Audio API | Two decks for crossfade / gapless → EQ → plugin effects → volume → analyser. |
| UI | Plain ES modules, no framework, no bundler | `ui/js/*`: one module per job (player, sources, lyrics, downloads, import/export, plugins, views). |

**Where the music comes from.** Hysh does not host or scrape music itself. It talks to public APIs
(Deezer, iTunes, Apple Marketing RSS, Radio Browser, Internet Archive, Jamendo, LRCLIB...), to servers you
own (Subsonic), and to files you have. YouTube, SoundCloud and Bandcamp are optional and handled by yt-dlp,
a separate open-source program that the user installs from Settings. Using those sites this way can
break their terms of service; that choice is the user's. Hysh does not include ad-blocking for any service
and does not use unlicensed "lossless" mirrors.

**Lightness.** About 7.5 MB executable. Idle CPU is effectively zero: when nothing animates, nothing runs.
WebView2 uses CPU rasterisation with GPU compositing (about 60 MB less than default), drops its caches
when minimized, and an "Ultra-light" mode turns the GPU off. Measured on the developer's PC:
about 210 MB with the window open, 170 MB minimized, 0.1 % of one core idle.

## Build

Requirements: Windows 10/11, [Rust](https://rustup.rs) (MSVC toolchain), Visual Studio Build Tools
with "Desktop development with C++". Node.js only for the installer.

```bat
build.cmd            :: debug build      -> src-tauri\target\debug\hysh.exe
build.cmd release    :: optimized build  -> src-tauri\target\release\hysh.exe
build.cmd installer  :: optimized build + NSIS installer
build.cmd test       :: Rust unit tests
```

## Credits

Hysh was designed after studying four GPL-3.0 projects and follows their license:
[Myspoti](https://github.com/kota-zo/myspoti) (kota-zo), [BitChord](https://github.com/kushagrasinghx/BitChord)
(kushagrasinghx), [Mochy Music](https://github.com/realidkroo/Mochy-Music) (realidkroo) and
[Metrolist](https://github.com/mostafaalagamy/Metrolist) (mostafaalagamy).
Thanks to every service and project listed above, including LyricsPlus / YouLyPlus (binimum, ibratabian17),
SimpMusic, KuGou, NetEase, Wikipedia, Last.fm, ListenBrainz and SponsorBlock.

## License

GNU General Public License v3.0 or later. See [LICENSE](LICENSE).
