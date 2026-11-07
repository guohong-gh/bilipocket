# BiliPocket 完整实现计划（v1.0.0）

> **[历史归档 / 内部工作稿]** 本文档为早期规划记录，反映撰写时状态，不代表当前仓库现状；文中的模块路径、配置名与版本号仅供追溯。当前状态以 `README.md`、`RELEASE.md` 与 `src-tauri/tauri.conf.json` 为准。

> 把当前 v0.7.0 高保真原型升级为可真实解析、下载、登录、持久化、自动更新的 Windows 桌面应用。
>
> 已确认的方向：**yt-dlp + ffmpeg sidecar**、**扫码登录 + 加密会话**、**Windows 优先**、**前端保持原生 ESM / 零构建**。

---

## 1. 目标与边界

### 1.1 目标

- 输入单条 Bilibili 视频链接（BV / av / b23.tv）后真实解析标题、UP 主、封面、时长、清晰度、字幕与弹幕。
- 按视频实际支持 + 当前账号真实权限展示清晰度；不可下载档位显示真实原因。
- 真实下载 DASH 视频/音频、封装 MP4/MKV、生成音频、字幕与过滤后的弹幕文件。
- 队列支持并发、暂停、继续、取消、重试、限速、断点续传和崩溃恢复；关闭应用后任务不丢。
- 扫码登录；凭据加密保存；账号过期时给出可恢复的错误，不静默降级文件质量。
- 设置、历史、任务持久化到 SQLite；历史可打开文件、定位目录、再次下载。
- Windows 安装包、便携版、代码签名、自动更新、日志与第三方许可证。
- 保留现有“放映日志”视觉与交互，不重做前端设计。

### 1.2 非目标（v1.0）

- 不实现 DRM 破解、付费墙绕过、会员内容规避、批量抓取、风控规避、代理池或账号共享。
- 不做视频播放器、直播录制、互动视频、付费课程、合集/收藏夹批量下载。
- 不做 macOS/Linux 正式发布；侧车与路径层预留跨平台接口，但只测试 Windows x64。
- 不引入 React/Vue；保持原生 ESM。

### 1.3 合规前提

- 仅用于下载用户拥有版权或已获授权的内容；首次启动必须确认。
- 登录只使用用户自己的账号，只访问其账号本来就能访问的内容；不实现会员/付费权限绕过。
- 遇到验证码、风控、限流时显示错误并停止，不做自动绕过；请求限速、退避，不做批量抓取。
- 发布前需人工确认 B 站服务条款、著作权与 ffmpeg/yt-dlp 许可证义务；这是发布门禁，不是代码问题。

---

## 2. 技术决策

| 决策 | 选择 | 原因 |
| --- | --- | --- |
| 下载引擎 | yt-dlp + ffmpeg 作为 sidecar | 维护活跃、Unlicense、Bilibili 4K/HDR/杜比、Cookie、字幕和弹幕 XML 支持成熟 |
| B 站元数据 | Rust `reqwest` + WBI 签名模块 | UI 需要完整支持档位、锁定原因、字幕语言和账号权限；不把 Cookie 暴露给 JS |
| 队列/数据库 | Rust 权威状态 + SQLite（rusqlite，WAL） | 真实后台任务、崩溃恢复、可迁移、可索引；替代 localStorage 全量写 |
| 账号 | 扫码登录，Windows Credential Manager/DPAPI 加密会话 | 无密码收集；比手动 Cookie 导入更完整；会话不进入 JS/DB/日志 |
| 侧车调用 | Rust 直接 spawn，禁止 shell 拼接 | 参数数组、路径校验、进程树回收、最小权限 |
| 前端 | 原生 ESM + `bridge.js`（JSDoc 类型），零构建 | 保留当前 UI 与构建形态；类型检查用 `tsc --noEmit` + `// @ts-check` |
| 发布 | Windows x64 NSIS + 便携版 + 签名 + Tauri updater | Windows 优先；先完成单一平台的安装/升级闭环 |

**依赖与许可证**

