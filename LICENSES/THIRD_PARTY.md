# Third-party notices

BiliPocket invokes the following separately distributed executables at runtime.
They are bundled unmodified next to the application executable.

## yt-dlp 2026.10.26

- Project: https://github.com/yt-dlp/yt-dlp
- License: The Unlicense
- Local file: `yt-dlp-x86_64-pc-windows-msvc.exe`
- SHA-256: `3a1762538828dc20949d4e679d1c5994c39778af34c5cfa62247ecdc1e894bd7`
- Built from the official PyPI package `yt-dlp==2026.10.26` with PyInstaller.

## FFmpeg 7.1-essentials_build-www.gyan.dev

- Project: https://ffmpeg.org/
- Build: https://www.gyan.dev/ffmpeg/builds/ (essentials build, GPL enabled)
- License: GNU General Public License v3 (see `FFmpeg-GPL-3.0.txt`)
- Local file: `ffmpeg-x86_64-pc-windows-msvc.exe`
- SHA-256: `2ce797a0f88d7f067180338fb227f7b1928ea727bd9a4d7a1d022f7c52af71a3`
- Source code for this build is obtainable from https://ffmpeg.org/download.html and https://www.gyan.dev/ffmpeg/builds/. BiliPocket invokes FFmpeg as a separate process for muxing and audio conversion; the application source is separate from the FFmpeg binary.

**Distribution note:** this build is bundled in the distributed installers since v0.9.0. The corresponding source, the exact `configure` flags and the written offer required by GPL-3.0 §6b are recorded in [`FFMPEG_SOURCE_OFFER.md`](FFMPEG_SOURCE_OFFER.md). Patent licensing for codecs such as H.264/AAC is the distributor's responsibility and is not covered by that offer.

## Rust crates

BiliPocket uses crates from crates.io (Tauri, rusqlite, reqwest, tokio, keyring, qrcode, serde, uuid, md-5, sha2 and others). Their license metadata is available through `cargo metadata` and the respective crates. Generate a complete dependency license bundle before a public release.

> **[待确认 T9]** 公开发布前需导出完整的 Rust crates 依赖许可清单；当前段落仅为占位说明。本轮不安装 cargo-about 等新工具，见 README「待确认事项」表。

## Bilibili

BiliPocket is not affiliated with Bilibili. Use it only for content you own or are authorized to download, and comply with Bilibili's terms and local law. The app does not include DRM circumvention, paid-content bypass, or anti-bot evasion.
