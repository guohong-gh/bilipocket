<p align="center">
  <img src="src/assets/logo.svg" width="72" height="72" alt="BiliPocket" />
</p>

<h1 align="center">BiliPocket</h1>

<p align="center">一个 Windows 桌面端的哔哩哔哩下载器。</p>

<p align="center">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4" />
  <img alt="tauri" src="https://img.shields.io/badge/Tauri-2-24C8DB" />
  <img alt="rust" src="https://img.shields.io/badge/Rust-stable-DEA584" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-3DA639" />
</p>

![下载页](docs/screenshots/result.png)

解析、排队、下载、后处理都在本机完成，不经过第三方服务器。不登录可以下公开内容；登录后也只使用账号已有的权限。

## 安装

从 [Releases](https://github.com/guohong-gh/bilipocket/releases) 下载。0.x 版本都标着 pre-release。

| 文件 | 说明 |
| --- | --- |
| [`BiliPocket_0.9.0_x64-setup.exe`](https://github.com/guohong-gh/bilipocket/releases/download/v0.9.0/BiliPocket_0.9.0_x64-setup.exe) | 安装版，yt-dlp 和 ffmpeg 已打包在内 |
| [`BiliPocket_0.9.0_x64_portable.zip`](https://github.com/guohong-gh/bilipocket/releases/download/v0.9.0/BiliPocket_0.9.0_x64_portable.zip) | 便携版，解压即用，数据保存在 `app-data/` |

首次运行可能弹 SmartScreen，点「更多信息 → 仍要运行」。当前版本没有自动更新，升级需要下载新版覆盖安装。

## 功能

- 解析：视频页、`b23.tv` 短链、BV 号、av 号
- 清晰度：取 `support_formats` 与会话 DASH 流的并集，无权限的档位灰显并注明原因
- 合集：按需勾选，分 P 用 `?p=N` 逐个入队，只解析一次
- 下载：并发 1–5、全局限速、断点续传、区间下载
- 重试：任务级与切片级分开，遇到 412 / -352 按 30 / 90 / 180 秒退避
- 后处理：封面、字幕（SRT / ASS）、弹幕、章节、NFO、多音轨
- 登录：扫码登录，凭据存入 Windows 凭据库，会话过期自动清理并提示
- 其它：文件名模板、引擎自诊断、托盘、单实例、完成通知、暗色主题

## 界面

| 下载队列 | 设置 |
| --- | --- |
| ![队列](docs/screenshots/queue.png) | ![设置](docs/screenshots/settings.png) |

| 合集与下载选项 | 暗色主题 |
| --- | --- |
| ![下载选项](docs/screenshots/advanced-options.png) | ![暗色](docs/screenshots/result-dark.png) |

截图来自桌面版实拍，示例是一条 1 分 17 秒的视频，挂在 175 集的合集下。未登录时 4K 和 1080P60 标注「大会员专享」，1080P 和 720P 标注「登录后可下载」。

## 使用

<details>
<summary>扫码登录</summary>

登录入口在设置页，用哔哩哔哩 App 扫码。凭据写入 Windows 凭据库，不落明文文件。会话失效后应用会清理旧凭据并提示重新登录。

</details>

<details>
<summary>文件名模板</summary>

支持 `{title}` `{up}` `{quality}` `{bvid}` `{date:格式}` `{p}` 占位符。非法字符、Windows 保留名和超长路径会统一清洗。

</details>

<details>
<summary>只下载一段</summary>

在下载选项里按 `HH:MM:SS` 填起止时间。与断点续传互斥，两者不能同时开启。

</details>

<details>
<summary>合集与分 P</summary>

一条 BV 的分 P 用标准 `?p=N` 拼接后逐个入队。视频属于某个合集时，结果页会列出全部条目，自行勾选需要的部分。应用不会主动翻页拉取列表。

</details>

## 从源码运行

| 依赖 | 版本 |
| --- | --- |
| Node.js | 18+ |
| Rust | stable（Windows 用 MSVC toolchain） |
| MSVC Build Tools | 打包 Windows 安装包时需要 |
| WebView2 Runtime | Windows 11 自带，Windows 10 可能要手动安装 |

```bash
git clone https://github.com/guohong-gh/bilipocket.git
cd bilipocket
npm install

# 桌面应用，自动起静态服务并打开 Tauri 窗口
npm run dev

# 只开浏览器预览，数据是模拟的
npm run dev:web    # http://localhost:1420/dev/
```

两条命令都占用 1420 端口，`dev:web` 还开着时跑 `npm run dev` 会报端口冲突。

`npm run dev` 不打包 sidecar。界面能正常打开，但解析和下载依赖的本地引擎不可用。

## 打包

```bash
npm run fetch:sidecars     # 干净克隆必做
npm run build              # NSIS 安装包
npm run package:portable   # 便携 zip
```

`fetch:sidecars` 从引擎 Release 拉取 yt-dlp 和 ffmpeg，按 `ENGINE_MANIFEST.json` 校验 SHA-256，本地已存在且哈希一致就跳过。没补齐时打包会失败，这是有意为之。

sidecar 二进制不入库。CI 在干净检出时会跳过依赖 sidecar 的 E2E、打包和产物上传，其余检查照常执行。

## 技术栈

- 外壳：Tauri 2 + Rust stable
- 后端：tokio、reqwest、rusqlite、keyring、serde、md-5 / sha2（WBI 签名）
- 前端：原生 ESM + CSS，无打包器、无框架，`tsc --noEmit` 做类型检查
- 测试：`cargo test`、`node:test`、Playwright（Edge channel）

## 测试

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | 前端类型检查 |
| `npm run test:unit` | 前端纯函数测试 |
| `npm run test:ui` | Playwright 界面回归 |
| `npm run test:desktop` | 隔离数据目录的 WebView2 端到端 |
| `npm run verify:privacy` | 校验源码不含演示数据与示例封面 |
| `npm run verify:sidecars` | 校验 sidecar 版本与 SHA-256 |
| `cargo test --lib` | Rust 单元测试 |

当前基线：`cargo test --lib` 123 通过 / 2 忽略，clippy 源码零告警，`tsc` 零错误，前端单测 42 项，Playwright 18 项。

提交 PR 前确保下面这些是绿的，其它约定见 [`CONTRIBUTING.md`](CONTRIBUTING.md)：

```bash
npm run typecheck && npm run test:unit && npm run test:ui
cd src-tauri && cargo test --lib && cargo clippy --lib --tests
```

## 输出结构

```text
<下载目录>/
└─ 视频标题/
   ├─ 视频标题 [1080P].mp4
   ├─ 视频标题-poster.jpg       封面（可选）
   ├─ 视频标题.zh-CN.ass        字幕（可选，按语言一个文件）
   ├─ 视频标题.nfo             NFO（可选）
   └─ 视频标题-弹幕/           弹幕（可选，按类型分文件）
```

删除任务时勾「删除文件」，这些附加文件会一起清理。视频文件夹仅在为空时移除，下载根目录不会被删除。

## 目录结构

<details>
<summary>展开</summary>

```text
.
├─ src/                       前端，无构建步骤，Tauri 直接加载
│  ├─ index.html              页面骨架
│  ├─ js/
│  │  ├─ app.js               入口装配与启动序列
│  │  ├─ app/                 21 个功能模块
│  │  ├─ catalog.js           清晰度、账号档位、弹幕类型、字幕语言的静态目录
│  │  ├─ settings-schema.js   设置项单一事实源
│  │  ├─ store-desktop.js     把界面动作翻译成 Rust 命令
│  │  ├─ bridge.js runtime.js 平台判定与 store 选择
│  │  └─ ui.js tauri.js       通用组件与窗口能力封装
│  ├─ styles/                 设计令牌、组件、页面样式
│  └─ assets/
├─ src-tauri/                 Rust 后端
│  ├─ src/
│  │  ├─ commands.rs          Tauri 命令入口
│  │  ├─ queue.rs             任务调度、并发、重试、进度事件
│  │  ├─ engine/              yt-dlp 封装与输出解析
│  │  ├─ bilibili.rs          view / player 接口、WBI 签名、合集解析
│  │  ├─ auth.rs              扫码登录、凭据读写
│  │  ├─ db.rs                SQLite 持久化与版本迁移
│  │  ├─ files.rs             路径围栏、文件名清洗、sidecar 清理
│  │  ├─ postprocess.rs       封面、字幕、章节、NFO 的后处理编排
│  │  └─ domain.rs            领域模型与校验
│  ├─ binaries/               sidecar，二进制不入库，清单入库
│  └─ tauri.conf.json         CSP、asset 作用域、打包配置
├─ dev/                       浏览器演示入口
├─ tests/                     node:test 单测与 Playwright 回归
├─ scripts/                   构建、校验、桌面端到端脚本
├─ docs/                      排查手册、跨平台评估、截图
├─ LICENSES/                  第三方许可与清单
└─ RELEASE.md SECURITY.md     发布清单与安全说明
```

</details>

## 已知限制

- 只支持 Windows。非 Windows 现在编译不过，评估结论在 [`docs/CROSS_PLATFORM_ASSESSMENT.md`](docs/CROSS_PLATFORM_ASSESSMENT.md)
- 未签名发布，首次运行可能触发 SmartScreen
- 没有可用的更新私钥，自动更新保持关闭，升级需要手动覆盖安装
- 不遍历收藏夹、UP 主空间、番剧、排行榜和搜索页
- 不处理会员与付费内容，不做反爬规避。遇到风控只做识别、退避和提示
- 高频解析或并发下载可能触发平台访问频率校验，目前只有退避重试
- 写章节要用 ffmpeg 二次封装，大文件会多花一些时间
- 浏览器入口 `dev/` 是纯模拟，选不了目录、发不了通知，也不写文件
- 窗口状态只记录尺寸和最大化，不恢复位置
- Rust crates 的完整依赖许可清单尚未整理，当前只覆盖直接依赖

## 许可证

源代码是 [MIT](LICENSE)。随包分发的 yt-dlp（The Unlicense）和 FFmpeg（GPL-3.0）保留各自许可，细节见 [`LICENSES/THIRD_PARTY.md`](LICENSES/THIRD_PARTY.md)。

内置的 FFmpeg 是 GPL 构建，以独立进程调用。对应源码地址、完整 `configure` 参数和三年书面要约在 [`LICENSES/FFMPEG_SOURCE_OFFER.md`](LICENSES/FFMPEG_SOURCE_OFFER.md)。

本项目与哔哩哔哩官方无关联。

## 致谢

- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [FFmpeg](https://github.com/FFmpeg/FFmpeg)
- [Tauri](https://github.com/tauri-apps/tauri)