- yt-dlp：The Unlicense。
- ffmpeg：需选择 LGPL 构建或按 GPL 条款分发；随包分发时附版权声明、许可证文本与源码获取方式；H.264/AAC 等专利许可需自行评估。
- 新增 Rust 依赖需在 `LICENSES/THIRD_PARTY.md` 中登记。
- 不使用 BBDown（仓库已归档）；lux/bilix 作为备选参考，不进入默认依赖。

---

## 3. 目标架构

```text
┌──────────────────────────────────────────────┐
│ WebView2 (原生 HTML/CSS/ESM)                  │
│ app.js · store projection · bridge.js         │
│ 只通过 invoke/events 与 Rust 通信，不直接联网  │
└──────────────────────┬───────────────────────┘
                       │ Tauri IPC（JSDoc 类型 + 运行时校验）
┌──────────────────────▼───────────────────────┐
│ Rust core (src-tauri/src)                     │
│ commands · queue · SQLite · files · auth      │
│ bilibili_meta (reqwest/WBI) · events · logs   │
└───────────────┬──────────────────────┬────────┘
                │ sidecar spawn         │ HTTPS（仅元数据/登录/封面/弹幕）
┌───────────────▼──────────────┐  ┌────▼────────────────────┐
│ yt-dlp.exe / ffmpeg.exe      │  │ Bilibili web APIs       │
│ 真实媒体下载与封装            │  │ 用户自己的账号会话       │
└──────────────────────────────┘  └─────────────────────────┘
```

### 3.1 责任划分

| 能力 | 实现方 |
| --- | --- |
| 链接解析、b23 重定向、视频/分P/番剧元数据 | Rust `bilibili_meta` |
| 完整清晰度矩阵、账号权限、锁定原因、字幕轨道 | Rust `bilibili_meta`（参考 yt-dlp 提取器的 WBI/接口实现） |
| 媒体流获取与下载、DASH 音视频、断点续传、合并 | yt-dlp sidecar |
| 封面缓存、弹幕 XML 过滤、文件落盘、原子改名 | Rust |
| SRT 字幕下载/命名（必要时由 yt-dlp 生成） | yt-dlp + Rust 校验 |
| 队列、并发、暂停/取消/重试、磁盘检查 | Rust |
| UI、表单、抽屉、提示、错误操作 | 原生 ESM |
| 自动更新、安装包、签名 | Tauri updater + CI |

### 3.2 Rust 模块建议

```text
src-tauri/src/
  lib.rs                 # builder/plugins/tray/window lifecycle
  commands/              # invoke handlers
  domain/                # Task, Video, Quality, Auth, Settings
  db/                    # rusqlite, migrations, repositories
  queue/                 # state machine, scheduler, recovery
  engine/
    mod.rs               # Engine trait + adapter selection
    sidecar.rs           # spawn, kill tree, temp dirs, logs, progress
    ytdlp.rs             # probe/download/format mapping
    ffmpeg.rs            # mux/audio conversion
  bilibili/              # WBI, nav, view/player APIs, cover, danmaku
  auth/                  # QR login, keyring, session lifecycle
  files/                 # path confinement, sanitizer, atomic finalize
  events.rs              # task://, auth://, engine://
  logging.rs
```

---

## 4. 数据与状态

### 4.1 SQLite 表

数据库：`%APPDATA%\com.bilipocket.desktop\bilipocket.db`（便携版为 `app-data/bilipocket.db`），WAL 模式，`PRAGMA user_version` 记录 schema 版本；只由 Rust 访问。

| 表 | 关键字段 |
| --- | --- |
| `settings` | key, value（JSON）；主题、目录、并发、限速、命名模板、默认清晰度、通知、托盘、默认弹幕/字幕、授权确认 |
| `tasks` | id, kind(video/extras), source_url, bvid, title, uploader, cover_url, cover_path, duration_seconds, format_id, quality_label, container, size_bytes, downloaded_bytes, speed_bytes_per_sec, eta_seconds, status, error_code, error_message, extras_error, output_path, temp_dir, danmaku_types_json, subtitle_langs_json, danmaku_count, engine_version, attempt, retry_at, created_at, queued_at, started_at, completed_at |
| `history` | id, kind, task_id, 快照字段, output_path, size_bytes, danmaku/subtitle 字段, extras_error, completed_at；`missing_file` 由文件检查实时计算 |

