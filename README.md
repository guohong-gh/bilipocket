<p align="center">
  <img src="src/assets/logo.svg" width="72" height="72" alt="BiliPocket" />
</p>

<h1 align="center">BiliPocket</h1>

<p align="center">把想留的 B 站视频存到本地。解析、排队、下载、后处理，全在你自己的机器上跑完。</p>

<p align="center">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4" />
  <img alt="tauri" src="https://img.shields.io/badge/Tauri-2-24C8DB" />
  <img alt="rust" src="https://img.shields.io/badge/Rust-stable-DEA584" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-3DA639" />
</p>

![下载页：真实解析结果与清晰度矩阵](docs/screenshots/result.png)

---

## 这是什么

一个 Windows 桌面版的哔哩哔哩下载器。不登录也能下公开内容；登录之后，也只使用你账号本来就有的权限——没有会员绕过，没有 DRM 破解，也不跟风控躲猫猫。

技术上没什么魔法：Tauri 2 做外壳，Rust 管网络、队列、进程和落盘，界面是原生 ESM 直接塞进 WebView，没有打包器，也没有框架，改一行刷新就能看到。

**它干的事**

- 视频页、`b23.tv` 短链、BV 号、av 号，粘进去就能解析
- 队列并发 1–5、全局限速、断点续传、失败重试、随时暂停
- 下完自动补齐封面、字幕、弹幕、章节、NFO、多音轨

**它不干的事**

- 不遍历收藏夹、UP 主空间、番剧、排行榜、搜索页。这是产品定位，不是还没做
- 不碰会员和付费内容，不做反爬规避
- 不上传任何数据。除了哔哩哔哩自己的接口，它谁也不连

## 细节

**解析**

- 四种输入都认：视频页、`b23.tv` 短链、裸 BV 号、av 号
- 清晰度取 `support_formats` 和当前会话 DASH 流的并集。没登录时没有权限的档位灰显，原因直接写在下面——"登录后可下载"、"大会员专享"，不让你猜
- 同一条 BV 的分 P 用标准 `?p=N` 逐个入队；视频属于某个合集时，可以在结果页按需勾选。**只解析一次，不会偷偷翻页拉列表**

**下载**

- 队列能调并发（1–5）、限速、优先级，支持全部暂停 / 继续
- 任务级重试（次数和退避可配）加切片级重试；撞上 412 或 -352 就按 30/90/180 秒退避
- 断点续传可用；任务级进度事件按并发数自适应节流，避免高频 IPC 把界面拖卡
- 支持只下一段（`HH:MM:SS` 区间），和断点续传互斥

**后处理**（只动已经落盘的文件，失败不会把任务状态改成失败）

- 封面存成 `-poster.jpg` 或与视频同名，删任务时一起清掉
- 字幕出外挂 SRT / ASS，语言和格式可选
- 弹幕按类型导出
- 章节从 `view_points` 生成，MKV / MP4 统一走一次 ffmpeg 封装
- NFO 用 `movie` / `episodedetails` 双根节点，标题来源可选
- 多音轨走 `--audio-multistreams`，只收带语言标签的轨

**其它**

- 扫码登录，凭据进 Windows 凭据库；会话过期会自己清理并提醒
- 文件名模板认 `{title}` `{up}` `{quality}` `{bvid}` `{date:格式}` `{p}` 这些占位符，非法字符、Windows 保留名、超长路径统一清洗
- 引擎自诊断（yt-dlp / ffmpeg 的版本和可用性），能导出脱敏诊断包
- 托盘、单实例、窗口尺寸记忆、完成通知、暗色主题

## 界面

| 下载队列 | 设置 |
|---|---|
| ![队列](docs/screenshots/queue.png) | ![设置](docs/screenshots/settings.png) |

| 合集与下载选项 | 暗色主题 |
|---|---|
| ![下载选项](docs/screenshots/advanced-options.png) | ![暗色](docs/screenshots/result-dark.png) |

