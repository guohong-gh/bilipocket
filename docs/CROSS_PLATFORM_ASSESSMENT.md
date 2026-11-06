# 跨平台可行性评估（T17 · 只调研，不立项）

> 结论先行：**不做**。当前只交付 Windows。下面是盘点结果与代价区间，供以后真要评估时直接复用，不必重做功课。
> 盘点日期：2026-11-03 · 对应 Issue 需求 `R24（跨平台部分）`

---

## 1. 什么是"能编译"之外的差异

跨平台不是换个打包目标就行。Tauri 自身已经把窗口、菜单、托盘、WebView 抽象掉了，真正卡住的是这四类**平台 API 直连**：

| # | 依赖点 | 位置 | 作用 | 现状 |
| --- | --- | --- | --- | --- |
| 1 | Win32 Job Object | `src-tauri/src/process_job.rs` | 暂停/取消/退出时把 yt-dlp 与 ffmpeg 的**整个进程树**杀掉，避免子进程残留 | 有 `#[cfg(not(windows))]` 空实现，非 Windows 上**直接不杀子进程** |
| 2 | DPAPI 便携会话 | `src-tauri/src/auth.rs:515-544`（`load_portable_session` / `save_portable_session`） | 便携版把登录 Cookie 用 `CryptProtectData` 加密存 `app-data/session.dpapi` | **没有非 Windows 分支**，`dpapi_protect` / `dpapi_unprotect` 是 `#[cfg(windows)]`，所以当前**在 macOS / Linux 上根本编译不过** |
| 3 | 系统凭据库 | `auth.rs:482-511`（`keyring` crate） | 安装版把会话存 Windows 凭据管理器 | `keyring` 本身跨平台，但需要 macOS Keychain / Linux `libsecret` 的运行期依赖；Linux 无桌面密钥环时行为未验证 |
| 4 | sidecar 与打包 | `src-tauri/tauri.conf.json:46-49`、`scripts/sign-windows.ps1`、`scripts/package-portable.mjs` | 随包分发 yt-dlp / ffmpeg，产出 NSIS 安装包与便携目录 | 二进制名**硬编码** `x86_64-pc-windows-msvc`；`ENGINE_MANIFEST.json` 里的 SHA-256 也是按 Windows 版本算的 |

补充的隐性成本：

- **路径与文件名规则**：`files.rs` 的清洗逻辑是围绕 Windows 写的（`CON`/`PRN` 等保留名、结尾点和空格、`MAX_PATH 250` 截断）。macOS/Linux 上这些规则不违规，但仍会生效——**不会坏，只是多余**。反过来，Linux 上合法的 `:` 被吃掉是行为差异。
- **数据目录**：安装版写 `%APPDATA%` / `%LOCALAPPDATA%`（`README.md:229`）。Tauri 的 `app_data_dir` 能自动映射到 `~/Library/Application Support` 与 `~/.local/share`，这一项成本很低。
- **WebView 引擎**：Tauri 自动切换（Windows 用 WebView2、macOS 用 WKWebView、Linux 用 WebKitGTK）。但本项目 UI 依赖 `backdrop-filter`、`asset://` 协议与自定义 `--vars` 主题，**WKWebView 与 WebKitGTK 上必须逐屏重测**，这是最容易低估的一块。
- **签名与分发**：Windows 是 Authenticode；macOS 需要 Developer ID + 公证（notarization），否则 Gatekeeper 直接拦截；Linux 通常只能发 AppImage / deb。三家都不是"配置一下就行"。

---

## 2. 四类替代方案与工作量

| # | 替代方案 | 具体做法 | 工作量 |
| --- | --- | --- | --- |
| 1 | `nix` 进程组 | `setsid()` 让子进程独立成组，暂停/取消时 `killpg(-pgid, SIGKILL)`。语义与 Job Object 接近，但**没有** `KILL_ON_JOB_CLOSE` 的"父进程一死就全灭"保证，需要在应用退出钩子里补显式 kill | 2–3 人日（含 macOS 的 `killpg` 与 Linux `prctl(PR_SET_PDEATHSIG)` 差异验证） |
| 2 | 文件权限替代 DPAPI | 便携会话改用 `0600` 权限 + 应用内 AES-GCM（密钥从机器标识派生）或者干脆**不支持便携版**、只发安装版走 `keyring` | 2 人日（若砍掉便携版则 ≤0.5 人日） |
| 3 | `keyring` 跨平台 | macOS 走 Keychain 开箱可用；Linux 需要 `libsecret-1` 与 `gnome-keyring`/`kwallet`，无密钥环时要降级到方案 2 | 1–2 人日（主要是 Linux 无密钥环场景） |
| 4 | 多平台 sidecar | `tauri.conf.json` 的 `externalBin` 改成不带 triple 的基名，构建时按 `target triple` 从 `binaries/` 取对应文件；`ENGINE_MANIFEST.json` 按平台各存一份校验值；补 macOS `.dmg` + 公证、Linux `AppImage` | 3–5 人日（不含签名证书申请） |

**合计：8–12 人日**（不含 macOS 开发者账号申请、公证等待与三平台 UI 回归）。这个数还没算上"每个平台各跑一遍 Playwright UI 回归与桌面 E2E"的验证成本。

---

## 3. 收益判断

立项门槛是"至少 3 个真实用户诉求"。对照本次清洗的 147 条 Issue：

- 与"换个平台/换个形态"沾边的**只有 2 条**：`Bili23-Downloader#487`（Docker 部署）与 `bilibili-video-downloader#115`（手机版）。两条都不是"我想要 macOS 桌面版"，而是别的分发形态，且都在清洗阶段被判为**定位不符**，已列入排除清单（[`ISSUE_GAP_ANALYSIS.md`](./ISSUE_GAP_ANALYSIS.md) §1.3「定位不符且无迁移价值」一行）。
- 其余 145 条全部与平台无关。

按预设门槛 **不满足**，所以：**不立项**。

如果以后重启这个议题，最先摘的两颗低垂果实（都不需要动进程管理）：

1. 修掉 `auth.rs` 里 DPAPI 的无条件调用（加 `cfg` 分支），让"至少能编译 + 能下载"成立——约 0.5 人日。
2. `externalBin` 改成按 triple 取二进制——约 1 人日。

进程组与 WebView 回归放最后，因为它们是"能跑"与"跑得对"的分界线。

---

## 4. 本文档不承诺什么

- 不含任何实现代码改动（T17 验收明确写的是"只做盘点"）。
- 不含 macOS / Linux 上的实测数据——本机没有对应环境，上面的工作量是从代码耦合面推算的区间，不是实测值。
- 平台列表只覆盖 macOS 与 Linux 桌面。Windows ARM64 / 移动端不在评估范围。