- 任务保存具体 `format_id` 与容器；**不保存会过期的流 URL**。恢复/重试时重新 probe，重新校验权限。
- 历史保存快照，覆盖文件被移动/删除时仍可显示；`missing_file` 由文件检查得出；最多保留 100 条。
- Token/Cookie 只存 Windows Credential Manager（便携版为 DPAPI 文件）；**不写临时 cookie 文件**，yt-dlp 通过 `--add-header "Cookie: ..."` 接收会话。

### 4.2 任务状态机

```text
queued → probing → downloading → muxing → extras → completed
           │            │            │
           ├─ paused ←──┘            ├─ failed → retry → queued
           └─ cancelled               └─ cancelled
```

- `probing`：重新确认 URL、权限、format；权限变化时失败原因可能是 `auth_required` / `vip_required`。
- `paused`：停止 sidecar，保留 `.part` 与临时目录；继续从 Range/`--continue` 恢复。
- `failed`：区分可重试（网络、5xx、超时）和不可重试（登录、权限、404、磁盘满、文件名非法）；不可重试不自动重试。
- `cancelled`：请求取消；按设置删除或不删除临时文件。
- 应用启动时：`downloading/muxing/extras` → `paused`（不可确定状态），由用户继续或自动恢复策略决定；不把未完成状态伪装成成功。
- 已入队任务冻结当时的清晰度选择；权限过期时暂停并提示重新选择，不静默降级文件质量。

### 4.3 IPC 契约

命令：

- `auth_status` / `auth_qr_start` / `auth_qr_poll` / `auth_logout`
- `probe_video(url)` → 视频元数据、支持档位（含锁定原因）、字幕轨道、弹幕统计
- `enqueue_task(spec)` / `pause_task` / `resume_task` / `cancel_task` / `retry_task` / `remove_task`
- `list_tasks` / `list_history` / `delete_history` / `re_add_history`
- `get_settings` / `update_settings`
- `engine_info` / `engine_check`
- `open_output` / `reveal_output` / `export_diagnostics`

事件（Rust → JS，节流 500ms）：

- `task://progress`：`{ id, phase, downloadedBytes, totalBytes, speed, eta, percent }`
- `task://state`：完整状态变更
- `task://completed` / `task://failed`
- `auth://changed`
- `engine://state`

错误码：`auth_required`、`vip_required`、`not_found`、`geo_blocked`、`risk_control`、`rate_limited`、`network`、`timeout`、`disk_full`、`permission_denied`、`filename_invalid`、`engine_outdated`、`sidecar_failed`、`cancelled`。前端按错误码给操作，而不是只显示字符串。

---

## 5. 真实解析与权限

### 5.1 probe 流程

1. Rust 规范化链接：BV/av/b23 重定向、去除追踪参数、拒绝直播/合集等不支持类型。
2. 使用账号会话请求 `view` / `player/v2` / `playurl`（WBI 签名，参考 yt-dlp 的 Unlicense 实现）。
3. 获取 `support_formats`、`accept_quality`、DASH 支持情况、字幕列表、弹幕 CID；用 yt-dlp `-J` 交叉校验可下载 format。
4. 合并为单一 `VideoProbe`：每个清晰度包含 quality_id、label、codec、fps、dynamic_range、container、预计大小、access（available/locked）、reason。
5. 若某个档位无法确认权限：显示“当前账号不可用”，不猜测可绕过；不展示不存在的视频档位。

### 5.2 清晰度与账号

