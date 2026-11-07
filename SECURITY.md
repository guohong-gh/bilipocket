# Security policy

BiliPocket is a local-first Windows downloader for content you own or are authorized to save. It does not include DRM circumvention, paid-content bypass, bulk scraping, proxy pools or anti-bot evasion. Do not use it against accounts or content you are not authorized to access.

## Reporting

Open a private security advisory or contact the maintainer directly. Do not include cookies, account IDs, full request URLs, or download paths in a public issue. Redact logs before sharing them; the in-app diagnostics export already removes these fields.

> **[待确认 T3]** 公开前需补充安全联系邮箱，或启用 GitHub 私有安全公告（private vulnerability reporting）。当前仅写「contact the maintainer directly」，没有可执行的联系方式；见 README「待确认事项」表。

## Credential handling

- Bilibili sessions are stored in Windows Credential Manager through the `keyring` crate; the portable build uses a DPAPI-encrypted `session.dpapi` inside `app-data/`. Startup refresh validates them against `nav` and clears expired credentials.
- Cookies never enter SQLite, the WebView, front-end logs or diagnostics.
- yt-dlp receives the session as a `Cookie` request header via `--add-header`; no cookie file is written to disk. The header is visible to same-user processes that can read process command lines, so the app never logs process arguments and diagnostics omit them.
- Legacy builds wrote `tmp/bilipocket-cookies-*.txt`; those files are removed on startup.
- Logging redacts query strings and known cookie keys. The diagnostics exporter additionally redacts Windows user names and omits account identity and download paths.

## Network boundary

- The WebView does not fetch remote images or metadata directly; CSP limits images to local assets, data URLs and the Tauri asset protocol.
- Rust fetches Bilibili metadata, QR login state, cover images (allow-listed `hdslb.com`/`biliimg.com`) and danmaku XML.
- Cover downloads enforce HTTPS, Bilibili domains, image content types and an 8 MB cap; the cache retains at most 300 files and removes entries older than 90 days.
- Sidecars run with argument arrays (no shell) inside a Windows Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so pause, cancel, app exit and engine failures terminate yt-dlp/ffmpeg process trees. Release builds verify yt-dlp and ffmpeg against the SHA-256 values embedded from `ENGINE_MANIFEST.json` at startup; mismatched binaries are disabled. Debug builds allow scratch engines for development only.

## Updates

Update checks are disabled unless a release endpoint is provided through `update-source.txt` or the debug-only `BILIPOCKET_UPDATE_ENDPOINT` environment variable. Release builds require HTTPS endpoints. Downloaded installers are verified against the updater public key embedded in `tauri.conf.json` before NSIS installation; the private key is never committed. Installation restarts the app, so it always requires explicit user confirmation.

## Local data

- `%APPDATA%\com.bilipocket.desktop\bilipocket.db` stores settings, tasks, history and cached cover paths.
- Diagnostic files are written locally under `diagnostics/` and are never uploaded.
- Removing the data directory resets the app; downloaded videos live in the directory chosen in settings and are not deleted by app removal.

## Out of scope

Code signing, updater provenance and Bilibili's own account security are release-infrastructure concerns; see `RELEASE.md`. Unsigned builds are for internal testing only.