> 这几张都是桌面版跑出来的实拍，没换数据、没修图。示例是一条 1 分 17 秒的面食视频，挂在 175 集的合集下。第一张里 4K 和 1080P60 标着「大会员专享」、1080P 和 720P 标着「登录后可下载」——没登录就是这个样子，界面不会假装它们可用。

## 装起来

从 [Releases](https://github.com/guohong-gh/bilipocket/releases) 拿安装包。0.x 版本都标着 pre-release，看重稳定的话建议自己编译：

| 文件 | 说明 |
|---|---|
| [`BiliPocket_0.9.0_x64-setup.exe`](https://github.com/guohong-gh/bilipocket/releases/download/v0.9.0/BiliPocket_0.9.0_x64-setup.exe) | 安装版，双击装，yt-dlp 和 ffmpeg 已经打在里面 |
| [`BiliPocket_0.9.0_x64_portable.zip`](https://github.com/guohong-gh/bilipocket/releases/download/v0.9.0/BiliPocket_0.9.0_x64_portable.zip) | 便携版，解压即用，数据全留在解压目录的 `app-data/` 下 |

> 首次运行如果弹 SmartScreen，点「更多信息 → 仍要运行」即可。这个版本没有自动更新，升级需要自己下新版覆盖安装。

### 环境要求

| 依赖 | 版本 |
|---|---|
| Node.js | 18+ |
| Rust | stable（Windows 用 MSVC toolchain） |
| MSVC Build Tools | 打包 Windows 安装包时需要 |
| WebView2 Runtime | Windows 11 自带，Windows 10 可能要手动装 |

### 从源码跑

```bash
git clone https://github.com/guohong-gh/bilipocket.git bilipocket
cd bilipocket
npm install

# 桌面应用（自动起静态服务并打开 Tauri 窗口）
npm run dev

# 只开浏览器预览（改界面时更快，数据是假的）
npm run dev:web    # http://localhost:1420/dev/
```

> 两个命令都占 1420 端口。`dev:web` 还开着的时候跑 `npm run dev`，会直接报端口冲突。

> `npm run dev` 只起窗口，不打包 bundle resources。没放 sidecar 时界面照常能用，但解析和下载依赖的本地引擎不可用（debug 构建可以用临时引擎，见 `SECURITY.md`）。

### 打包

```bash
npm run build              # NSIS 安装包
npm run package:portable   # 便携 zip（关掉自动更新，手动换版本）
```

> 干净克隆得先补引擎：`npm run fetch:sidecars` 会从引擎 Release 下载，按 `ENGINE_MANIFEST.json` 校验 SHA-256，本地已有且哈希对得上就直接跳过。没补齐时上面两条命令会因为缺 bundle resource 直接失败——这是故意的，不接受用空文件凑出一个装不上引擎的包。

sidecar（yt-dlp / ffmpeg）不入库，统一由 `npm run fetch:sidecars` 从 Release 资产 `engines-2026.10` 拉取校验。干净克隆没补引擎时，`.github/workflows/verify.yml` 会跳过依赖 sidecar 的 E2E、打包和产物上传，其余检查照跑。

### 第一次打开

1. 选个下载目录（也可以跳过，用默认的）
2. 想登就扫码登录——不登录一样能下公开的、免费的内容
3. 粘链接 → 挑清晰度 → 加入队列

## 目录结构

```text
.
├─ src/                       前端（无构建步骤，Tauri 直接加载）
│  ├─ index.html              页面骨架
│  ├─ js/
│  │  ├─ app.js               入口装配：import + 首启引导 + 启动序列（约 180 行）
│  │  ├─ app/                 21 个功能模块，见下表
│  │  ├─ catalog.js           清晰度 / 账号档位 / 弹幕类型 / 字幕语言的静态目录与纯函数
│  │  ├─ settings-schema.js   设置项单一事实源（21 字段 + 归一/patch/wire）
│  │  ├─ store-desktop.js     桌面 store：把界面动作翻译成 Rust 命令
│  │  ├─ bridge.js runtime.js 平台判定与 store 选择
│  │  └─ ui.js tauri.js       通用组件与窗口能力封装
│  ├─ styles/                 设计令牌、组件、页面样式
│  └─ assets/
├─ src-tauri/                 Rust 后端
│  ├─ src/
│  │  ├─ commands.rs          Tauri 命令入口
│  │  ├─ queue.rs             任务调度、并发、重试、进度事件
│  │  ├─ engine/              yt-dlp 封装与输出解析
│  │  ├─ bilibili.rs          view/player 接口、WBI 签名、合集解析
│  │  ├─ auth.rs              扫码登录、凭据读写（Windows 凭据库）
│  │  ├─ db.rs                SQLite 持久化与版本迁移
│  │  ├─ files.rs             路径围栏、文件名清洗、sidecar 清理
│  │  ├─ postprocess.rs       封面/字幕/章节/NFO 的后处理编排
│  │  └─ domain.rs            领域模型与校验
│  ├─ binaries/               sidecar（*.exe 不入库，清单入库）
│  └─ tauri.conf.json         CSP、asset 作用域、打包配置
├─ dev/                       浏览器演示入口（mock store + 演示数据）
├─ tests/
│  ├─ unit/                   node:test 纯函数测试
│  └─ ui/                     Playwright 界面回归
├─ scripts/                   构建、校验、桌面端到端脚本
├─ docs/                      排查手册、跨平台评估、截图
├─ LICENSES/                  第三方（yt-dlp / FFmpeg）许可与清单
└─ RELEASE.md SECURITY.md     发布清单与安全说明
```

**前端分层**（`src/js/app/`）

| 层 | 模块 |
|---|---|
| 状态 | `parse-store.js` `dom.js` |
| 纯渲染 | `format.js` `quality-picker.js` `season-panel.js` `advanced-options.js` |
| 视图 | `result-view.js` `queue-view.js` `history-view.js` `home-view.js` `settings-view.js` |
| 交互 | `selection.js` `action-bar.js` `enqueue.js` `download-parse.js` |
| 外壳 | `router.js` `chrome.js` `shell.js` `platform.js` `theme.js` |
| 账号 | `auth.js` |

模块之间是允许循环导入的：函数声明在模块实例化阶段就绪，而所有调用都发生在加载之后。

## 技术栈

- **外壳**：Tauri 2 + Rust stable
- **后端**：tokio、reqwest、rusqlite、keyring、serde、md-5 / sha2（WBI 签名）
- **前端**：原生 ESM + CSS，无打包器、无框架；`tsc --noEmit` 做类型检查
- **测试**：`cargo test`、`node:test`、Playwright（Edge channel）

## 开发与测试

| 命令 | 作用 |
|---|---|
| `npm run typecheck` | 前端类型检查（`jsconfig.json` 是显式白名单） |
| `npm run test:unit` | 前端纯函数测试 |
| `npm run test:ui` | Playwright 界面回归 |
| `npm run test:desktop` | 隔离数据目录的 WebView2 端到端 |
| `npm run verify:privacy` | 校验生产源码不含演示数据与示例封面 |
| `npm run verify:sidecars` | 校验 sidecar 版本与 SHA-256 |
| `cargo test --lib` | Rust 单元测试 |

当前基线：`cargo test --lib` 123 通过 / 2 忽略，`clippy` 源码零告警，`tsc` 零错误，前端单测 42 项，Playwright 18 项。

## 下载下来的东西长什么样

```text
<下载目录>/
└─ 视频标题/                    每个视频一个文件夹
   ├─ 视频标题 [1080P].mp4
   ├─ 视频标题-poster.jpg       封面（可选）
   ├─ 视频标题.zh-CN.ass        字幕（可选，按语言一个文件）
   ├─ 视频标题.nfo              NFO（可选）
   └─ 视频标题-弹幕/           弹幕（可选，按类型分文件）
```

删任务时勾「删除文件」，这些 sidecar 会一起清掉。视频文件夹只在空的时候移除，**下载根目录永远不删**。

## 边界

- 只用来下载你拥有或已获授权的内容，同时遵守哔哩哔哩的服务条款和当地法律
- 不含 DRM 破解、付费内容绕过、反爬规避。撞上风控只做识别、退避和提示，硬刚的事不干
- 和哔哩哔哩官方没有任何关系
- 内置的 FFmpeg 是 GPL 构建，以独立进程调用。许可、来源与对应源码见 [`LICENSES/THIRD_PARTY.md`](LICENSES/THIRD_PARTY.md) 与 [`LICENSES/FFMPEG_SOURCE_OFFER.md`](LICENSES/FFMPEG_SOURCE_OFFER.md)

## 已知限制

- **只支持 Windows**。非 Windows 现在编译不过，跨平台的代价算过一遍，结论在 [`docs/CROSS_PLATFORM_ASSESSMENT.md`](docs/CROSS_PLATFORM_ASSESSMENT.md)
- 未签名发布，首次运行可能触发 SmartScreen；没配更新源时，自动更新那块会自己藏起来
- 高频解析或并发下载可能触发平台的访问频率校验，目前靠退避重试，没有主动的请求间隔下限
- 写章节要用 ffmpeg 二次封装，大文件会多花一点时间
- 浏览器入口（`dev/`）是纯模拟：选不了目录、发不了通知，也不写任何文件
- 窗口状态只记尺寸和最大化，不恢复位置

## 贡献

Issue 和 PR 都欢迎。动手前请先看 [`CONTRIBUTING.md`](CONTRIBUTING.md)，并确保这几条是绿的：

```bash
npm run typecheck && npm run test:unit && npm run test:ui
cd src-tauri && cargo test --lib && cargo clippy --lib --tests
```

## 许可证

源代码是 [MIT](LICENSE)。随包分发的 yt-dlp（The Unlicense）和 FFmpeg（GPL-3.0）保留各自的许可，细节见 [`LICENSES/THIRD_PARTY.md`](LICENSES/THIRD_PARTY.md)；FFmpeg 的对应源码和书面要约在 [`LICENSES/FFMPEG_SOURCE_OFFER.md`](LICENSES/FFMPEG_SOURCE_OFFER.md)。

## 还没定的事（首次公开前）

> 这些条目没法从仓库内容自动判断，已经在对应位置用 `[待确认 Tn]` 标好了。填完请删掉标记和表里那一行。已销项 T1、T2、T3、T4、T8、T10、T11、T12（T4 定为「引擎走 Release 资产托管 + 构建时按哈希拉取」）。

| 编号 | 事项 | 当前值 / 位置 | 未确认的后果 |
|---|---|---|---|
| T5 | CI secrets：`WINDOWS_CERTIFICATE*` / `TAURI_SIGNING_PRIVATE_KEY*` 都还没配 | `.github/workflows/release.yml`：缺私钥时自动降级为未签名发布，跳过 `.sig`、`latest.json` 和 `verify:release` 的签名项 | 签名发布不可用；流水线仍能产出未签名包 |
| T6 | updater 私钥：`tauri.conf.json` 里配了公钥，但配套私钥在本机和 CI secrets 里都不存在 | `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey` | v0.9.0 没产出 `.sig` 和 `latest.json`，`verify:release` 报 `missing updater signature`；自动更新（更新源本来就是空的）保持禁用 |
| T7 | GPL-3.0 FFmpeg 分发合规：随包分发 GPL 构建，需要提供完整对应源码或书面要约 | `LICENSES/FFMPEG_SOURCE_OFFER.md`（对应源码地址、完整 `configure` 参数、三年书面要约） | v0.9.0 已经随包分发，文档义务补齐了；想彻底没这个包袱就得换 LGPL 构建，代价是重做 sidecar 哈希并重新发版 |
| T9 | Rust crates 完整依赖许可清单 | `LICENSES/THIRD_PARTY.md` | 第三方许可清单不完整 |

---

<p align="center"><sub>BiliPocket 与哔哩哔哩无关联。请只下载你有权获取的内容。</sub></p>