- 真实账号状态：guest / logged_in / vip（来自 nav，不使用演示开关）。
- 720P 及以下、1080P、1080P+ / 1080P60 / 4K / 8K / HDR / Dolby 的可用性以接口返回为准；缺少所需权限时标注真实原因。
- 默认清晰度：`自动`（推荐可用的 1080P，否则最高可用非音频档）+ 具体档位；继续沿用“最近可用档”回退。
- 支持同一清晰度多 codec（AVC/HEVC/AV1）：优先兼容性，允许在抽屉/设置中查看 codec；不把 codec 伪装成另一种清晰度。
- 容器：常规 MP4；HDR/Dolby/HEVC 不兼容时使用 MKV，并在 UI 显示真实容器，不强行改扩展名。

### 5.3 字幕与弹幕

- 字幕轨道由 `player/v2` 真实返回；未登录时提示“登录后可下载”。
- 字幕默认 SRT；语言 ID 映射到文件名，例如 `title [1080P].zh-Hans.srt`。
- 弹幕下载 XML；按用户选择的类型（滚动/顶部/底部/逆向/高级）过滤 `<d p="...">` 的 type 字段；生成 `title [1080P].danmaku.xml`。
- 弹幕统计从 XML 或接口计算，失败时显示“未知”而不是伪造数字。
- ASS 渲染、弹幕速度/密度设置在 1.x 迭代，不阻塞 v1.0。

---

## 6. 下载引擎与文件系统

### 6.1 Sidecar 打包

- `src-tauri/binaries/yt-dlp-x86_64-pc-windows-msvc.exe`、`ffmpeg-x86_64-pc-windows-msvc.exe`（Tauri 目标三元组命名）。
- `tauri.conf.json` 的 `bundle.resources` 注册；`tauri-plugin-shell` 只在 Rust 侧使用，JS 不获得 shell 权限。
- 每个版本固定 sidecar 版本与 SHA-256；`ENGINE_MANIFEST.json` 记录版本、哈希、来源。
- 应用启动时校验哈希；缺失/损坏时显示“下载引擎不可用”，不自动从任意 URL 下载。
- 升级策略：引擎随应用版本发布；另提供“检查引擎更新”的签名清单；不在运行时静默拉取未验证二进制。

### 6.2 下载流程

1. `probing`：重新校验会话、format_id 与输出目录；确认磁盘空间留有余量。
2. `downloading`：Rust spawn yt-dlp，参数全部为数组，包含：`--no-config`、`--no-playlist`、`--newline`、`--progress-template`（JSON）、`--cookies <临时文件>`、选定 format、输出模板、`--continue`、限速。
3. 进度：解析 stdout JSON；节流写入 DB 并发 `task://progress`；stderr 保留脱敏日志。
4. `muxing`：由 yt-dlp + ffmpeg 合并；或分离流下载后由 ffmpeg 合并。失败保留临时文件，可重试。
5. `extras`：写字幕、过滤弹幕、缓存封面；全部成功后再原子改名到最终路径。
6. `completed`：写历史、通知、更新 UI；失败/取消清理临时文件（按设置）。

### 6.3 暂停、取消与恢复

- 暂停/取消通过终止进程树（Windows Job Object）实现；不依赖 HTTP 连接保持。
- 恢复使用 yt-dlp `--continue` / Range；重新 probe 获取新 URL，避免过期流。
- 重试指数退避，最多 3 次；权限/404/磁盘满/非法文件名不自动重试。
- 进程退出、应用崩溃后，启动时保留 `.part`，将状态转为 `paused`，用户可继续。
- 并发由 Rust 调度；下载任务与“并发数”设置强一致；不同时启动超过上限的进程。

### 6.4 文件安全

- 目录 canonicalize；输出路径必须在用户选择的下载目录内；拒绝 `..`、绝对路径注入、符号链接逃逸。
- 文件名在 Rust 侧再次清洗：Windows 保留名、控制字符、结尾点/空格、长度上限、中文/Unicode 正常保留。
- 冲突策略：`(2)` 后缀或按设置覆盖/跳过；不覆盖未确认的已有文件。
- 临时目录：`%APPDATA%\BiliPocket\parts\<task-id>`；最终文件原子 rename；跨盘时复制后校验大小。
- 磁盘空间检查、剩余空间低于阈值时阻止开始/暂停任务。
- 封面缓存到应用数据目录，通过 Tauri asset 协议或本地 URL 加载；不放开远程图片 CSP。

