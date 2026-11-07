# BiliPocket release checklist

This file lists optional external steps required before publishing a signed build to other users. The application code is implemented and the current build is intended for personal local use; code signing, updater infrastructure and hosted CI are not required for that use. The current version 0.9.0 installer and portable build are unsigned.

## 1. Sidecars and licenses

- `src-tauri/binaries/yt-dlp-x86_64-pc-windows-msvc.exe` — pinned yt-dlp, SHA-256 in `ENGINE_MANIFEST.json`.
- `src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe` — currently a GPL-enabled FFmpeg build. For public distribution either:
  - comply with GPL (include complete corresponding source and notices), or
  - replace with an LGPL-compatible build after legal review.
- Run `node scripts/verify-sidecars.mjs` before every build.
- Keep `LICENSES/GPL-3.0.txt`, `LICENSES/THIRD_PARTY.md` in the installer resources.
- Review H.264/AAC patent obligations for your distribution territory.

## 2. Code signing

Obtain a Windows Authenticode certificate (PFX, base64 encoded) and configure it for release builds:

1. Add `WINDOWS_CERTIFICATE` (base64 PFX) and `WINDOWS_CERTIFICATE_PASSWORD` to repository secrets. `.github/workflows/release.yml` imports the PFX and exports `WINDOWS_CERTIFICATE_THUMBPRINT`.
2. `npm run build:release` reads that thumbprint, configures `bundle.windows.signCommand`, builds with `--no-binary-patching`, then post-processes the artifacts: it signs `target/release/bilipocket.exe`, rebuilds the NSIS installer from Tauri's generated script so the signed executable is embedded, signs the rebuilt installer, and regenerates the updater `.sig` with `--app-version`. The signing script skips pinned `yt-dlp`/`ffmpeg` sidecars so `ENGINE_MANIFEST.json` hashes remain valid. This requires `makensis.exe`; the build script locates Tauri's NSIS cache or honors `MAKENSIS_PATH`.
3. Verify both the installer and the installed `BiliPocket.exe` with `Get-AuthenticodeSignature`; both should carry the production signature and the updater `.sig` must cover the final installer bytes. A self-signed test verified this post-build pipeline, but only a trusted Authenticode certificate removes SmartScreen warnings.
4. Unsigned builds are appropriate for personal local use; for public distribution they will trigger SmartScreen warnings, and reputation is not instantaneous even with a valid certificate.

## 3. Updater

The updater plugin, signed update check and install flow are implemented in the app. The current build ships with an empty `src-tauri/update-source.txt`, so the auto-update row is hidden in Settings and no remote request is made. Configure an endpoint only if you want the built-in updater.

1. Generate an updater key pair with `npx tauri signer generate -w <path outside the repository>`. Put the public key in `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. Keep the private key and password only in CI secrets (`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PATH`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). Keep the local development key pair outside the repository and never commit it.
2. Configure the release endpoint with `npm run set:update-source -- https://your-host/latest.json`. The file is bundled as a resource; `BILIPOCKET_UPDATE_ENDPOINT` can override it in debug builds.
3. Build signed updater artifacts with `npm run build:release` after exporting `TAURI_SIGNING_PRIVATE_KEY` (the key contents) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. This writes the installer plus its `.sig`. For a one-off build without the signing env, `npx tauri build` and `npx tauri signer sign <installer>` also works. Run the portable packaging separately.
4. `build:release` always regenerates the updater `.sig` with `--app-version`; generate the update manifest: `npm run make:latest -- --url https://your-host/BiliPocket_x.y.z_x64-setup.exe --signature <installer>.sig --version x.y.z --notes "…"`. Publish `latest.json` and the installer over HTTPS.
5. Run `npm run verify:release` (the release workflow does this automatically) to check version consistency, sidecar hashes, installer/portable presence, portable zip contents/marker, updater-signature version binding, the absence of local account/machine/project paths and — when a certificate thumbprint is present — Authenticode signatures. On Windows, the generated NSIS uninstaller defaults the app-data cleanup checkbox to on; `nsis-hooks.nsh` also forces removal of `%APPDATA%\com.bilipocket.desktop`, `%LOCALAPPDATA%\com.bilipocket.desktop`, the BiliPocket Windows credential and the autostart Run value. Then in Settings → 自动更新, check for the update. Installation downloads over HTTPS, verifies the embedded public key signature, installs NSIS in passive mode and restarts the app.
6. Test from the previous installed version before publishing; keep the previous installer for rollback. Never point the endpoint at an unsigned or mismatched artifact. The in-app updater targets the NSIS installation; portable builds should be replaced manually.