---

## 7. 账号、会话与安全

### 7.1 扫码登录

- 使用 Bilibili 登录二维码接口（生成 + 轮询）；显示二维码与过期倒计时，支持取消。
- 轮询结果状态：等待扫码 / 已扫码待确认 / 成功 / 过期 / 风控失败；失败只提示，不实现验证码或风控绕过。
- 成功后提取必要 Cookie，写入 Windows Credential Manager/DPAPI；不进入 localStorage、SQLite、日志或崩溃报告。
- 启动/探针前通过 nav 接口校验会话；过期时 `auth://changed`，UI 显示“登录已过期”，任务需要重新选择。
- 退出登录清除凭据与内存会话，并重新计算清晰度可用性。

### 7.2 Cookie 与进程边界

- Rust `reqwest` 使用内存 Cookie Store；yt-dlp 通过 `--add-header "Cookie: ..."` 接收会话，不生成 Netscape `cookies.txt`。命令行参数对同用户进程可见，因此不写日志、不导出诊断。
- 日志脱敏：URL 查询参数、Cookie、Authorization、二维码 key、UID 等；诊断导出过滤敏感字段。
- 不把 Cookie 传给 WebView；不新增 JS 网络权限；CSP 维持本地资源限制，图片缓存走受控协议。

### 7.3 权限更新

- 登录/退出/升级账号后，重新 probe 当前结果并更新清晰度矩阵。
- 已排队任务若权限失效：暂停并提示，不静默降级；用户可重新选择清晰度或重试。
- 账号信息只显示 UID/昵称/大会员状态；不读取与下载无关的资料。

---

## 8. 前端改造（保持原生 ESM）

### 8.1 架构

- 新增 `src/js/bridge.js`：封装 `invoke`/事件订阅，使用 JSDoc typedef 定义 IPC 负载，做运行时字段校验；浏览器预览用 mock bridge 保持可开发。
- `store.js` 从“唯一状态源”改为 Rust 状态的投影缓存；删除 800ms 模拟 ticker、随机速度、1500ms 假解析和种子任务。
- `dev/mock-store.js` 等演示 fixture 只保留在 `dev/`，生产构建不参与解析。
- `app.js` 保留现有渲染与路由；事件处理器调用 bridge，按真实错误码展示操作。
- 新增 `jsconfig.json` + `// @ts-check`，用 TypeScript 的 `tsc --noEmit` 做类型检查（不打包、不改运行时）。
- CSP 尽量收紧；如果加载本地缓存封面，只加入受控 asset 协议，不放开任意外部图片。

### 8.2 UI 状态

- 解析：真实 loading/empty/error（404、地区限制、需要登录、风控、网络）。
- 账号：标题栏或设置中的登录状态；二维码弹窗；登录过期提示；不再出现“演示账号状态”。
- 清晰度：真实档位、codec/容器/大小；锁定原因；账号变化后重新 probe。
- 队列：阶段（探测/下载/合并/附加内容）、真实速度/ETA、暂停/继续/取消/重试、进度恢复；错误可操作。
- 历史：打开文件、定位目录、文件丢失状态、再次下载；真实封面缓存。
- 设置：下载目录、并发、限速、默认清晰度、文件名模板、登录、通知、托盘、引擎版本、检查更新。
- 首次启动：授权确认 + 目录选择 + 引擎自检 + 可选登录；不再预置模拟队列/历史。

### 8.3 迁移与兼容

- 原型 localStorage 的队列/历史是虚构数据，**不导入真实数据库**；一次性归档旧 key，仅迁移主题、目录、并发、文件名模板等设置。
- 迁移弹窗说明“演示任务不会变成真实下载”。
- SQLite 自带版本迁移；升级失败保留备份，不静默清空。
- `theme-boot.js` 继续读取一个轻量主题镜像，Rust 是设置真源；避免启动闪烁。

---

## 9. 生产化与发布