The base `npm run build` keeps updater artifacts disabled so development builds do not require secrets; `npm run build:release` merges `tauri.release.conf.json` and enables them for release builds. Both wrappers remap the local Windows account, build directories and project path at compile time (Rust and MSVC C/C++), and the packaging/verification scripts refuse artifacts that still contain them; `npm run verify:privacy` runs that scan directly. For public distribution, Authenticode signing must be configured in the Tauri Windows bundle step (or applied before regenerating the update `.sig`) so the update signature always covers the final installer bytes.

## 4. CI

`.github/workflows/verify.yml` runs JavaScript syntax checks, the full frontend type check, Playwright UI regression tests, six WebView2 desktop E2E scenarios (fake engine, extras-only/shared folder, priority, update check, automatic retry, crash recovery) with isolated `BILIPOCKET_DATA_DIR`, `cargo fmt`, Rust tests, Clippy, sidecar hash verification, a release build and portable packaging. `.github/workflows/release.yml` runs on `v*` tags only, configures the update endpoint from the repository URL, builds signed updater artifacts with `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, generates `latest.json` and publishes the GitHub release. The sidecars must be available to the checkout (repository, Git LFS or a provisioning step). Authenticode certificate secrets still need to be wired into the Tauri Windows signing step before a public release.

The two sidecar binaries are not tracked in Git. Before the first build, and before tagging a release, place them in `src-tauri/binaries/` and verify them with `npm run verify:sidecars`. On a clean checkout, `verify.yml` skips the E2E scenarios, sidecar verification, packaging and artifact upload that depend on them while all other checks still run; `release.yml` continues to require them so a release can never ship without its engines. `ENGINE_MANIFEST.json` records only source homepages and SHA-256 values, not a direct download URL, and no provisioning script exists in the repository. See the "待确认事项" table in `README.md` (T4) for the unresolved hosting decision and the other open items before a public release.

## 5. Portable build

Run `npm run package:portable` after `npm run build`. It verifies sidecar hashes and writes a folder plus zip under `src-tauri/target/release/bundle/portable/` containing the executable, both sidecars, engine manifest, README, release checklist and licenses. Portable builds contain a `BiliPocket.portable` marker; they keep every app directory (SQLite, covers, logs, cache and WebView2 data) in `app-data/` next to the executable, default downloads to `downloads/` next to the executable, encrypt the login session with Windows DPAPI in `app-data/session.dpapi`, and do not write the system credential store or autostart registry. Deleting the extracted folder therefore removes all app data; downloads explicitly saved elsewhere are never deleted automatically. Automatic installation is disabled and updates must be replaced manually. Do not run installed and portable builds at the same time.

## 6. Manual release smoke

The QR panel rendering/countdown/cancel can be checked without an account with `npm run test:desktop:auth` (requires network). Session expiry can be checked with `npm run test:desktop:session-expiry`; it refuses to run if a real stored session exists, installs a fake invalid session, verifies it is removed, and cleans up. These tests are intentionally not part of CI.

- Install on a clean Windows VM.
- Confirm engine versions and the absence of console/runtime errors.
- Check Authenticode signatures on the installer and the installed application executable (not only the installer).
- Replace a sidecar with a different file and confirm the release build disables the engine with a clear integrity message; restore the pinned binary.
- Verify that a v0.7 prototype profile migrates theme/download directory/concurrency/template once, does not import demo queue/history, and archives the old storage key.
- Parse a video and confirm the cover is loaded through the local asset protocol; inspect the network log that no remote image host is used by the WebView.
- Scan the QR code with an authorized test account; verify account name/VIP state and logout.
- Invalidate the stored session (change password or test an expired account), restart, and confirm the app clears it and prompts for login without crashing.
- Parse and download a short video you own or are authorized to save; verify the video, size, subtitles and filtered danmaku sidecars in the per-video folder, and test “仅下载弹幕/字幕” separately.
- Pause/resume/cancel/retry, close during download, reopen and continue. Confirm no yt-dlp/ffmpeg child process remains after pause, cancel or exit (Windows Job Object).
- Export diagnostics; confirm the file contains version/engine/status/log tail and no cookies, full URLs, account IDs or user names.
- Verify the installer resources contain the license notices.
- Verify notification, tray, open folder/reveal file, and uninstall.
- Confirm no cookies appear in logs, diagnostics or crash output.

## 7. Legal and product copy

- Confirm Bilibili terms and copyright position for the intended use.
- Keep the authorized-content notice in the first-run flow, About page and README.
- Keep the app unaffiliated with Bilibili; do not use official logos beyond fair, non-endorsing references.