- 日志：`tracing` + 滚动文件；默认不含 Cookie/URL 查询参数；崩溃日志和诊断包脱敏。
- 更新：Tauri updater + 签名清单 + GitHub Releases（或自有 HTTPS）；Windows 安装包/便携版；回滚保留上一版本。
- 代码签名：个人本地使用可不签名；对外公开分发时需购买 Authenticode 证书并注入 CI secrets，未签名包会触发 SmartScreen 提示。
- CI（Windows runner）：`cargo fmt/clippy/test`、前端类型检查、单元测试、Playwright、sidecar 哈希校验、`tauri build`、签名、更新清单。
- 安装包：NSIS + 便携 zip；包含第三方许可证、授权使用提示；开始菜单/卸载项。
- 文档：README 从“原型”更新为真实能力与限制；单独 `SECURITY.md`、`LICENSES/THIRD_PARTY.md`、升级/回滚说明。
- 诊断：设置中“导出诊断”只包含版本、引擎版本、错误码、脱敏日志，不上传。

---

## 10. 测试矩阵

| 层级 | 内容 | 工具 |
| --- | --- | --- |
| Rust 单元 | 队列状态机、权限映射、文件名/路径、磁盘检查、错误分类、迁移 | `cargo test` |
| 引擎适配 | 假 yt-dlp/ffmpeg 输出 JSON/进度/失败/取消；format 映射；临时 Cookie 生命周期 | Rust 集成测试 + fixture |
| Bilibili 元数据 | mock HTTP 服务：登录、VIP、地区、限流、字幕、弹幕 | `wiremock`/本地 mock |
| 前端 | bridge 校验、状态投影、错误操作、质量矩阵渲染 | Node test / Playwright + mock bridge |
| 桌面 E2E | 首次启动、登录、解析、入队、暂停/继续、取消、历史、更新提示 | WebView2 CDP / tauri-driver |
| 迁移 | v0.7 localStorage → SQLite 设置迁移；不导入假任务 | 自动化 + 手动 |
| 真实网络 smoke | 公开测试视频、二维码登录、4K/VIP、字幕、弹幕、断网、磁盘满 | 手动，凭据不入 CI |
| 安全 | 参数注入、路径逃逸、Cookie 泄漏、日志脱敏、sidecar 缺失/篡改 | Rust 测试 + 人工审查 |

---

## 11. 里程碑与验收

| 阶段 | 时间（1 名资深全栈） | 交付与验收 |
| --- | --- | --- |
| M0 技术验证 | 3–5 天 | yt-dlp + ffmpeg sidecar 可下载公开测试视频并合并；确认完整清晰度矩阵来源；验证二维码登录与 Cookie 临时文件；验证弹幕/字幕样本。输出决策记录；若质量矩阵不可靠，切换备选方案 |
| M1 核心骨架 | 1–1.5 周 | Rust 领域模型、SQLite、迁移、状态机、sidecar 管理器、IPC/events、假引擎；前端 bridge 接入，现有 UI 可显示真实空态 |
| M2 真实解析与下载 | 2 周 | 真实 probe、清晰度/权限、入队、进度、暂停/继续/取消/重试、文件原子落盘、字幕/弹幕、封面缓存；队列/历史可用 |
| M3 登录与权限 | 1–1.5 周 | 二维码登录、加密凭据、nav 校验、权限矩阵、登录过期、账号切换更新；锁定原因真实；无 Cookie 泄漏 |
| M4 生产硬化 | 1.5–2 周 | 磁盘/错误/恢复、限速、日志、自动更新、签名、CI、测试矩阵、首次启动、迁移、第三方许可证 |
| M5 发布 | 0.5–1 周 | 签名安装包/便携版、升级验证、公开 Beta、回滚、文档与合规核对 |
| 合计 | **约 8–11 周** | 不含证书/法律审查等待；可并行设计与前端工作 |

**M0 决策门禁：**

- yt-dlp 是否能稳定获取公开/登录/VIP 档位；不能则用 `bilibili_meta` + yt-dlp 混合，或切换 bilix sidecar。
- ffmpeg 许可证与安装包体积可接受；不能则要求用户安装 ffmpeg 或改用 LGPL 构建。
- 二维码登录接口在目标地区可用；不可用则降级为手动 Cookie 导入，不实现绕过。
- 任何无法确认的权限/格式都不得靠猜测放行。

---

## 12. 风险与备选

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Bilibili 接口/风控变化 | 解析或登录失败 | 固定引擎版本 + 签名引擎更新通道；错误码友好提示；不自动绕过 |
| yt-dlp 对某些档位/弹幕支持不足 | 功能缺口 | M0 验证；`bilibili_meta` 补全；必要时 bilix 备选适配器 |
| 二维码登录条款/风控 | 登录不可用 | 法律审查；降级 Cookie 导入；明确用户自行确认账号权限 |
| ffmpeg 许可证/体积 | 发布合规与安装包增大 | LGPL 构建/源码提供/第三方声明；M0 评估；必要时用户安装 |
| Cookie 泄漏 | 账号安全 | 系统凭据库、临时文件 ACL、日志脱敏、无 JS 访问、退出清理 |
| sidecar 注入/路径逃逸 | 任意命令/文件写入 | 参数数组、无 shell、sidecar 哈希、路径 canonicalize、权限最小化 |
| 断点续传/崩溃恢复错误 | 文件损坏/重复 | `.part` + Range + 原子 rename + 启动恢复测试 |
| 未签名 SmartScreen | 用户不敢安装 | Authenticode 证书、发布说明、Beta 签名 |
| 真实任务与原型假数据混淆 | 用户误解 | 迁移只导入设置；首次启动说明；删除演示种子 |

备选：若 yt-dlp 质量矩阵不可靠，改用 bilix（Apache-2.0）作为 Python sidecar；若必须零 sidecar，再评估 Rust 原生 WBI/DASH 实现（成本最高）。

---

## 13. Definition of Done

- [x] 单条 BV/av/b23 真实解析，元数据准确；b23 重定向可用。
- [ ] 按视频支持显示清晰度、codec、容器、大小；真实账号权限与锁定原因正确。
- [ ] 扫码登录、会话过期、退出登录、凭据加密与日志脱敏通过测试。
- [ ] 视频/音频下载、合并、音频转码、字幕、过滤弹幕、封面缓存可用。
- [x] 队列并发、暂停、继续、取消、重试、限速、磁盘检查、崩溃恢复通过。
- [x] SQLite 迁移、v0.7 设置迁移、历史/文件打开和再次下载通过。
- [x] 前端保持现有视觉，真实 loading/error/empty/登录状态完整；类型检查通过。
- [ ] 自动更新、代码签名、安装包/便携版、第三方许可证、CI 完成。
- [x] 首次启动授权确认；无 DRM/付费墙/风控绕过逻辑；合规文案更新。
- [ ] 真实网络 smoke、模拟故障、桌面 E2E 与回归清单通过。

---

## 14. 建议的第一批任务（M0 直接可执行）

1. 下载并固定 yt-dlp/ffmpeg x64 版本，记录 SHA-256；用公开测试视频验证 360P/1080P/4K 格式、字幕、弹幕 XML。
2. 用 Rust 写一个最小 `probe`，复现播放/清晰度接口与 WBI 签名；与 yt-dlp `-J` 输出对照，决定完整清晰度矩阵来源。
3. 用临时 Cookie 文件跑扫码登录原型，验证 nav VIP 状态与 4K 权限，不写入日志。
4. 在 Tauri 中注册 sidecar，spawn 一个 yt-dlp `--version`/下载任务，验证进程树终止、进度 JSON、临时目录清理。
5. 确认 ffmpeg 构建的许可证与安装包体积；决定随包或可选安装。
6. 起草 SQLite schema 与任务状态机；用假引擎跑通一次完整 Tauri IPC 流程。
7. 产出 M0 决策记录：引擎、质量矩阵、登录、许可证、安装包体积；再进入 M1。

---

## 参考

- yt-dlp：https://github.com/yt-dlp/yt-dlp （Unlicense；Bilibili 提取器含 WBI、DASH、字幕、弹幕 XML 处理）
- lux：https://github.com/iawia002/lux （MIT）
- bilix：https://github.com/HFrost0/bilix （Apache-2.0）
- BBDown：https://github.com/nilaoda/BBDown （MIT；已归档，仅作参考）
- Tauri sidecar：https://v2.tauri.app/zh-cn/develop/sidecar/
- Tauri updater：https://v2.tauri.app/plugin/updater/

---

## 15. 完成审计（2026-11-01）

### 已实现并有本机证据

| 交付项 | 证据 |
| --- | --- |
| Rust 领域模型、SQLite v4（设置/任务/历史/封面/自动重试时间）、迁移前备份、崩溃恢复 | `cargo test --lib` 32 项通过；v2→v4 升级测试；隔离数据桌面恢复 E2E |
| yt-dlp/ffmpeg sidecar、假引擎 E2E、SHA-256 完整性校验、Job Object 进程树回收 | 32 项 Rust 测试；桌面 E2E；篡改 sidecar 后正式构建禁用引擎；资源布局启动实测 |
| B 站 WBI 清晰度矩阵、DASH 权限、锁定原因、b23/BVID 清洗、真实播放/弹幕/发布日期 | 真实网络矩阵与 b23 解析手动验证；正式构建真实结果截图 |
| 扫码接口、二维码倒计时/取消、Windows 凭据库、启动会话校验、权限变化重解析 | 真实护照接口二维码面板 E2E；假过期会话清除系统凭据/更新界面的 E2E；会话解析单元测试；未扫码登录 |
| 队列并发、暂停/继续/取消/重试、自动指数退避、优先级、限速、磁盘检查、崩溃恢复 | Rust 测试；正常/优先级/自动重试/崩溃恢复 4 个桌面 E2E |
| 字幕/弹幕 sidecar、封面缓存与 300 张/90 天保留、原子落盘、路径清洗 | 假引擎 E2E；封面真实缓存；文件和缓存测试 |
| 历史搜索、文件丢失、再次下载、取消/重试操作 | 桌面 E2E；历史文件缺失与重新入队验证 |
| v0.7 设置迁移、首次启动授权/目录/引擎/可选登录、脱敏诊断 | 桌面 E2E；迁移弹窗测试；诊断泄漏检查 |
| 前端类型检查、Playwright UI、响应式与主题 | `npm run typecheck`；5 项 Playwright；1040/900/640 溢出测试 |
| 自动更新代码、签名更新产物、GitHub Release 工作流、便携包、许可证 | 本地更新检查 E2E；`build:release` 生成版本绑定的 `.sig`；`verify:release` 校验版本/侧车/产物/签名；便携版通过 `BiliPocket.portable` 标记禁用自动覆盖并提示手动更新 |

### 尚未满足的外部/真机门禁

- **真实账号权限**：未使用用户授权账号扫码登录，因此登录/大会员清晰度矩阵、会话过期和真实字幕权限仍未经真机验证。
- **真实内容下载**：未下载任何真实视频；合并、音频转码、真实字幕/弹幕 sidecar 仍只有假引擎覆盖。
- **Windows Authenticode**：没有生产代码签名证书；自签名流程已验证主程序 exe、重建后的安装包、带 app-version 的 updater 签名以及 `verify:release` 的证书校验分支，生产证书仍需配置并做最终信任验证。
- **生产更新**：更新端点、签名私钥和 `latest.json` 托管未配置；当前构建通过空 `update-source.txt` 保持禁用；实际下载安装更新未执行。
- **托管 CI**：撰写时尚未初始化 Git 仓库，`.github/workflows/verify.yml` 与 `release.yml` 未在真实托管仓库运行。

### 状态

用户确认当前软件仅用于个人本地使用，因此 Windows Authenticode、公开更新端点和托管 CI 属于可选的公开分发工作，不作为个人使用的阻塞项。内部实现、静态检查、单元测试、浏览器回归、假引擎桌面 E2E 与发布工具已完成；真实授权账号登录和真实内容下载 smoke 由使用者本人执行。

