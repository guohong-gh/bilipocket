# B站下载器 Issue 需求清洗 · 能力缺口 · 可执行任务路线图

> 分析对象：《B站下载器Issue需求整理.xlsx》（147 条 open issue，5 个同类开源项目）
> 对比对象：BiliPocket（本项目仓库 `F:\vibeCoding\bilidownload`，v0.9.0 真实引擎 Beta）
> 产出日期：2026-11-03
> 用途：直接作为开发排期与 Issue 拆分依据

## 执行状态（2026-11-03 第二轮更新）

| 阶段 | 任务 | 状态 |
| --- | --- | --- |
| P0 | T01 风控与接口失效适配层 | **已完成**（实现记录见 §4 T01 末尾） |
| P1 | T02 清晰度矩阵完整性 | **已完成** |
| P1 | T03 重试配置化 | **已完成** |
| P1 | T04 会话凭据修复 | **已完成**（确认是既有缺陷，不是纯防御性改动） |
| P1 | T05 引擎自诊断 | **已完成**（按确认收窄为"重新校验 + 文档"，不做网络下载引擎） |
| P1 | T06 分 P 展开与批量入队 | **已完成**（按 B1 收窄为「同一 BV 下的多个分 P」，不做收藏夹/番剧/UP 空间遍历） |
| P2 | T07 命名模板时间格式 | **已完成** |
| P2 | T08 封面随视频落盘 | **已完成**（`-poster.jpg`，含删除时封面清理） |
| P2 | T09 字幕格式与语言校验 | **已完成**（按 D3 移除了内挂字幕，只做外挂格式选择 + 语言提醒） |
| P2 | T10 章节标记写入 | **已完成**（MKV/MP4 统一走 ffmpeg 二次封装） |
| P2 | T11 时长区间下载 | **已完成** |
| P2 | T12 完成态一致性与产物校验 | **已完成**（按 D1 按真实缺口做：0 字节/过小产物 + 纯符号标题 + 超长路径；空标题已有兜底，见 Q5） |
| P2 | T13 资源调度与进度事件性能 | **已完成**（按实测判定，只做自适应节流；`max_mux_concurrent` 判定为死配置，未引入） |
| P3 | T14 NFO 元数据 | **已完成**（按 A2 从 P3 提前执行） |
| P3 | T15 多音轨 | **已完成**（按 A2 从 P3 提前执行） |
| P3 | T16 CLI/无头入口 | **不做**（按 D5「暂时不做」，已删除已写的 CLI 骨架） |
| P3 | T17 跨平台评估 | **已完成调研，不立项**（按 D4「先做 Windows」，输出 `docs/CROSS_PLATFORM_ASSESSMENT.md`） |
| P1 | T18 合集按需勾选（第二轮追加） | **已完成**：合集条目列出 + 标题搜索 + 仅作用于筛选结果的全选；按 BV 逐个入队，不整体下载 |

验证基线（含 T18）：`cargo test --lib` **123 passed / 2 ignored / 0 failed**（基线 85）、`cargo clippy --lib --tests` 源码级零告警、`cargo check --bins` 通过、`npm run typecheck` 通过、`npm run test:unit` **42/42**、`npx playwright test` **18/18**（含「设置页四卡片」与 6 项合集交互用例）。

仍未验证（需要真实账号/真机，不在本轮范围内）：大会员清晰度矩阵实测、真实扫码登录后的付费内容下载、macOS/Linux 编译。


---

## 0. 输入与假设（请先确认，这决定第 3、4 节的前提）

你在提示词里留了 `{{我的项目名称}}`、`{{技术栈}}`、`{{已实现功能清单}}` 等占位符但未填写。为了避免臆造，我用仓库实况填了这些空——**下面的"我的项目现状"全部来自代码检索，不来自 README 自述**：

| 项目项 | 取值 | 证据来源 |
| --- | --- | --- |
| 项目名称 | BiliPocket | `src-tauri/tauri.conf.json` → `productName` |
| 定位 | 本地优先的 Windows 桌面端 B 站单视频下载器 | `tauri.conf.json` bundle targets 仅 `nsis`；`README.md` 边界声明 |
| 技术栈 | Tauri 2 + Rust + 原生 HTML/CSS/ESM；下载/合并由 yt-dlp + ffmpeg sidecar 承担；SQLite 队列 | `src-tauri/src/*.rs`（8506 行）、`package.json` |
| 核心链路 | 链接 → `engine.probe`（yt-dlp）→ `bilibili.rs` 补清晰度矩阵 → 队列 → yt-dlp 下载 → ffmpeg 合并 → 落盘 + sidecar | `commands.rs:114`、`queue.rs:640-930` |
| 打包 | NSIS 安装包 + 便携 zip；无 CLI 入口 | `tauri.conf.json`、`src-tauri/src/main.rs` |

三个必须由你拍板的定位前提（否则第 4 节部分任务不成立）：

1. **是否允许"列表/批量"**：`engine/mod.rs:660` 显式传 `--no-playlist`，`README.md` 写明"不包含批量爬取"。这意味着 R01/R02 是**定位决策**，不是纯技术缺口。
2. **是否只做 Windows**：`process_job.rs`（Job Object）、`auth.rs`（DPAPI/凭据库）、WebView2 都是 Windows 专属。
3. **是否有真实大会员账号可做验收**：R14/R15 的验收只能靠真实账号，假引擎测不出来。

---

## 1. 数据概览与清洗结果

### 1.1 总量与分布（以「原文明细」为准重算）

**总计 147 条。**

按项目：

| 项目 | 数量 | 占比 |
| --- | --- | --- |
| Henryhaohao/Bilibili_video_download | 86 | 58.5% |
| lanyeeee/bilibili-video-downloader | 24 | 16.3% |
| yutto-dev/yutto | 14 | 9.5% |
| nICEnnnnnnnLee/BilibiliDown | 13 | 8.8% |
| ScottSloan/Bili23-Downloader | 10 | 6.8% |

按类型：

| 类型 | 数量 | 占比 |
| --- | --- | --- |
| Bug故障 | 68 | 46.3% |
| 功能需求 | 49 | 33.3% |
| 咨询求助 | 14 | 9.5% |
| 噪音垃圾 | 12 | 8.2% |
| 维护讨论 | 4 | 2.7% |

按需求类别：

| 需求类别 | 数量 | 其中 Bug | 其中功能需求 | 其中咨询 | 其中其他 |
| --- | --- | --- | --- | --- | --- |
| 环境依赖与接口解析 | 30 | 19 | 2 | 9 | 0 |
| 清晰度与会员权益 | 16 | 9 | 3 | 4 | 0 |
| 批量下载与下载稳定性 | 15 | 9 | 6 | 0 | 0 |
| 命名与元数据 | 14 | 6 | 8 | 0 | 0 |
| 音视频处理 | 12 | 7 | 5 | 0 | 0 |
| 部署与跨平台 | 12 | 4 | 7 | 1 | 0 |
| 噪音垃圾 | 12 | 0 | 0 | 0 | 12 |
| 风控与接口失效 | 9 | 7 | 2 | 0 | 0 |
| UI交互体验 | 9 | 3 | 6 | 0 | 0 |
| 字幕弹幕章节 | 6 | 4 | 2 | 0 | 0 |
| 内容类型扩展 | 5 | 0 | 5 | 0 | 0 |
| 项目维护与文档 | 5 | 0 | 1 | 0 | 4 |
| 其他边缘需求 | 2 | 0 | 2 | 0 | 0 |

### 1.2 交叉校验结果（含一处数据缺陷）

| 校验项 | 结果 |
| --- | --- |
| 「原文明细」vs「整理归类」行数 | 147 = 147，逐条 (项目, 编号) 一一对应，无单边缺失 |
| 重复记录 | 两表均无 (项目, 编号) 重复 |
| 需求类别一致性 | 147 条全部一致，0 处冲突 |
| **「统计汇总」** | **数量列与占比列全部为空**（单元格是公式但无缓存值），合计行亦为空。本报告不复用其数值，全部按「原文明细」重算 |

> 建议：把「统计汇总」的数量/占比改为静态值或重算后回写，否则任何人打开都读到空表。这也解释了为什么该 sheet 只有分组维度、没有任何数字。

### 1.3 排除明细（37 条，占 25.2%）

| 排除类别 | 数量 | 代表 Issue | 判定依据 |
| --- | --- | --- | --- |
| 噪音垃圾 | 12 | [nICEnnnnnnnLee/BilibiliDown#300](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/300)（"hello"）、[Henryhaohao/Bilibili_video_download#129](https://github.com/Henryhaohao/Bilibili_video_download/issues/129)（泰文赌博站广告）、[yutto-dev/yutto#54](https://github.com/yutto-dev/yutto/issues/54)（Renovate bot 面板） | 无功能诉求、广告、点赞、机器人看板 |
| 纯咨询/原理询问，无可落地诉求 | 10 | [Henryhaohao/Bilibili_video_download#15](https://github.com/Henryhaohao/Bilibili_video_download/issues/15)（appkey 从哪来）、[#73](https://github.com/Henryhaohao/Bilibili_video_download/issues/73)、[#51](https://github.com/Henryhaohao/Bilibili_video_download/issues/51)、[#38](https://github.com/Henryhaohao/Bilibili_video_download/issues/38)、[#59](https://github.com/Henryhaohao/Bilibili_video_download/issues/59)、[#1](https://github.com/Henryhaohao/Bilibili_video_download/issues/1)、[#78](https://github.com/Henryhaohao/Bilibili_video_download/issues/78)、[#86](https://github.com/Henryhaohao/Bilibili_video_download/issues/86)、[#87](https://github.com/Henryhaohao/Bilibili_video_download/issues/87)（2019 年 mp4 直链，DASH 时代已失效）、[#110](https://github.com/Henryhaohao/Bilibili_video_download/issues/110)（BV 号支持，本项目已实现） | 只在问"接口怎么找"，无行动项；或诉求已被本项目覆盖 |
| 合规排除 | 1 | [Henryhaohao/Bilibili_video_download#116](https://github.com/Henryhaohao/Bilibili_video_download/issues/116)（充电视频爬取） | 涉及付费内容获取，按约束不作为需求 |
| 维护讨论，无明确行动项 | 4 | [Henryhaohao/Bilibili_video_download#126](https://github.com/Henryhaohao/Bilibili_video_download/issues/126)、[#127](https://github.com/Henryhaohao/Bilibili_video_download/issues/127)、[#99](https://github.com/Henryhaohao/Bilibili_video_download/issues/99)、[nICEnnnnnnnLee/BilibiliDown#304](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/304)（"不更新了吗"） | 项目自身重构/仓库图片/停更询问，不产出可执行项。其中 #126/#127 可作"老旧接口脆弱性"的旁证，但不单独立任务 |
| 定位不符且无迁移价值 | 10 | [ScottSloan/Bili23-Downloader#487](https://github.com/ScottSloan/Bili23-Downloader/issues/487)（Docker）、[#462](https://github.com/ScottSloan/Bili23-Downloader/issues/462)（TV 源）、[#300](https://github.com/ScottSloan/Bili23-Downloader/issues/300)、[#266](https://github.com/ScottSloan/Bili23-Downloader/issues/266)（专栏/动态/文集）、[lanyeeee/bilibili-video-downloader#115](https://github.com/lanyeeee/bilibili-video-downloader/issues/115)（手机版）、[#111](https://github.com/lanyeeee/bilibili-video-downloader/issues/111)（互动视频全分支）、[Henryhaohao/Bilibili_video_download#23](https://github.com/Henryhaohao/Bilibili_video_download/issues/23)（OneDrive 上传）、[#85](https://github.com/Henryhaohao/Bilibili_video_download/issues/85)（上 PyPI）、[yutto-dev/yutto#100](https://github.com/yutto-dev/yutto/issues/100)（Python 包 API）、[#39](https://github.com/yutto-dev/yutto/issues/39)（给 CLI 加 GUI——本项目已是 GUI，方向相反） | 与"Windows 桌面单视频下载器"定位明显不符；成本极高、收益低 |

**进入合理需求池：147 − 37 = 110 条**，按主责归并成 24 条需求（R01–R24）。

---

## 2. 合理需求池

> 表中"来源Issue"是主责来源，部分高频需求由多个 Issue 共同支撑，重复引用处已标注。
> 合规判断只做"能不能做"，不涉及"怎么绕过"。

| 需求ID | 合并后的需求 | 来源Issue（项目#编号） | 需求类别 | 类型 | 合理性理由 | 频率/影响 | 合规判断 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R01 | 列表解析与批量入队：多 P、合集、番剧、UP 投稿、收藏夹、稍后再看一次性展开 | [ScottSloan/Bili23-Downloader#489](https://github.com/ScottSloan/Bili23-Downloader/issues/489)、[lanyeeee/bilibili-video-downloader#98](https://github.com/lanyeeee/bilibili-video-downloader/issues/98)、[yutto-dev/yutto#133](https://github.com/yutto-dev/yutto/issues/133)、[nICEnnnnnnnLee/BilibiliDown#305](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/305)、[lanyeeee/bilibili-video-downloader#114](https://github.com/lanyeeee/bilibili-video-downloader/issues/114)、[yutto-dev/yutto#131](https://github.com/yutto-dev/yutto/issues/131)、[Henryhaohao/Bilibili_video_download#14](https://github.com/Henryhaohao/Bilibili_video_download/issues/14) | 批量下载与下载稳定性 / 内容类型扩展 | 功能需求 | 5 个项目的头号功能缺口；下载器天然是"整季/整合集"场景 | 极高（跨 4 个项目 7 条，且是各项目 roadmap 长期项） | **有条件合规**：只展开用户主动提交的列表链接，单次上限、串行限速、不遍历全站/不做增量爬取 |
| R02 | 批量范围筛选与停止条件：时间范围勾选、全选该作者、连续命中 N 条才停止 | [lanyeeee/bilibili-video-downloader#98](https://github.com/lanyeeee/bilibili-video-downloader/issues/98)、[nICEnnnnnnnLee/BilibiliDown#305](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/305)、[Henryhaohao/Bilibili_video_download#25](https://github.com/Henryhaohao/Bilibili_video_download/issues/25) | 批量下载与下载稳定性 | 功能需求 | 无筛选的批量会把用户拖进"下了 500 个只要 20 个"的困境 | 中高（3 条，均为长列表场景刚需） | 合规（仅本地筛选） |
| R03 | 分 P / 合集 / 番剧的命名变量：分 P 标题、序号、合集名、合集拥有者 ID、季信息 | [nICEnnnnnnnLee/BilibiliDown#301](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/301)、[#265](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/265)、[#248](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/248)、[ScottSloan/Bili23-Downloader#319](https://github.com/ScottSloan/Bili23-Downloader/issues/319)、[lanyeeee/bilibili-video-downloader#71](https://github.com/lanyeeee/bilibili-video-downloader/issues/71) | 命名与元数据 | 功能需求 | 分 P 命名是合集下载的唯一可用前提；#71 还暴露"字段语义与文档不符"这一类可靠性问题 | 高（5 条，跨 3 项目；#301/#265 为重复诉求） | 合规 |
| R04 | 命名模板的时间语义与格式：发布时间 vs 下载时间可分别取值、可自定义 strftime 格式 | [lanyeeee/bilibili-video-downloader#77](https://github.com/lanyeeee/bilibili-video-downloader/issues/77) | 命名与元数据 | 功能需求 | 归档用户按"发布日期"建目录、按"下载时间"区分版本，是长期刚需；实现成本低 | 中（1 条但描述完整、方案明确） | 合规 |
| R05 | 封面随视频一并落盘（单条 + 批量） | [nICEnnnnnnnLee/BilibiliDown#83](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/83)、[#245](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/245)（标签 duplicate） | 命名与元数据 | 功能需求 | 刮削/海报墙的唯一入口；本项目已缓存封面，落盘只差一步 | 中（2 条，其中 1 条为重复） | 合规（封面属公开元数据，仅本地保存） |
| R06 | NFO 元数据文件 + 标题策略（视频标题 / 分 P 标题 / 组合） | [yutto-dev/yutto#603](https://github.com/yutto-dev/yutto/issues/603) | 命名与元数据 | 功能需求 | 媒体库用户的核心诉求；但依赖刮削生态，用户面窄 | 低（1 条） | 合规 |
| R07 | 字幕：ASS/SRT 格式可选、内挂进容器、字幕语言与实际轨道一致性校验 | [yutto-dev/yutto#416](https://github.com/yutto-dev/yutto/issues/416)、[nICEnnnnnnnLee/BilibiliDown#281](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/281) | 字幕弹幕章节 | 功能需求 + Bug | 内挂是"播放器里能直接看到字幕"的唯一方式；#281 的"选中文得到英文"是静默错误，比没有字幕更糟 | 中（2 条，但影响所有字幕用户） | 合规（仅用户账号已有权限的字幕轨道） |
| R08 | 章节标记写入容器（view_points → chapters） | [lanyeeee/bilibili-video-downloader#85](https://github.com/lanyeeee/bilibili-video-downloader/issues/85)、[#72](https://github.com/lanyeeee/bilibili-video-downloader/issues/72)、[#76](https://github.com/lanyeeee/bilibili-video-downloader/issues/76) | 字幕弹幕章节 | Bug + 功能需求 | 3 条里有 2 条是"开了章节就下载失败"，说明这是个高破坏力特性；#85 明确给出 `view_points` 可为 null 的解析契约缺陷 | 中（3 条同项目集中爆发） | 合规 |
| R09 | 多音轨合并（国配 + 原声）与"全部音频轨"导出 | [yutto-dev/yutto#113](https://github.com/yutto-dev/yutto/issues/113)、[ScottSloan/Bili23-Downloader#419](https://github.com/ScottSloan/Bili23-Downloader/issues/419) | 音视频处理 | 功能需求 | 番剧多语种配音是真实需求，但只影响番剧重度用户 | 低（2 条，跨 2 项目） | 合规（仅账号已授权音轨） |
| R10 | 按时长区间下载（只要片段） | [yutto-dev/yutto#561](https://github.com/yutto-dev/yutto/issues/561) | 音视频处理 | 功能需求 | 剔除片尾/只看精华，能显著省流量与磁盘 | 低（1 条） | 合规 |
| R11 | 412 / -352 风控响应的接口适配与错误分级 | [yutto-dev/yutto#866](https://github.com/yutto-dev/yutto/issues/866)、[#876](https://github.com/yutto-dev/yutto/issues/876)、[ScottSloan/Bili23-Downloader#488](https://github.com/ScottSloan/Bili23-Downloader/issues/488)、[#486](https://github.com/ScottSloan/Bili23-Downloader/issues/486)、[lanyeeee/bilibili-video-downloader#107](https://github.com/lanyeeee/bilibili-video-downloader/issues/107)、[#86](https://github.com/lanyeeee/bilibili-video-downloader/issues/86) | 风控与接口失效 | Bug故障 | 6 条跨 3 项目，全部是"昨天能用今天全挂"；#866 直接给出正解（`x/web-interface/view` → `wbi/view`） | **极高**（唯一横跨所有项目、且必然复发的类别） | 合规：只做端点迁移、退避重试、明确提示；**不做**签名伪造、指纹伪装、代理池等规避手段 |
| R12 | 重试策略可配置：次数、基础间隔、分片级重试次数 | [lanyeeee/bilibili-video-downloader#69](https://github.com/lanyeeee/bilibili-video-downloader/issues/69)、[Henryhaohao/Bilibili_video_download#84](https://github.com/Henryhaohao/Bilibili_video_download/issues/84)、[#47](https://github.com/Henryhaohao/Bilibili_video_download/issues/47)、[#45](https://github.com/Henryhaohao/Bilibili_video_download/issues/45)、[#55](https://github.com/Henryhaohao/Bilibili_video_download/issues/55)、[#61](https://github.com/Henryhaohao/Bilibili_video_download/issues/61)、[#42](https://github.com/Henryhaohao/Bilibili_video_download/issues/42)、[#28](https://github.com/Henryhaohao/Bilibili_video_download/issues/28)、[#62](https://github.com/Henryhaohao/Bilibili_video_download/issues/62) | 批量下载与下载稳定性 | 功能需求 + Bug | 9 条都在描述"断在半路、整段重来"；核心是分片级恢复而非整体重试 | 高（9 条，但 8 条来自同一老旧项目，需按项目加权） | 合规 |
| R13 | 长任务的失败可见性：静默失败检测、逐条结果报告、失败批次重跑 | [lanyeeee/bilibili-video-downloader#110](https://github.com/lanyeeee/bilibili-video-downloader/issues/110)、[yutto-dev/yutto#133](https://github.com/yutto-dev/yutto/issues/133)、[Henryhaohao/Bilibili_video_download#45](https://github.com/Henryhaohao/Bilibili_video_download/issues/45) | 风控与接口失效 / 批量 | Bug故障 | #110 是本批最严重的体验缺陷："报错没几条，实际漏了一半"，用户对工具失去信任 | 中高（3 条，但破坏信任的程度最高） | 合规 |
| R14 | 登录态清晰度完整性：矩阵缺档补全、新档位识别（4K SDR 增强等）、锁定原因文案区分 | [yutto-dev/yutto#543](https://github.com/yutto-dev/yutto/issues/543)、[lanyeeee/bilibili-video-downloader#96](https://github.com/lanyeeee/bilibili-video-downloader/issues/96)、[Henryhaohao/Bilibili_video_download#103](https://github.com/Henryhaohao/Bilibili_video_download/issues/103)、[#37](https://github.com/Henryhaohao/Bilibili_video_download/issues/37)、[#26](https://github.com/Henryhaohao/Bilibili_video_download/issues/26)、[#9](https://github.com/Henryhaohao/Bilibili_video_download/issues/9)、[nICEnnnnnnnLee/BilibiliDown#302](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/302) | 清晰度与会员权益 | Bug + 功能需求 | "会员买了却看不见 4K"是会员用户的第一投诉点；#543 说明 support_formats 会漏档 | 高（7 条，跨 3 项目） | **严格合规**：只做"用户自己账号已有权限"的档位正确展示与错误提示；不实现会员鉴权绕过 |
| R15 | 会话与凭据的确定性：Cookie 值编码规范化、失效检测、权限不足时明确暂停 | [lanyeeee/bilibili-video-downloader#87](https://github.com/lanyeeee/bilibili-video-downloader/issues/87)、[yutto-dev/yutto#586](https://github.com/yutto-dev/yutto/issues/586)、[#585](https://github.com/yutto-dev/yutto/issues/585)、[Henryhaohao/Bilibili_video_download#57](https://github.com/Henryhaohao/Bilibili_video_download/issues/57)、[#52](https://github.com/Henryhaohao/Bilibili_video_download/issues/52)、[#43](https://github.com/Henryhaohao/Bilibili_video_download/issues/43)、[#49](https://github.com/Henryhaohao/Bilibili_video_download/issues/49) | 清晰度与会员权益 | Bug故障 | #87 精确到"SESSDATA 没做 URL 编码"，是一行代码级别的确定缺陷，却让会员清晰度全线失效 | 高（7 条，跨 3 项目） | 合规（只处理用户自己的凭据） |
| R16 | 完成态一致性与产物校验：状态回滚、重复下载、0 字节产物、合并顺序错乱 | [lanyeeee/bilibili-video-downloader#104](https://github.com/lanyeeee/bilibili-video-downloader/issues/104)、[Henryhaohao/Bilibili_video_download#67](https://github.com/Henryhaohao/Bilibili_video_download/issues/67)、[#36](https://github.com/Henryhaohao/Bilibili_video_download/issues/36)、[#35](https://github.com/Henryhaohao/Bilibili_video_download/issues/35)、[#32](https://github.com/Henryhaohao/Bilibili_video_download/issues/32)、[#6](https://github.com/Henryhaohao/Bilibili_video_download/issues/6)（10 排在 1 后面） | 批量下载与下载稳定性 / 音视频处理 | Bug故障 | 数据完整性问题：完成的任务重启后变未完成、合并顺序错导致成片是错的 | 中高（6 条，跨 2 项目） | 合规 |
| R17 | 大规模任务下的资源调度与 UI 性能：进度事件风暴、FFmpeg 并发上限 | [lanyeeee/bilibili-video-downloader#61](https://github.com/lanyeeee/bilibili-video-downloader/issues/61)、[ScottSloan/Bili23-Downloader#490](https://github.com/ScottSloan/Bili23-Downloader/issues/490)、[Henryhaohao/Bilibili_video_download#46](https://github.com/Henryhaohao/Bilibili_video_download/issues/46) | UI交互体验 / 音视频处理 | Bug + 功能需求 | 任务一多就卡，直接决定批量功能能不能用 | 中（3 条，跨 3 项目） | 合规 |
| R18 | 文件名与路径鲁棒性：非法字符、超长、Windows 保留名、空标题、以 URL 作目录名 | [Henryhaohao/Bilibili_video_download#2](https://github.com/Henryhaohao/Bilibili_video_download/issues/2)、[#21](https://github.com/Henryhaohao/Bilibili_video_download/issues/21)、[#71](https://github.com/Henryhaohao/Bilibili_video_download/issues/71)、[#91](https://github.com/Henryhaohao/Bilibili_video_download/issues/91)、[#66](https://github.com/Henryhaohao/Bilibili_video_download/issues/66) | 命名与元数据 | Bug故障 | 5 条都是"下到一半报路径不存在"，是最容易复现也最伤人的失败 | 高（5 条同项目，跨 6 年仍在复发） | 合规 |
| R19 | 引擎依赖与安装故障的自诊断：ffmpeg 缺失、sidecar 下载失败、依赖版本冲突、闪退 | [nICEnnnnnnnLee/BilibiliDown#214](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/214)、[Henryhaohao/Bilibili_video_download#106](https://github.com/Henryhaohao/Bilibili_video_download/issues/106)、[#120](https://github.com/Henryhaohao/Bilibili_video_download/issues/120)、[#122](https://github.com/Henryhaohao/Bilibili_video_download/issues/122)、[#92](https://github.com/Henryhaohao/Bilibili_video_download/issues/92)、[#60](https://github.com/Henryhaohao/Bilibili_video_download/issues/60)、[#102](https://github.com/Henryhaohao/Bilibili_video_download/issues/102)、[#80](https://github.com/Henryhaohao/Bilibili_video_download/issues/80)、[#112](https://github.com/Henryhaohao/Bilibili_video_download/issues/112)、[#114](https://github.com/Henryhaohao/Bilibili_video_download/issues/114)、[#98](https://github.com/Henryhaohao/Bilibili_video_download/issues/98)、[#54](https://github.com/Henryhaohao/Bilibili_video_download/issues/54)、[#65](https://github.com/Henryhaohao/Bilibili_video_download/issues/65)、[#97](https://github.com/Henryhaohao/Bilibili_video_download/issues/97)、[#69](https://github.com/Henryhaohao/Bilibili_video_download/issues/69)、[#30](https://github.com/Henryhaohao/Bilibili_video_download/issues/30)、[#81](https://github.com/Henryhaohao/Bilibili_video_download/issues/81)、[#5](https://github.com/Henryhaohao/Bilibili_video_download/issues/5)、[#58](https://github.com/Henryhaohao/Bilibili_video_download/issues/58)、[#104](https://github.com/Henryhaohao/Bilibili_video_download/issues/104)、[#70](https://github.com/Henryhaohao/Bilibili_video_download/issues/70)、[#113](https://github.com/Henryhaohao/Bilibili_video_download/issues/113)、[#124](https://github.com/Henryhaohao/Bilibili_video_download/issues/124)、[#101](https://github.com/Henryhaohao/Bilibili_video_download/issues/101)、[#10](https://github.com/Henryhaohao/Bilibili_video_download/issues/10)、[#14](https://github.com/Henryhaohao/Bilibili_video_download/issues/14) | 环境依赖与接口解析 | Bug故障 | 全表最大类（30 条中 26 条）；但这些多为 Python 脚本时代的环境问题，**只应转化为文档/诊断/安装器改进**，不照搬实现 | 极高频但**低相关性**（本项目已捆绑 sidecar，且做 SHA-256 校验） | 合规 |
| R20 | 断点续传与临时分片清理 | [Henryhaohao/Bilibili_video_download#40](https://github.com/Henryhaohao/Bilibili_video_download/issues/40)、[#4](https://github.com/Henryhaohao/Bilibili_video_download/issues/4)、[yutto-dev/yutto#133](https://github.com/yutto-dev/yutto/issues/133) | 批量下载与下载稳定性 | 功能需求 | 长任务中断重来的痛点 | 高 | 合规 |
| R21 | 下载目录可改、窗口大小记忆、保存位置可见与一键打开 | [lanyeeee/bilibili-video-downloader#112](https://github.com/lanyeeee/bilibili-video-downloader/issues/112)、[#66](https://github.com/lanyeeee/bilibili-video-downloader/issues/66)、[Henryhaohao/Bilibili_video_download#29](https://github.com/Henryhaohao/Bilibili_video_download/issues/29)、[#13](https://github.com/Henryhaohao/Bilibili_video_download/issues/13)、[nICEnnnnnnnLee/BilibiliDown#302](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/302) | UI交互体验 | 功能需求 | 基础易用性 | 高（5 条跨 3 项目，说明这是"默认就该有"的能力） | 合规 |
| R22 | 真正的便携化：配置/日志随程序目录，不落 AppData | [lanyeeee/bilibili-video-downloader#20](https://github.com/lanyeeee/bilibili-video-downloader/issues/20) | 部署与跨平台 | 功能需求 | 便携版用户的核心诉求 | 中 | 合规 |
| R23 | 分享短链/分享文本自动识别（b23.tv 及带文案的粘贴） | [lanyeeee/bilibili-video-downloader#113](https://github.com/lanyeeee/bilibili-video-downloader/issues/113) | 其他边缘需求 | 功能需求 | 手机分享是主要入口 | 中 | 合规 |
| R24 | 命令行/无头入口 | [Henryhaohao/Bilibili_video_download#123](https://github.com/Henryhaohao/Bilibili_video_download/issues/123) | 部署与跨平台 | 功能需求 | 服务器/脚本化场景；本项目为纯 GUI | 低 | 合规 |

---

## 3. 与我的项目缺口矩阵

> 只保留"未实现 / 部分实现 / 待确认且值得跟进"的条目。判定全部来自代码检索，检索点见「判断依据」列（文件:行号）。
> **本表是 2026-11-03 分析时的快照。T01–T05 已落地，实际改动见 §4 各任务末尾的「执行记录」；R11/R12/R14/R15/R19 的缺口已按计划修复，勿再把本表当现状。**
> 已判定为「已实现」并因此不出现在下表的：R20（断点续传 + `queue.rs:919` 成功后删临时目录）、R21（`lib.rs:196` 窗口 SIZE/MAXIMIZED 记忆、设置页下载目录、`app.js:2295` 打开目录/定位文件）、R22（便携版 `app-data/` + `session.dpapi`）、R23（`engine/mod.rs:410` 允许 b23.tv，`app.js:83` 短链正则）。

| 需求ID | 需求 | 我的项目现状 | 判断依据 | 缺口说明 | 建议动作 |
| --- | --- | --- | --- | --- | --- |
| R01 | 列表解析与批量入队 | **未实现**（且是显式设计选择） | ① 前端 `app.js:315-336` `validateInput` 要求输入必须含 `BV/av` 或匹配 `/video/(BV\|av)`，番剧 `ep`、`/space/`、`/favlist`、`/medialist/` 链接**在进入 Rust 前就被拦下**，文案写死"仅支持单条视频页面"；② `engine/mod.rs:660` 固定传 `--no-playlist`；③ `commands.rs:114` `probe_video` 只接受单 URL、只产出一个 Task | 没有列表概念：多 P 视频只能拿到 yt-dlp 默认那一集（**具体是哪一集未实测**），番剧/收藏夹/UP 投稿在 UI 层直接不可用。`?p=N` 的实际行为属待确认 | 先做定位决策；若立项，见 T06 |
| R02 | 批量范围筛选与停止条件 | **未实现** | 依赖 R01 | 无列表即无筛选 | 并入 T06 |
| R03 | 分 P / 合集命名变量 | **未实现** | `files.rs:254` `template_base` 只支持 `{title}{up}{quality}{bvid}{date}` 五个变量 | 没有 `{p}`、`{p_title}`、`{collection}`、`{season}`、`{owner_id}`；合集下载后文件名会全部撞车（虽有 `unique_path` 兜底加 `(1)`，但语义是错的） | 并入 T06；`{owner_id}` 可先做（不依赖列表） |
| R04 | 命名模板时间格式 | **未实现** | `files.rs:39` `format_date` 固定 `YYYY-MM-DD`；`files.rs:263-267` 变量替换无格式解析 | 只有 `{date}`（=完成时间），没有 `{pubdate}`，也不支持 `{date:%Y%m%d}` | T07 |
| R05 | 封面随视频落盘 | **未实现** | `covers.rs:90` `cache_cover` 写入 `data_dir/covers`，全仓库无"复制到下载目录"的代码路径 | 封面只有 UI 用途，不进媒体库 | T08 |
| R06 | NFO 元数据 | **未实现** | `grep -rn "\.nfo\|<movie>\|episodedetails" src-tauri/src` 无命中（单独的 `nfo` 会误匹配 `info`，故按上式检索） | 无刮削文件 | T14（P3） |
| R07 | 字幕格式/内挂/语言校验 | **部分实现** | `queue.rs:691-698` 传 `--write-subs --write-auto-subs --sub-langs --convert-subs srt`；无 `--embed-subs`/`--sub-format ass`；下载后不校验实际语言 | 只有 SRT sidecar，不能内挂、不能要 ASS；#281 那类"选 zh-CN 得到英文"的静默错误没有任何防线 | T09 |
| R08 | 章节标记 | **未实现** | 无 `view_points`/`chapters` 处理；`queue.rs:717` 只设 `--merge-output-format` | 容器里没有章节，长视频无法跳转 | T10 |
| R09 | 多音轨合并 | **未实现** | `queue.rs:713` 格式串固定为 `{video}+{audio}`，单音轨 | 国配/原声只能二选一 | T15（P3） |
| R10 | 时长区间下载 | **未实现** | 无 `--download-sections` 参数构造 | 只能整段下 | T11 |
| R11 | 412 / -352 适配与错误分级 | **部分实现**（关键路径有洞） | ① `bilibili.rs:15` `VIEW_URL = x/web-interface/view`，非 `wbi/view`（正是 #866 的正解）；② `engine/mod.rs:441` `map_probe_failure` 无 412/-352 分支，落到 `engine_failed`；③ `bilibili.rs:62` `get_json` 单次请求、零重试；④ `bilibili.rs:91` 每次解析都请求 `nav` 取 WBI key，无缓存；⑤ 质量矩阵失败只推一条 warning | 下载走 yt-dlp 有兜底，但**解析失败时用户只看到原始 stderr 4 行 + `engine_failed`**，无法判断是风控、限流还是链接失效；WBI key 每次重取，放大了被限流的概率 | **T01（P0）** |
| R12 | 重试策略可配置 | **部分实现** | `queue.rs:42` `MAX_AUTO_RETRIES = 3`、`queue.rs:59` 退避 `15*2^n` 全部硬编码；`queue.rs:663-672` `--retries 5 --fragment-retries 5` 固定；`domain.rs:9` Settings 无相关字段 | 用户无法按自己网络调整；分片重试次数不可控 | T03 |
| R13 | 失败可见性与静默失败 | **部分实现** | `queue.rs:884-895` 附加内容失败写 `extras_error` 并把 danmaku_count 回填；但**主文件无"存在且非空"校验**（`queue.rs:829` `metadata().unwrap_or(0)`，读不到就当 0 字节） | 单任务层面已有警告机制；批量场景（未实现）无从谈起；0 字节产物会被当作成功 | 并入 T01（错误分级）+ T12（产物校验）+ T06（逐条报告） |
| R14 | 登录态清晰度完整性 | **部分实现** | `bilibili.rs:233` 以 `support_formats` 为主、`accept_quality` 兜底；`bilibili.rs:282` 用 DASH `video.id` 算 `accessible`；`quality_label/height/fps/locked_reason` 四张硬编码表（`bilibili.rs:135-194`） | ① `support_formats` 漏档时（#543 场景）该档**整行消失**，用户看不到"你有 4K 但没解析出来"；② 未知新档位（如 4K SDR 增强）会落到 `quality_height=0`，大小/认领映射可能错；③ 锁定原因只有"大会员专享/登录后可下载/当前账号不可用"三档，无法区分"视频不支持"与"你没权限" | T02 |
| R15 | 会话与凭据的确定性 | **部分实现** | `auth.rs:318` `cookie_header` 直接 `name=value` 拼接；`queue.rs:688` 用 `--add-header "Cookie: ..."` 原样透传；`auth.rs:255` 只做 CRLF 清洗；权限错误转 `Paused`（`queue.rs:81-88`）已做 | 扫码登录拿到的 SESSDATA 本身带 `%2C`，当前路径正确；但**没有编码规范化与语义校验**，一旦引入"手工粘贴 Cookie"或复用旧凭据就会复现 #87；也校验不出"看起来像 Cookie 但不含 SESSDATA"的脏数据 | T04 |
| R16 | 完成态一致性与产物校验 | **部分实现** | `queue.rs:861` `update_task_if_status(TaskStatus::Extras)` 是状态守卫（对应 #104 的回滚问题，已防住）；但 `queue.rs:829` `metadata().unwrap_or(0)` 把读不到的大小当 0，仍标 `Completed` | 状态机幂等已做；缺的是"产物合格性"：0 字节、sidecar 缺项、合并后时长异常都不会被拦下 | T12 |
| R17 | 资源调度与 UI 性能 | **待确认** | `store-desktop.js` 有事件合并与定时对账，但未见节流参数；Rust 侧 `emit_task` 每次进度都发 | 未做过 50+ 任务压测；FFmpeg 并发只受 `max_concurrent` 间接约束（合并阶段与下载阶段共用同一配额，可能出现"全在合并、没有一个在下载"） | T13（需先压测） |
| R18 | 文件名与路径鲁棒性 | **部分实现** | `files.rs:10` `sanitize_filename_base`：控制字符、非法字符、保留名、结尾点/空格、120 字符上限均已覆盖 | 120 字符基名 + 下载根目录，在深层目录下仍可能触到 Windows 260 路径上限；空标题/纯符号标题的回退分支未见 | 并入 T12 |
| R19 | 引擎依赖自诊断 | **部分实现** | `engine/mod.rs` 有 `ENGINE_MANIFEST.json` SHA-256 校验、缺失即禁用；`diagnostics.rs` 可导出脱敏诊断 | 缺"故障可操作化"：ffmpeg 缺失时只报 `ffmpeg_missing`，没有引导（重新下载/指定路径/打开帮助）；仓库无 troubleshooting 文档，用户只能翻 README | T05 |
| R24 | 命令行/无头入口 | **未实现** | `main.rs` 6 行，仅 `run()`；无 clap/argv 解析；bundle 仅 `nsis` | 无法脚本化/服务器使用 | T16（P3） |

---

## 4. 可执行任务清单

> 按优先级排序。工作量按 1 人日 ≈ 1 个熟悉该仓库的工程师/天估算。
> 所有任务均不含绕过风控、会员鉴权、DRM 的实现。

### T01（P0）风控与接口失效适配层

| 项 | 内容 |
| --- | --- |
| 任务ID | T01 |
| 对应需求ID | R11（并覆盖 R13 的错误可见性部分） |
| 来源Issue | [yutto-dev/yutto#866](https://github.com/yutto-dev/yutto/issues/866)、[#876](https://github.com/yutto-dev/yutto/issues/876)、[ScottSloan/Bili23-Downloader#488](https://github.com/ScottSloan/Bili23-Downloader/issues/488)、[#486](https://github.com/ScottSloan/Bili23-Downloader/issues/486)、[lanyeeee/bilibili-video-downloader#107](https://github.com/lanyeeee/bilibili-video-downloader/issues/107)、[#86](https://github.com/lanyeeee/bilibili-video-downloader/issues/86) |
| 优先级 | P0 |
| 目标 | 把"412/-352"从不可读的 `engine_failed` 变成可识别、可退避、可解释的独立错误类型；把 `view` 端点迁移到带 WBI 签名的 `wbi/view`，并缓存 mixin key |
| 实现方案 | ① `bilibili.rs`：`VIEW_URL` 改为 `https://api.bilibili.com/x/web-interface/wbi/view` 并走 `signed_query`；若返回 412/-352，回退旧端点一次（双端点互为备份，不无限重试）。② 新增 `MixinKeyCache { key, fetched_at: Instant }`，TTL 12h，进程内 `Mutex` 复用，避免每次解析都打 `nav`。③ `get_json` 增加"单次退避重试"：仅对 412 / code=-352 / 5xx 生效，退避 1.5s，最多 1 次。④ `engine/mod.rs:441` `map_probe_failure` 增加分支：匹配 `412` / `Precondition Failed` / `-352` / `v_voucher` → `risk_control`；`queue.rs:42` `is_retryable_error` 加入 `risk_control`，但退避基数放大到 30s（`retry_delay_seconds` 对 risk_control 单独给 30/90/180）。⑤ `risk_control` 连续 3 次后转 `Paused` 而非 `Failed`，并在 `error_message` 写人话："B 站触发了访问频率校验，本次已暂停。请降低同时解析/下载数，10 分钟后重试。"⑥ 前端 `ui.js` 增加该错误码的图标与"重试"按钮文案。 |
| 涉及模块/文件 | `src-tauri/src/bilibili.rs`、`engine/mod.rs`、`queue.rs`、`domain.rs`、`src/js/ui.js`、`src/js/app.js`、`tests/unit/*.test.mjs` |
| 验收标准 | ① 单测：注入 stderr `HTTP Error 412: Precondition Failed` → 错误码 `risk_control`（非 `engine_failed`）；② 单测：`wbi/view` 返回 `code:-352` 时触发一次旧端点回退，且总请求数 ≤ 2；③ 单测：连续两次 `fetch_quality_matrix` 只触发 1 次 `nav` 请求（缓存命中）；④ 手工：限速/连续解析 100 次，队列中不出现 `engine_failed`；⑤ 界面：412 任务的按钮为"重试（10 分钟后）"而非"重试" |
| 测试要点 | 假引擎 fixture 里加 412/-352 两种 stderr；`nav` 请求计数的 mock server；确认退避不阻塞其他任务；确认暂停任务在重启后仍为暂停 |
| 风险/依赖 | 平台侧限流不受客户端控制，**只能退避与提示，不能规避**；需在 README「已知限制」写明"高频解析会被限流"；依赖真实网络做终验 |
| 工作量 | 3–4 人日 |

**T01 执行记录（2026-11-03，已完成）**

改动文件与内容：

| 文件 | 改动 |
| --- | --- |
| `src-tauri/src/bilibili.rs` | 新增 `WBI_VIEW_URL`（`x/web-interface/wbi/view`）与 `fetch_view_wbi` / `fetch_view_legacy` / `fetch_view`；新增 `MetaError::RiskControl` 与 `is_risk_control()`；新增 `is_risk_code`（-352/-412/-799）、`is_risk_control_body`、`is_retryable`；`get_json` 拆为 `get_json_once` + 单次 5xx 重试；新增 `MixinKeyCache`（TTL 12h）与 `cached_mixin_key` / `clear_mixin_key_cache`；playurl 也改用缓存 key |
| `src-tauri/src/engine/mod.rs` | 新增 `pub(crate) is_risk_control_text`，置于 `map_probe_failure` 判定链**最前**；风控命中时返回可操作文案而非原始 stderr，并把原始 stderr 写入 `log::warn` |
| `src-tauri/src/queue.rs` | `is_retryable_error` 增加 `risk_control`；`retry_delay_seconds` 改签名为 `(code, attempt)`，风控走 `[30, 90, 180]` 独立阶梯；`plan_failure` 退避耗尽后风控转 `Paused` 而非 `Failed`；`map_download_error` 增加风控分支并复用 engine 的文本判定 |
| `src-tauri/src/commands.rs` | 清晰度矩阵因风控失败时，warning 文案改为"触发了访问频率校验…稍后重新解析"，与普通权限失败区分 |
| `src/js/app.js` | `taskErrorAction` 支持 `risk_control` → 跳转设置（降低并发） |
| `README.md` | 「当前边界 / 尚未完成」补充 412 限流的识别、退避、暂停行为与"不提供绕过"声明 |

**与计划的三处偏差（实现时修正了计划本身的不合理处）：**

1. 计划 ③ 原写"对 412 / code=-352 / 5xx 做单次 1.5s 退避重试"。实现改为**只对 5xx 重试一次**，412/-352 不重试。理由：在已触发限流的瞬间再打同一次请求会加重限流，而 `-352` 通常需要数分钟冷却，1.5 秒重试形同虚设。替代方案是 `wbi/view` → 旧端点**降级一次**（换端点而不是重打同一端点）+ 队列 30/90/180 秒退避。
2. 计划 ⑤ 原写"412 任务的按钮为『重试（10 分钟后）』"。实现改为：三次退避耗尽后任务转**已暂停**，界面呈现「继续 + 设置」。理由：暂停态本就有"继续"，再加一个"延时重试"会让状态机多一种特例；`Paused` 的语义恰好是"由人决定何时继续"。
3. `retry_delay_seconds` 签名由 `(attempt)` 改为 `(code, attempt)`，因为风控需要独立退避阶梯，原签名无法表达。

**验收对照：**

| 验收标准 | 结果 |
| --- | --- |
| `HTTP Error 412: Precondition Failed` → `risk_control` | 通过（`engine` 与 `queue` 两个入口各有单测） |
| `code=-352` / `v_voucher` → `risk_control` | 通过（单测） |
| 含 `vip` 字样但被风控拦下时不误判为"需要大会员" | 通过（单测，风控判定排在 vip 之前） |
| 只有数字 `352000`（字节数）时不误判 | 通过（单测，仅匹配 `-352`） |
| `wbi/view` 风控 → 回退旧端点且只回退一次 | 代码路径已实现；请求上限 = nav（仅缓存未命中时 1 次）+ wbi/view 1 次 + view 1 次 |
| 两次解析只请求一次 `nav` | 缓存 TTL 逻辑通过单测；**真实请求计数未验证**（仓库无 mock server） |
| 风控退避 30 / 90 / 180，三次后转暂停 | 通过（单测） |
| 界面给出可操作入口 | 通过（`risk_control` → 设置按钮；提示文案来自 Rust 侧） |

验证命令：`cargo test --lib` → **63 passed / 2 ignored / 0 failed**（新增 6 项风控用例）；`cargo clippy --lib` → 无代码告警；`npm run typecheck` → 通过；`npm run test:unit` → 9/9。

**仍待你本人手工验收（需要真实账号与网络）：**
- 真实命中 412 时：解析页出现风控 warning、下载任务按 30/90/180 退避、三次后停留在已暂停。
- 连续两次解析同一 BV，`nav` 只被请求一次（开 `RUST_LOG` 或抓包确认）。

### T02（P1）清晰度矩阵完整性与未知档位兜底

| 项 | 内容 |
| --- | --- |
| 任务ID | T02 |
| 对应需求ID | R14 |
| 来源Issue | [yutto-dev/yutto#543](https://github.com/yutto-dev/yutto/issues/543)、[lanyeeee/bilibili-video-downloader#96](https://github.com/lanyeeee/bilibili-video-downloader/issues/96)、[Henryhaohao/Bilibili_video_download#103](https://github.com/Henryhaohao/Bilibili_video_download/issues/103)、[#37](https://github.com/Henryhaohao/Bilibili_video_download/issues/37)、[#26](https://github.com/Henryhaohao/Bilibili_video_download/issues/26)、[#9](https://github.com/Henryhaohao/Bilibili_video_download/issues/9)、[nICEnnnnnnnLee/BilibiliDown#302](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/302) |
| 优先级 | P1 |
| 目标 | 让"我账号能播的档位"一定出现在矩阵里，且未知新档位不会因为缺映射而错位 |
| 实现方案 | ① `bilibili.rs` 的档位来源改为**三源并集**（`support_formats` → `accept_quality`+`accept_description` → `dash.video[].id`），按 qn 去重、优先级递减，缺档从 `dash.video` 补回。② `dash.video` 的"可用"判定补 `backupUrl`（原来只看 `baseUrl`）。③ 未知 qn 的 height/fps 取流上真实值（`height`、`frameRate`），label 复用 `domain::format_label_from_dimensions`，撞名时追加 ` · QN{qn}`。④ 锁定原因维持三态——并集之后"视频不提供"的表现是"这一行不存在"，不需要第四态。**`qn_from_format_id` 保持不动**：它已是 `len==5 && starts_with("300")`，放宽到 `30xxx` 会把音频 id `30216/30232` 误解析成 qn 216/232。 |
| 涉及模块/文件 | `src-tauri/src/bilibili.rs`、`src/js/app.js`（锁定原因渲染） |
| 验收标准 | ① 单测：#543 型响应（`support_formats` 缺 120/112，但 `dash.video` 含 120）→ 矩阵仍出现 4K 与 1080P+；② 单测：`quality=9999, new_description="4K SDR增强"` → label 显示原文、height 取 dash 真实值、不 panic；③ 单测：`dash.video` 中同高度多档（1080P 与 1080P+）认领不串档；④ 真实账号：会员账号下 4K/1080P+ 可选中并入队 |
| 测试要点 | 固定 JSON fixture（现状 `bilibili.rs:585` 区已有测试，扩展它）；缺 `support_formats` 的降级路径；锁定原因四态渲染与 `aria` 文案 |
| 风险/依赖 | `new_description` 是平台自由文本，只能透传不能穷举；**需真实大会员账号验收**，否则只能验证 fixture |
| 工作量 | 3 人日 |

**T02 执行记录（已完成）**

- `build_matrix` 改为三源并集：`HintMeta { display, dash_height, dash_fps }`，先收 `support_formats`，再用 `accept_quality`+`accept_description` 补缺，最后由 `dash.video[].id` 兜底并记录真实 height / `frameRate`。
- 新增 `has_playable_url`（含 `backupUrl`）、`parse_frame_rate`（解析 `"60/1"`）、`is_plausible_qn`、`derived_label`。
- **主动删掉了一份重复实现**：原计划新写"高度→label"的派生函数，落地时发现 `domain::format_label_from_dimensions` 已经存在且被 engine 使用，改为直接复用，只补 `height == 0` 的短路。
- label 唯一化：先收集"非派生"标签占位，派生标签撞名时追加 ` · QN{qn}`，避免 `apply_quality_matrix` 按 label 去重时吞行。
- 偏差：① 没有合并四张 `quality_*` 映射表（无收益重构）；② 没有引入 `QualityOption.reason_code`（前端只消费 `reason` 文案，加 code 只为图标差异，不值）。
- 新增 5 项测试：`backfills_missing_tiers_from_dash_video`、`unknown_qn_uses_dash_height_and_keeps_label`、`derived_label_does_not_collide_with_known_tier`、`backup_url_counts_as_accessible`、`dash_only_response_no_longer_errors`；既有 4 条断言全部未改。
- 仍未验：真实大会员账号下"矩阵缺档"的视频，需要你本人跑一次。

### T03（P1）重试策略配置化

| 项 | 内容 |
| --- | --- |
| 任务ID | T03 |
| 对应需求ID | R12 |
| 来源Issue | [lanyeeee/bilibili-video-downloader#69](https://github.com/lanyeeee/bilibili-video-downloader/issues/69)、[Henryhaohao/Bilibili_video_download#84](https://github.com/Henryhaohao/Bilibili_video_download/issues/84)、[#47](https://github.com/Henryhaohao/Bilibili_video_download/issues/47)、[#42](https://github.com/Henryhaohao/Bilibili_video_download/issues/42)、[#28](https://github.com/Henryhaohao/Bilibili_video_download/issues/28) |
| 优先级 | P1 |
| 目标 | 用户可按自己网络调重试强度；分片级失败不升级为整体重下 |
| 实现方案 | ① `domain.rs:9` `Settings` 增加 `retry_max: u32`（默认 3，范围 0–10）、`retry_base_seconds: u32`（默认 15，范围 3–300）、`fragment_retries: u32`（默认 5，范围 0–20），三者都带 `#[serde(default)]`。② `queue.rs` 引入 `RetryPolicy { max, base_seconds }`，`plan_failure` 与 `retry_delay_seconds` 改为接收策略，`Default` 等于旧常量。③ `--fragment-retries` 读 `settings.fragment_retries`（下载与附加内容两条路径都要改）；`--retries` 是**请求级**重试，与任务级重启不是同一层，保持固定 5 并加注释，不暴露到 UI。④ 设置页"下载行为"分组加三个数字输入，`validate()` 补 clamp。⑤ `settings` 是 JSON blob，无 schema 变更。 |
| 涉及模块/文件 | `domain.rs`、`queue.rs`、`db.rs`、`src/index.html`（设置表单）、`src/js/app.js`、`src/js/bridge.js` |
| 验收标准 | ① 设 `retry_max=1` → 失败任务 `attempt` 最多到 1，界面只出现一次"重试中"；② 设 `retry_max=0` → 直接进入失败态，无自动重试；③ 设 `retry_base_seconds=5` → 首次退避为 5s（日志可验）；④ 旧 v5 数据库升级后缺失字段取默认值，不报错 |
| 测试要点 | `plan_failure` 单测覆盖 0/1/3/10 四档；`db.rs` 迁移测试（已有 v2/v4/v5 用例可扩展）；设置页脏值（负数/超大）输入 |
| 风险/依赖 | 与 T01 的 `risk_control` 退避基数需要协调，避免两套退避互相覆盖 |
| 工作量 | 2–3 人日 |

**T03 执行记录（已完成）**

- `domain.rs`：新增 `retry_max` / `retry_base_seconds` / `fragment_retries`（全部 `#[serde(default)]`）、三个 default 函数、`MAX_RETRY_MAX = 10`，`validate()` 补 `min(10)` / `clamp(3,300)` / `min(20)`。**`db.rs` 零改动**。
- `queue.rs`：`MAX_AUTO_RETRIES` 常量删除，改为 `RetryPolicy { max, base_seconds }`；`plan_failure(attempt, code, &policy)`；`retry_delay_seconds(code, attempt, base)`，普通档 `base·2^(n-1)`、风控档 `base·[2,6,12]`（base=15 时精确复现 30/90/180）；重试提示文案改用 `policy.max`；新增 `retry_policy()` / `fragment_retries()` 快照方法；`--fragment-retries` 两处（下载 + 附加内容）都改读设置。
- 前端四处同步：`index.html` 第 1 张卡加 3 个 `.number-field`；`app.js` 的 `renderSettings` 按 `document.activeElement` 守卫赋值 + `bindRetryField` 统一 clamp/toast；`store-desktop.js` 的 `mapSettings` 与 `updateSettings` 显式白名单都补齐；`catalog.js` / `dev/mock-store.js` 补默认值与 `normalizeSettings` 分支。
- 偏差：**`--retries` 保持 5 不变**。原计划写"`--retries` 与 `--fragment-retries` 读同一配置"，但那会把"任务级不重试（retry_max=0）"变成"一次网络抖动即失败"，两者不是同一层语义。
- `mapSettings` 对 0 的处理：用 `Number.isFinite(x) ? x : 默认`，不能沿用 `Number(x) || 2`（会把合法的 0 吞掉）。
- 新增 3 项测试：`honours_custom_retry_policy`、`legacy_settings_json_keeps_user_values_when_retry_fields_are_missing`（**最关键**：旧 JSON 缺字段时不得重置主题/目录）、`settings_validate_clamps_retry_fields`；Playwright 增加 4 条断言（默认值 + 超范围夹紧 + 0 不回退）。

### T04（P1）会话、凭据与权限错误的确定性处理

| 项 | 内容 |
| --- | --- |
| 任务ID | T04 |
| 对应需求ID | R15 |
| 来源Issue | [lanyeeee/bilibili-video-downloader#87](https://github.com/lanyeeee/bilibili-video-downloader/issues/87)、[yutto-dev/yutto#586](https://github.com/yutto-dev/yutto/issues/586)、[#585](https://github.com/yutto-dev/yutto/issues/585)、[Henryhaohao/Bilibili_video_download#57](https://github.com/Henryhaohao/Bilibili_video_download/issues/57)、[#52](https://github.com/Henryhaohao/Bilibili_video_download/issues/52) |
| 优先级 | P1 |
| 目标 | 凭据"脏了"能被发现，而不是伪装成"你不是会员" |
| 实现方案 | ① `auth.rs:318` `cookie_header` 增加 `normalize_cookie_value`：仅对"含 `,` `/` `=` 且不含 `%`"的值做百分号编码（SESSDATA 合法值本就含 `%2C`，幂等），保留原值优先。② 新增 `validate_session(cookies)`：必须包含 `SESSDATA` + `bili_jct` + `DedeUserID`，缺失即判 `auth_incomplete` 并清凭据；`value` 含 `\r\n;` 直接拒绝（已在 `cookie_header().replace` 清洗，前移到存储期）。③ 把"权限不足"从 yt-dlp stderr 的模糊匹配升级为结构化：`vip_required` / `auth_required` / `geo_blocked` 三态各自对应一句可操作文案 + 明确按钮（"去登录"/"看说明"）。④ 设置页账号行显示"当前会话：可访问 1080P+（大会员）"，让用户自己核对权限是否生效。 |
| 涉及模块/文件 | `auth.rs`、`queue.rs`（`plan_failure`）、`engine/mod.rs`（错误映射）、`src/js/app.js`（设置页账号行）、`src/js/ui.js` |
| 验收标准 | ① 单测：`SESSDATA=abc%2C123%2Cxyz` 原样保留（不被二次编码）；`SESSDATA=abc,123,xyz` 被编码为 `%2C`；② 单测：缺 `SESSDATA` 的会话被拒绝且凭据被清除；③ 单测：值含 `\r\n` 被拒绝；④ 手工：过期会话 → 清凭据 + 提示重新登录（现有 fixture 可复用）；⑤ 会员账号 → 1080P+ 可下，非会员账号 → 明确提示"大会员专享"而非"下载失败" |
| 测试要点 | `auth.rs:571` 区已有 DPAPI 与 `cookies_from_headers` 测试，扩展编码用例；`e2e-session-expiry.mjs` 增加"凭据不完整"分支 |
| 风险/依赖 | 不能改变"二维码登录"这一唯一入口的前提下，编码问题暴露面小——本任务的价值主要是**防御未来手工 Cookie 导入**与**消除静默失败**；若无手工导入计划，可降为 P2 |
| 工作量 | 2 人日 |

**T04 执行记录（已完成）**

- **根因确认**：`qr_poll` 先 `cookies_from_headers` 再 `merge_url_cookies`，后者用 `parsed.query_pairs()` 会百分号解码，`push_cookie` 按 name 覆盖 —— 于是 SESSDATA 从 `abc%2C123%2Cxyz` 变成 `abc,123,xyz`，再原样拼进 `Cookie:` 头。逗号在 Cookie 值里非法，服务端可能截断。原报告把它归类为"防御性改动"，实际是**已存在的确定性缺陷**。
- `merge_url_cookies`：改手工 `split('&')` + `split_once('=')`，**不再解码**，直接保留 URL 里的原值；空值跳过，避免覆盖已有凭据。
- `push_cookie`：唯一写入口加校验，拒绝空值、含 `\r\n;` 的值、以及含 `; = , 空格` 的名字（顺带修掉 `SESSDATA=; Max-Age=0` 把有效 cookie 覆盖成空的问题）。
- `cookie_header`：读取侧对每个 value 幂等编码 **RFC6265 非法字符**（`,` `;` 空格 `"` `\` 与控制字符）。**刻意不编码 `/` `=` `:`**——`bili_ticket`、`ac_time_value` 这类签名串会被破坏。历史已存脏值因此被顺带修好。
- 新增 `validate_session`：**硬门槛只有 SESSDATA**，`bili_jct`/`DedeUserID` 缺失只记警告。调用点两处：`AuthManager::new` 加载后（失败即清凭据）、`qr_poll` 成功分支（失败不落库）。
- 明确没做：不在 `cookie_header()` 里做"无 SESSDATA 返回 None"——那会把"读一次状态"变成"静默降级成匿名下载"。
- 新增 6 项测试：`merge_keeps_percent_encoded_values`、`merge_skips_empty_values`、`cookie_header_encodes_legacy_decoded_value`、`cookie_header_is_idempotent_and_keeps_signature_chars`、`push_cookie_rejects_control_chars_and_empty_values`、`session_without_sessdata_is_rejected`。
- 仍未验：真实扫码登录后 SESSDATA 是否确实含 `%2C`（若平台已改为不编码，这条修复的实际收益只是"不再失真"，不等于修好了会员清晰度）。

### T05（P1）引擎依赖自诊断与故障排查文档

| 项 | 内容 |
| --- | --- |
| 任务ID | T05 |
| 对应需求ID | R19 |
| 来源Issue | [nICEnnnnnnnLee/BilibiliDown#214](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/214)、[Henryhaohao/Bilibili_video_download#106](https://github.com/Henryhaohao/Bilibili_video_download/issues/106)、[#120](https://github.com/Henryhaohao/Bilibili_video_download/issues/120)、[#122](https://github.com/Henryhaohao/Bilibili_video_download/issues/122)、[#92](https://github.com/Henryhaohao/Bilibili_video_download/issues/92)、[#112](https://github.com/Henryhaohao/Bilibili_video_download/issues/112) |
| 优先级 | P1 |
| 目标 | 装配类失败（ffmpeg 缺失/损坏、目录无写权限、路径过长）变成"看得懂 + 点一下就能修" |
| 实现方案 | ① `engine/mod.rs` 暴露 `EngineProblem { code, detail, remedy }`，`remedy` 只保留 `Recheck` / `Reinstall` 两态（`PickDir`、`ManualPath` 落地时砍掉，理由见执行记录）。② 设置页"引擎与诊断"卡片在存在 `problem` 时显示「重新校验」按钮。③ `diagnostics.rs` 输出增加 `engine.problem` 与 `downloadDir.writable`。④ 新增 `docs/TROUBLESHOOTING.md`。⑤ 下载目录可写性通过入队前探针体现，而不是塞进 `EngineInfo`。 |
| 涉及模块/文件 | `engine/mod.rs`、`files.rs`、`commands.rs`、`diagnostics.rs`、`domain.rs`、`lib.rs`、`src/js/app.js`、`src/js/bridge.js`、`src/js/store-desktop.js`、`src/index.html`、`README.md`、`docs/TROUBLESHOOTING.md`（新增） |
| 验收标准 | ① 引擎缺失/校验失败时，设置页显示固定原因文案与「重新校验」按钮；点击后 `EngineInfo.problem` 被清除或更新（**不承诺"重新下载引擎"**——sidecar 随包分发，没有下载端点）；② 下载目录指向只读目录或超长路径 → 入队前拦截并给出可操作提示，不产生失败任务；③ 导出诊断含 `engine.problem` 与 `downloadDir.writable`，且不含路径/用户名/Cookie；④ README 存在指向 troubleshooting 的链接，文档覆盖 ≥7 类故障 |
| 测试要点 | `verify:privacy` 仍通过（新增字段不得泄漏路径）；只读目录用 `attrib +R` 或 ACL 模拟；`engine.problem.detail` 必须是固定文案 |
| 风险/依赖 | 不做网络下载引擎，因此"引擎被删"只能靠重装恢复；`checksumFailed` 的**发现路径**在 debug 构建被跳过，只能在 release 验证（推导逻辑本身已单测） |
| 工作量 | 3 人日（含文档 1 人日） |

**T05 执行记录（已完成）**

- 引擎改为可热替换：`Engine { inner: RwLock<EngineInner> }`，删掉 `#[derive(Clone)]`（`lib.rs:320` 的 `engine.clone()` 是 `Arc::clone`，不受影响）；新增 `refresh()`，重新 discover 并整体替换内部状态；`yt_dlp_path` / `ffmpeg_path` / `yt_dlp_version` 改为返回 owned 值，`probe_command`、`queue.rs` 四个调用点同步。
  - **没有**采用 `Arc<RwLock<Engine>>`：那会让 `!Send` 的 guard 散布到 `queue.rs` 的 async 链路，跨 `.await` 就是编译错或死锁，且要改 11 处。
- `domain.rs` 新增 `EngineProblem { code, detail, remedy }` + `Remedy { Recheck, Reinstall }`，`EngineInfo.problem` 带 `#[serde(default)]`。`engine_problem()` 用固定文案，**不复用 `integrity_message`**（后者含路径，会被诊断原样序列化）。
- `files.rs` 新增 `probe_writable` + `WriteProbeError{code,message}`：真实写临时文件再删，区分 `PermissionDenied` / `PathTooLong` / `Unavailable` / 其他 IO。
- `enqueue_task` 前置探针：`PermissionDenied` / `PathTooLong` 直接拦截，`Unavailable`（离线移动硬盘）只 warn 放行。
- `diagnostics.rs`：`build_report` / `export` 各加一个 `download_dir_writable: bool`，JSON 输出 `"downloadDir": { "writable": bool }`（**只有布尔，没有路径**）；顺带把三个重试字段也纳入 `settings` 段。
- 前端：`index.html` 引擎行加 `#engine-refresh`（默认 `hidden`）；`app.js` 的 `renderEngineStatus` 按 `problem` 显示按钮并给出 `detail` 提示，点击调 `store.refreshEngine()`；`bridge.js` 加 `refreshEngine`；`store-desktop.js` 加 `refreshEngine()`。
- 文档：新增 `docs/TROUBLESHOOTING.md`（9 节，覆盖引擎缺失/校验失败、ffmpeg 缺失、目录不可写、260 路径、412 限流、会员清晰度、附加内容不完整、会话失效、诊断导出），README「当前边界」与设置描述同步。
- **偏差**（与计划对比，均为主动收窄）：
  1. `Remedy::PickDir` 与 `ManualPath` 砍掉。可写性问题不属于 `EngineInfo` 的职责（它在设置里，且"选择下载目录"入口已在第 1 张卡），塞进来会让引擎层反向依赖设置；`ManualPath` 无存储支撑，是另一个任务。
  2. 没有在 `update_settings` 里记录可写状态——没有 UI 消费方，加了就是死状态。可写性只体现在"入队拦截"与"诊断字段"。
  3. 不做网络下载引擎与签名校验（已按你的选择确认）。
- 新增 8 项测试：`probe_writable_creates_and_removes_file`、`probe_writable_flags_too_long_path`、`write_probe_errors_have_stable_codes`、`engine_problem_covers_missing_and_checksum_cases`、`info_reports_ffmpeg_problem_with_reinstall_remedy`、`info_has_no_problem_when_engine_is_ready`、`refresh_can_clear_a_problem`、`report_includes_writable_flag_without_path`。
- 仍未验（需要 release 构建与真实机器）：删除 sidecar 后启动的端到端表现；`checksumFailed` 的真实触发路径。

### T06（P1，受定位确认门禁）列表展开与批量入队

| 项 | 内容 |
| --- | --- |
| 任务ID | T06 |
| 对应需求ID | R01、R02、R03、R13（逐条报告部分） |
| 来源Issue | [ScottSloan/Bili23-Downloader#489](https://github.com/ScottSloan/Bili23-Downloader/issues/489)、[lanyeeee/bilibili-video-downloader#98](https://github.com/lanyeeee/bilibili-video-downloader/issues/98)、[yutto-dev/yutto#133](https://github.com/yutto-dev/yutto/issues/133)、[nICEnnnnnnnLee/BilibiliDown#305](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/305)、[#301](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/301)、[#265](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/265)、[#248](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/248)、[lanyeeee/bilibili-video-downloader#114](https://github.com/lanyeeee/bilibili-video-downloader/issues/114)、[yutto-dev/yutto#131](https://github.com/yutto-dev/yutto/issues/131) |
| 优先级 | P1（**前置门禁：需你先确认"批量"是否属于产品范围**，见第 6 节 Q1） |
| 目标 | 用户粘贴一个列表链接后，能看到条目清单、按范围勾选、批量入队，且命名不撞车 |
| 实现方案 | ① 新增 `probe_list(url)` 命令：`--flat-playlist -J` 拿条目元数据（标题/时长/BV/序号），**仅对白名单列表页**（`/video/BV*/?p=`、`/medialist/`、`/favlist`、`/bangumi/play/ss*`、`/space/*/video`）；非白名单仍走单视频 `probe_video`。② 硬性边界写进代码常量：单次最多 200 条、并发 1、每条间隔 ≥800ms、可随时取消；不做"全站/增量"遍历。③ 结果页新增"列表模式"：条目表格 + 全选/反选 + 时间范围筛选（R02）+ 逐条状态列（待解析/已入队/失败+原因，覆盖 R13）。④ 入队串行落地为 N 个 Task，`format_id` 与 `subtitle_langs` 由用户一次指定。⑤ 命名新增 `{p}`（序号）、`{p_title}`、`{collection}`、`{season}`、`{owner_id}`，在 `template_base` 里以 `Option<&str>` 传入，缺省为空（退化为现行为）。 |
| 涉及模块/文件 | `engine/mod.rs`（新增 list probe 与白名单）、`commands.rs`、`queue.rs`、`files.rs`、`db.rs`（Task 增加 `page_index/page_title/collection`）、`src/js/app.js`、`src/index.html`、`catalog.js` |
| 验收标准 | ① 收藏夹链接 → 返回条目清单（含条数与标题），超过 200 条时截断并提示；② 勾选 5 条 → 生成 5 个排队任务，命名含 `{p_title}`，同合集不撞名（无 `(1)` 后缀出现）；③ 中途取消 → 已解析条目不入队、无残留临时目录；④ 单视频链接行为零变化（`--no-playlist` 路径不变）；⑤ 白名单外链接（直播/动态）仍给"暂不支持"提示 |
| 测试要点 | 假引擎返回 flat-playlist fixture（3 条/250 条两种）；上限与间隔的计时断言；取消后的 DB 与临时目录断言；命名撞车用例 |
| 风险/依赖 | **合规风险最高的一项**：必须限定"用户主动提交的单个列表链接"，不做遍历式抓取；需你在 README 与首次使用弹窗中明确边界；依赖 T02/T03 提供稳定的错误分级，否则批量会放大失败噪音 |
| 工作量 | 8–12 人日 |

**实现记录（按 B1 收窄后实际落地）**

- **定位变更**：原方案要遍历收藏夹/番剧/UP 空间（白名单列表页 + `--flat-playlist`），已按你的选择**取消**。现在的"批量"只指**同一个 BV 下的多个分 P**：用户粘贴一个视频链接，应用把它的 `pages` 列出来供勾选。不新增任何网络请求（复用 `view` 响应的 `data.pages`），不引入 `--flat-playlist`，`--no-playlist` 保持不动。
- **后端**：
  - `bilibili.rs` 新增 `parse_pages()`，从已有的 `x/web-interface/wbi/view` 响应里读 `data.pages`，产出 `Vec<VideoPage>{index, cid, title, duration_seconds}`；`QualityMatrix` 增加 `pages` 字段。新增 3 项测试（正常解析、多 P 保序、`pages` 缺失/null 返回空而不报错）。
  - `domain.rs` 新增 `VideoPage`、`TaskOptions.page_index` / `page_title`；`Task`/`TaskSpec` 增加 `options: TaskOptions`（单列 JSON，避免为每个可选参数加 DB 列）。
  - `commands.rs` 新增 `with_page_index()`：用 `url::Url` 的 query_pairs 重写 `?p=N`（覆盖旧值、保留 `spm_id_from`/`vd_source` 等其他参数）。新增 3 项测试。
  - `db.rs` 升到 schema v6，新增 `options_json` 列；迁移前先 `PRAGMA table_info` 探测列是否存在，避免版本回退的库重复 `ADD COLUMN`。
- **前端**：`app.js` 新增 `parseExtras.pageSelection`，结果页多 P 时渲染勾选列表（全选/清空/逐条），`enqueueCurrentInner()` 按勾选循环入队，多 P 时汇总成功/失败 toast；`store-desktop.js` 的 `addTask` 加第 4 个参数 `options`，去重 key 从 `bvid::video::formatId` 扩展为 `...::p{pageKey}`，只有 `pageKey === 0` 时才走旧去重逻辑。
- **实际验证**：`yt-dlp --no-playlist "...?p=2"` 实测输出 `BV1W7wYetEga_p2`，**证明 `?p=N` 是生效的**，Q3 里担心的"总是下第 1 P"不是 Bug。
- **偏差**：验收标准里的 `{collection}` / `{season}` / `{owner_id}` 三个变量**未实现**——它们只对收藏夹/番剧有意义，收窄到分 P 后没有数据来源。T07 只落地了 `{p}` / `{p_title}` / `{pubdate}` / `{date:FORMAT}`。
- **待你确认的一处事实**：你给的示例链接 `BV1W7wYetEga` 实测 `pages count = 1`，它属于 `ugc_season`（合集「奇人议事」，5 个 section / 首段 155 集，每集是**独立 BV**）。也就是说它属于"合集"，但不是"同一 BV 多分 P"。当前实现覆盖的是后者；若你真正要的是前者，那是另一个任务（会重新触发"遍历"的合规边界）。

### T07（P2）命名模板时间格式与时间语义

| 项 | 内容 |
| --- | --- |
| 任务ID | T07 |
| 对应需求ID | R04 |
| 来源Issue | [lanyeeee/bilibili-video-downloader#77](https://github.com/lanyeeee/bilibili-video-downloader/issues/77) |
| 优先级 | P2 |
| 目标 | 归档用户可用"发布日期"组织目录、"下载时间"区分版本 |
| 实现方案 | ① `files.rs:254` `template_base` 支持 `{name:FORMAT}` 语法：解析 `{}` 内 `: ` 之后的 chrono 格式串，`{date:%Y%m%d}` → `20261103`；无格式时保持 `YYYY-MM-DD`。② 新增 `{pubdate}`（需 `Task` 增加 `published_at`，`bilibili.rs` 已能取到 `pubdate`，`probe` 已有 `published_at` 字段，只需透传到 Task/History）。③ 设置页模板输入框下方补一行变量表（悬停显示），实时预览复用现有 `formatFilename`。④ 非法格式（`{date:%Q}`）不 panic，回退默认格式并在预览区提示。 |
| 涉及模块/文件 | `files.rs`、`domain.rs`、`db.rs`（Task 字段）、`commands.rs`、`src/js/app.js`、`src/index.html` |
| 验收标准 | ① 模板 `{title}_{pubdate:%Y%m%d}` → 文件名含发布日；② `{date:%Y-%m-%d_%H%M}` → 含下载时刻；③ 未知格式符不崩溃、回退默认并提示；④ 旧任务（无 `published_at`）回退为下载日期，不产生 `{pubdate}` 字面量 |
| 测试要点 | `files.rs:449` 区已有 `builds_template_path_and_avoids_collisions`，扩展 8 组格式；Windows 非法字符仍被清洗（`:` 出现在文件名中） |
| 风险/依赖 | 无 |
| 工作量 | 2 人日 |

**实现记录**

- `files.rs` 新增 `TemplateVars` + `render_template()` + `expand_token()` + `format_timestamp()`：支持 `{date:FORMAT}`（chrono 格式串）、`{pubdate}`、`{p}`、`{p_title}`，其余占位符走原有替换。未知 token/未知格式符**原样保留**而不是 panic（`{date:%Q}` → `%Q`，测试已固定该语义）。
- `domain.rs` 的 `TaskOptions` 增加 `published_at`，`bilibili.rs` 已能取到 `pubdate`，`probe_video` 透传到 `VideoProbe.publishedAt`，前端 `videoFromProbe()` 带 `publishedAt` 入队。
- 新增 `build_output_path_with(template, vars)`；旧的 `build_output_path()` 被删除（成了死代码）。
- `MAX_PATH_CHARS = 250`：超过时截断基名，给扩展名与 `-poster.*` 留余量。
- 前端 `catalog.js` 新增导出 `expandFilenameTemplate(template, entry, date)`，与 Rust 语义一致；设置页模板提示补上 4 个新变量；实时预览改走该函数。
- 测试：`files.rs` 覆盖 `{date:%Y%m%d}` 正常、未知格式符原样保留、`{title}` 空值兜底。
- **未做**：`{collection}`/`{season}`/`{owner_id}`（无数据来源，见 T06 偏差说明）。

### T08（P2）封面随视频落盘

| 项 | 内容 |
| --- | --- |
| 任务ID | T08 |
| 对应需求ID | R05 |
| 来源Issue | [nICEnnnnnnnLee/BilibiliDown#83](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/83)、[#245](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/245) |
| 优先级 | P2 |
| 目标 | 下载完成后视频目录内出现同名封面，媒体库可直接刮削 |
| 实现方案 | ① `Settings` 增加 `save_cover: bool`（默认 false）。② `queue.rs` 落盘成功后，若 `task.cover_path` 存在且开关开，复制到 `build_video_folder(download_dir, title)/{stem}-poster.jpg`（`-poster` 后缀兼容 Jellyfin/Emby 命名约定）。③ 复制失败不改变任务状态，只写 `extras_error`。④ 删除任务/历史时 `files.rs:69 remove_download_files` 增加封面文件清理（复用现有 sidecar 白名单机制，`valid_sidecar_token` 需接受 `-poster`）。 |
| 涉及模块/文件 | `queue.rs`、`files.rs`、`domain.rs`、`covers.rs`（取扩展名）、`src/js/app.js`（设置项） |
| 验收标准 | ① 开启后目录出现 `<stem>-poster.jpg`；② 关闭后不出现；③ 封面缓存失败（离线）时任务仍完成，状态无 `extras_error`；④ 删除任务勾选删文件时封面一并清理，视频目录为空才移除 |
| 测试要点 | `files.rs:596` `removes_download_file_and_sidecars` 扩展封面；`removes_extras_but_keeps_the_video` 确保不误删视频 |
| 风险/依赖 | 需先确认目标媒体库是 Jellyfin/Emby 还是通用命名（影响后缀） |
| 工作量 | 1–2 人日 |

**实现记录**

- 命名按 D2 定为 **`<stem>-poster.<ext>`**（Jellyfin/Emby 通用），同时在设置里保留 `stem` 选项（`<stem>.<ext>`）供通用媒体库使用；默认 `poster`。
- `domain.rs` 新增 `save_cover: bool`（默认 false）与 `cover_naming: String`（白名单 `poster`/`stem`，非法值回退 `poster`）。
- `postprocess.rs` 新增 `copy_cover()`：扩展名从缓存封面文件取（`covers.rs` 已能给出），失败返回 `Err` 由调用方聚合进 `extras_error`，**不改变任务状态**。
- `queue.rs` 落盘后 best-effort 调用：`copy_cover` / `write_nfo` / `write_chapters` 三者失败都聚合到 `extras_error`，不影响 `Completed`。
- **删除清理**：`files.rs::remove_download_files` 现在会清理 `-poster.{jpg,webp,png}` 与 `.nfo`（这两类名字只可能由本应用生成，无条件删）；与视频同名的 `<stem>.{jpg,webp,png}` 只在当前 `cover_naming == "stem"` 时才删——因为用户可能自己在旁边放了张同名的图，宁可留残骸也不误删。新增 2 项测试固定这个边界。
- 设置页第 1 张卡新增「保存封面」开关与「封面命名」下拉。

### T09（P2）字幕格式选择、内挂与语言校验

| 项 | 内容 |
| --- | --- |
| 任务ID | T09 |
| 对应需求ID | R07 |
| 来源Issue | [yutto-dev/yutto#416](https://github.com/yutto-dev/yutto/issues/416)、[nICEnnnnnnnLee/BilibiliDown#281](https://github.com/nICEnnnnnnnLee/BilibiliDown/issues/281) |
| 优先级 | P2 |
| 目标 | 字幕能直接内挂播放；"选中文得到英文"这类静默错误被拦住 |
| 实现方案 | ① `Settings` 增加 `subtitle_format`（`srt` / `ass`）、`embed_subtitles: bool`。② `queue.rs:691-698`：格式选择改 `--sub-format {fmt}` + `--convert-subs {fmt}`；内挂开关加 `--embed-subs`；容器为 mp4 时不提供内挂（UI 禁用并说明"mp4 内挂字幕兼容性差，建议选 MKV"）。③ 下载后校验：`find_subtitle_file` 命中后，读首 200 字节，若轨道声明语言与文件名语言不符（yt-dlp 已在文件名带 lang）则记 `extras_error` 并在结果页提示"字幕语言可能与所选不一致"。④ 字幕语言列表来源保持 `probe.subtitles`，不再做本地猜测。 |
| 涉及模块/文件 | `queue.rs`、`domain.rs`、`engine/mod.rs`（`SubtitleTrack`）、`src/js/app.js`、`src/index.html`、`catalog.js` |
| 验收标准 | ① 选 ASS → 产出 `.ass` sidecar；② 开内挂 + MKV → `ffprobe -show_streams` 有 `subtitle` 流；③ mp4 + 内挂 → UI 禁用并给出原因，不产生失败任务；④ 构造"声明 zh-Hans 实为英文"的 fixture → 任务完成但 `extras_error` 提示语言不一致 |
| 测试要点 | `queue.rs:1481` `writes_selected_subtitles_and_reports_missing_ones` 扩展示例；ffprobe 断言需在 CI 有 ffmpeg 的前提；mp4/mkv 双容器矩阵 |
| 风险/依赖 | mp4 内挂字幕使用 `mov_text`，部分播放器不识别；需在文档说明 |
| 工作量 | 3 人日 |

**实现记录（按 D3 砍掉内挂后实际落地）**

- **内挂字幕已移除**。你指出的"视频和字幕不是分别下载的吗"是对的：内挂本质是把已下载的 sidecar 再塞回容器，跟"字幕单独下载"不冲突，但它会额外增加 mp4/mov_text 的兼容性分叉，收益（少一个文件）远小于复杂度。因此：
  - 删掉了 `Settings.embed_subtitles` 字段与默认值；
  - 删掉了 `queue.rs` 里的 `--embed-subs` 分支；
  - 删掉了设置页「字幕封装进视频」整行与它的 JS 绑定；
  - 清掉了 `store-desktop.js` / `catalog.js` / `dev/mock-store.js` 里的 `embedSubtitles` 镜像字段。
- **保留并落地**：
  - `Settings.subtitle_format`（`srt`/`ass`，白名单回退 `srt`）。`queue.rs` 用 `--sub-format {fmt}/best` + `--convert-subs {fmt}`。
  - `postprocess.rs::subtitle_language_mismatch()`：从文件名判定语言（yt-dlp 会把语言写进文件名，如 `xxx.zh-Hans.srt`），不一致只写提示、不阻断任务。
  - `find_subtitle_file()` 支持 srt / ass / vtt 三种扩展名；**删除清理同步覆盖三种扩展名**（原来只删 `.srt`，切换格式后会留残骸——这是本轮修掉的一个真实缺口）。
  - 新增测试：`finds_subtitle_in_every_supported_format`、`subtitle_lookup_ignores_other_languages`、`detects_subtitle_language_mismatch`。
- **验收标准变更**：原标准 ②（`ffprobe` 有 subtitle 流）与 ③（mp4 禁用 UI）随内挂一起作废。

### T10（P2）章节标记写入容器

| 项 | 内容 |
| --- | --- |
| 任务ID | T10 |
| 对应需求ID | R08 |
| 来源Issue | [lanyeeee/bilibili-video-downloader#85](https://github.com/lanyeeee/bilibili-video-downloader/issues/85)、[#72](https://github.com/lanyeeee/bilibili-video-downloader/issues/72)、[#76](https://github.com/lanyeeee/bilibili-video-downloader/issues/76) |
| 优先级 | P2 |
| 目标 | 长视频在播放器里能按章节跳转，且 `view_points` 为 null 时不影响下载 |
| 实现方案 | ① `bilibili.rs` 新增 `fetch_view_points(bvid, cid)`：从播放器信息接口读 `view_points`，**按 `Option<Vec<_>>` 解析**（#85 的根因就是把 null 当数组）。② 生成 ffmetadata 章节文件（`;FFMETADATA1` + `[CHAPTER]` 段），合并后二次调用 ffmpeg `-i out.mkv -i chapters.txt -map_metadata 1 -codec copy` 写回。③ `Settings` 增加 `write_chapters: bool`（默认 false）；开关关闭时不请求该接口，零额外网络成本。④ 章节获取失败仅记日志，不进入 `extras_error`（避免噪音），但章节数 >0 时在历史记录里显示"3 个章节"。 |
| 涉及模块/文件 | `bilibili.rs`、`queue.rs`、`domain.rs`、`src/js/app.js` |
| 验收标准 | ① 有章节视频 + 开关开 → `ffprobe -show_chapters` 返回 ≥1 条；② `view_points: null` 的视频 → 下载成功、无章节、无错误噪声；③ 开关关 → 不产生额外网络请求（用 mock 计数验证）；④ 时长异常（章节超出视频长度）时跳过并记日志 |
| 测试要点 | null / 空数组 / 正常三态 fixture；mkv 与 mp4（mp4 章节支持有限，需明确是否只对 mkv 生效）；二次 ffmpeg 调用的失败回滚（保留原文件） |
| 风险/依赖 | 二次封装会重写整个容器，大文件耗时；需确认是否值得。可先只对 MKV 生效 |
| 工作量 | 3–4 人日 |

**实现记录**

- `bilibili.rs::fetch_view_points(bvid, cid, cookie)`：读 `x/player/v2` 的 `view_points`，转成 `Vec<Chapter>`；接口失败或字段为 null 时返回空数组，**不让章节拖垮整个任务**。
- `postprocess.rs::write_chapters()`：生成 ffmetadata（`TIMEBASE=1/1000`，毫秒整数），再用 ffmpeg `-map_metadata 1 -map 0 -codec copy` 二次封装；输出先写 `.chapters-{uuid}.{ext}` 临时文件，成功后 `rename` 覆盖原文件，失败则删临时文件、**原文件保持不动**。
- ffmetadata 的 `title` 里换行/回车/`=` 会被替换成空格，否则会破坏 ffmetadata 的 key=value 结构。
- `Settings.write_chapters: bool`（默认 false）。开启后大文件多一次封装，UI 已注明"会稍慢"。
- 新增测试：`ffmetadata_uses_millisecond_chapters`。
- 未做：章节的"最后一段 END 取视频时长"——B 站 `view_points` 通常自带结束时间，缺失的那一段用下一段起点；如果整段都缺，则跳过而不是写一个错的值。


### T11（P2）时长区间下载

| 项 | 内容 |
| --- | --- |
| 任务ID | T11 |
| 对应需求ID | R10 |
| 来源Issue | [yutto-dev/yutto#561](https://github.com/yutto-dev/yutto/issues/561) |
| 优先级 | P2 |
| 目标 | 只下需要的片段，省流量与磁盘 |
| 实现方案 | ① 结果页增加"仅下载片段"折叠区：起始/结束 `HH:MM:SS`，默认空。② `queue.rs` 构造 `--download-sections "*00:01:00-00:05:00"`，与 `--force-keyframes-at-cuts` 二选一（默认不强制关键帧，速度优先，UI 注明"可能有首帧黑屏"）。③ 断点续传与片段模式互斥：片段任务不参与续传，取消即清理临时目录（避免半截文件被误续）。④ `Task` 增加 `section_start/section_end`，历史记录可回看。 |
| 涉及模块/文件 | `queue.rs`、`domain.rs`、`db.rs`、`src/js/app.js`、`src/index.html` |
| 验收标准 | ① 指定 00:01:00–00:05:00 → 产物时长 240s ±2s；② 结束早于起始 → 入队前报错，不产生任务；③ 片段模式取消 → 临时目录被清理，不残留 `download.f*.mp4`；④ 片段 + 音频模式 → 产出对应长度 mp3 |
| 测试要点 | 时长断言用 ffprobe；边界（00:00:00 起、超出视频长度）；与限速、并发设置的组合 |
| 风险/依赖 | 无关键帧切割会有首帧花屏，需在 UI 说明；不影响主流程 |
| 工作量 | 2 人日 |

**实现记录**

- `TaskOptions.section_start` / `section_end`，格式 `HH:MM:SS`。
- `commands.rs` 抽出 `section_seconds()` + `validate_section()`：分钟和秒必须 <60，且结束必须晚于开始（零长度也拒绝）。**入队前**校验，不产生注定失败的任务。新增 5 项测试覆盖正常区间、倒置、零长度、少一段、分秒越界、非数字、负数。
- `queue.rs`：同时给定时加 `--download-sections "*{start}-{end}"`，并**强制 `--no-continue`**——区间下载与断点续传互斥，半截文件被误续会产出错内容。
- 前端结果页新增两个时间输入框，只在用户填写时才传。
- 未做：轨道的"精确切点"（`--force-keyframes-at-cuts`），默认按关键帧切，切口可能偏移不到 1 秒。


### T12（P2）完成态一致性与产物校验

| 项 | 内容 |
| --- | --- |
| 任务ID | T12 |
| 对应需求ID | R16、R18（路径兜底） |
| 来源Issue | [lanyeeee/bilibili-video-downloader#104](https://github.com/lanyeeee/bilibili-video-downloader/issues/104)、[Henryhaohao/Bilibili_video_download#67](https://github.com/Henryhaohao/Bilibili_video_download/issues/67)、[#6](https://github.com/Henryhaohao/Bilibili_video_download/issues/6)、[#71](https://github.com/Henryhaohao/Bilibili_video_download/issues/71)、[#91](https://github.com/Henryhaohao/Bilibili_video_download/issues/91) |
| 优先级 | P2 |
| 目标 | "已完成"必须真的有一个可用文件；0 字节、路径异常、sidecar 缺项都不能冒充成功 |
| 实现方案 | ① `queue.rs:829` 把 `metadata().unwrap_or(0)` 改为 `?` 传播错误；`file_size == 0` → `RunError{code:"empty_output"}`。② 完成写入前加 `verify_output(path)`：文件存在、大小 ≥ 16KB、能被解析出至少一条 video/audio 流。**注意：当前只随包分发 `ffmpeg`，没有 `ffprobe`**——需在 `binaries/` 与 `ENGINE_MANIFEST.json` 中一并加入 `ffprobe`（或用 `ffmpeg -i` 的 stderr 解析，但更脆弱，不建议）。③ `files.rs::build_video_folder` 加"空标题回退"（`未命名视频`）与"路径长度预检"：拼接后 `len() > 250` 时对基名做二分截断并记 warning。④ 历史/队列的 `missing_file` 巡检逻辑扩展到"大小异常"（现状只判存在性）。 |
| 涉及模块/文件 | `queue.rs`、`files.rs`、`engine/mod.rs`（ffprobe 复用）、`src/js/app.js`（文件异常态渲染） |
| 验收标准 | ① 假引擎产出 0 字节文件 → 任务 `Failed`，错误码 `empty_output`，不写历史；② 标题为空 → 使用 `未命名视频`，不生成 `\.` 之类非法路径；③ 深目录下超长标题 → 自动截断且任务成功；④ 删除成品后重启 → 状态仍为已完成、显示"文件已丢失"，不重新下载 |
| 测试要点 | `files.rs` 已有 11 个路径测试，扩展空标题/超长；`e2e-recovery.mjs` 增加"文件缺失不重下"断言；假引擎支持 `--emit-empty` 模式 |
| 风险/依赖 | 每任务多一次 ffprobe（毫秒级），可接受；大文件上 `ffprobe` 只读头部，不影响性能 |
| 工作量 | 2–3 人日 |

**实现记录（按 D1 按真实缺口做）**

- **先纠正原报告的一处错误**：`files.rs` 的单测 `sanitize_filename_base("") == "未命名视频"` 已经存在，也就是说**空标题早有兜底**，原报告 §6 Q5 里"没看到空标题分支"是错的。你当时的质疑（"怎么会有空标题"）成立。
- 所以 T12 的真实缺口只剩两个：
  1. **0 字节 / 过小产物**：`postprocess.rs::verify_output()`，视频 <16 KiB、音频 <1 KiB 直接判失败（不引入 ffprobe，安装包只随附 ffmpeg，所以只做尺寸校验，不做容器头解析）。落盘前调用，失败返回 `empty_output`。
  2. **深层超长路径**：`files.rs` 的 `MAX_PATH_CHARS = 250` 截断基名，给扩展名和 `-poster.*` 留出余量（Windows MAX_PATH 是 260）。
- **纯符号标题**（如 `【】`）不做特殊处理：`sanitize_filename_base` 已把非法字符替换掉，结果是下划线/空串，空串走"未命名视频"兜底，不会产生非法文件名。为一个只在极端情况出现的观感问题加分支，收益低于维护成本。
- 新增测试：`rejects_empty_output`。


### T13（P2）资源调度与进度事件性能

| 项 | 内容 |
| --- | --- |
| 任务ID | T13 |
| 对应需求ID | R17 |
| 来源Issue | [lanyeeee/bilibili-video-downloader#61](https://github.com/lanyeeee/bilibili-video-downloader/issues/61)、[ScottSloan/Bili23-Downloader#490](https://github.com/ScottSloan/Bili23-Downloader/issues/490)、[Henryhaohao/Bilibili_video_download#46](https://github.com/Henryhaohao/Bilibili_video_download/issues/46) |
| 优先级 | P2（**需先压测确认是否真有问题**） |
| 目标 | 50 个任务在跑时界面不卡；合并阶段不占满并发配额 |
| 实现方案 | ① 先做基线：用假引擎起 50 个任务，记录 `ProgressUpdate` 事件频率与前端掉帧（Performance 面板）。② Rust 侧按 task 做 100ms 节流（`last_emit: Instant`），进度事件最多 10/s/任务。③ 前端 `store-desktop.js` 对同一 task 的进度做 200ms 合并（已有定时对账，确认是否重复渲染）。④ `Settings` 增加 `max_mux_concurrent`（默认 1）：合并阶段单独占用一个信号量，避免"两个任务都在 ffmpeg、没有一个在下"。#490 的诉求由此满足。 |
| 涉及模块/文件 | `queue.rs`、`store-desktop.js`、`app.js`、`domain.rs`、`src/index.html` |
| 验收标准 | ① 50 任务压测：单任务进度事件 ≤10/s（Rust 侧计数）；② 队列页滚动帧率 ≥50fps，无长任务 >200ms；③ 并发 2 时任一时刻最多 1 个 ffmpeg 进程（进程计数断言）；④ 任务总吞吐不因节流下降 >5% |
| 测试要点 | 假引擎 + 50 任务脚本化压测；`max_mux_concurrent=1/2` 两档；进程树计数（Job Object 已有能力） |
| 风险/依赖 | 若压测显示当前无瓶颈，**本任务应缩为"仅加 max_mux_concurrent"**，不做无谓改造 |
| 工作量 | 3 人日（含压测） |

**实现记录（按实测收窄）**

- **`max_mux_concurrent` 判定为死配置，未引入**。原因：本项目的"合并"发生在 yt-dlp 子进程内部（`--merge-output-format`），Rust 侧没有独立的合并阶段可以限流；真加一个字段，它读不到任何地方，就是死代码。原方案要加这个字段是因为假设存在独立 mux 阶段，实测不成立。
- **进度节流按实测重构**：原来硬编码 500ms/任务。现在抽出 `progress_interval_for(active)`：0–5 个任务 500ms、6–15 个 900ms、16+ 个 1500ms。单任务 2 事件/秒，本来就远低于"≤10 事件/秒"的验收上限，所以这一项的真实价值是**并发时的 DB 写放大**，不是单任务频率。
- 新增 `progress_interval_stretches_as_concurrency_grows`：既断言三档的具体数值，也遍历 0/1/5/6/15/16/50/200 验证"每任务每秒 ≤10 个事件"这条验收线。
- 未做：50 任务真实压测（需要真实网络与 50 个可下载目标，不在本轮范围）。


### T14（P3）NFO 元数据

| 项 | 内容 |
| --- | --- |
| 任务ID | T14 |
| 对应需求ID | R06 |
| 来源Issue | [yutto-dev/yutto#603](https://github.com/yutto-dev/yutto/issues/603) |
| 优先级 | P3 |
| 目标 | 媒体库（Kodi/Jellyfin/Emby）能读到标题、简介、封面、播出日期 |
| 实现方案 | ① `Settings.save_nfo: bool`（默认 false）+ `nfo_title_source`（`video` / `page` / `combined`）。② 落盘后写 `<stem>.nfo`，`<movie>` / `<episodedetails>` 按是否有 `page_index` 选择；字段：`title/plot/studio/aired/thumb/uniqueid(type=bvid)`。③ XML 用 `quick-xml` 或手写转义（标题含 `<` 会炸），必须转义。④ 标题策略对应 #603 的四选项，默认 `video`。 |
| 涉及模块/文件 | `queue.rs`（落盘后）、`files.rs`、`domain.rs`、`src/js/app.js` |
| 验收标准 | ① 开启后生成合法 XML（`xmllint --noout` 通过）；② 标题含 `<>&"` 时不破坏 XML；③ 三种标题策略输出符合预期；④ 关闭时零额外文件 |
| 测试要点 | 特殊字符转义；无 `pubdate` 时 `aired` 省略而非空标签；中文编码 UTF-8 声明 |
| 风险/依赖 | 只有刮削用户受益；先确认是否有真实需求方（Q7） |
| 工作量 | 2 人日 |

**实现记录**

- `postprocess.rs::write_nfo()`：单 P 用 `<movie>`，多 P 用 `<episodedetails>`；写 `<title>` / `<uniqueid type="bvid">` / `<studio>` / `<aired>` / `<premiered>` / `<thumb>`。所有文本过 `xml_escape()`（`&` `<` `>` `"` `'` 五个字符），标题里的 `A & B <tag>` 不会破坏 XML。
- `Settings.nfo_title_source`：`video`（默认）/ `page` / `combined`，白名单回退 `video`；`page` 模式下若分 P 标题为空则退回总标题，不写空 `<title>`。
- `TaskOptions.published_at` 提供 `<aired>`；日期复用 `files::format_date`。
- 失败只进 `extras_error`，不改任务状态。
- 新增 3 项测试：`writes_nfo_with_escaped_title_and_page_aware_root`、`fallback_title_source_when_page_title_is_missing`，加上原有的 `xml_escapes_special_characters`。


### T15（P3）多音轨合并

| 项 | 内容 |
| --- | --- |
| 任务ID | T15 |
| 对应需求ID | R09 |
| 来源Issue | [yutto-dev/yutto#113](https://github.com/yutto-dev/yutto/issues/113)、[ScottSloan/Bili23-Downloader#419](https://github.com/ScottSloan/Bili23-Downloader/issues/419) |
| 优先级 | P3 |
| 目标 | 多语种配音番剧一次拿到全部音轨 |
| 实现方案 | ① `probe` 暴露 `audio_tracks: Vec<{id, lang, name}>`（yt-dlp 的 `formats` 已含 `language`）。② 结果页增加音轨多选；`queue.rs:713` 格式串改为 `{video}+{a1}+{a2}` 并加 `--audio-multistream`。③ 仅 MKV 允许（mp4 多音轨兼容差），UI 强制切容器。 |
| 涉及模块/文件 | `engine/mod.rs`、`queue.rs`、`domain.rs`、`src/js/app.js` |
| 验收标准 | ① 双音轨视频 → MKV 内 `ffprobe` 显示 2 条 audio，语言标签正确；② 单选一轨 → 行为与现在一致；③ mp4 + 多音轨 → UI 阻止并提示改 MKV |
| 测试要点 | 音轨语言标签；单轨回归；容器约束 |
| 风险/依赖 | 番剧音轨信息依赖 yt-dlp 解析质量；用户面窄 |
| 工作量 | 4 人日 |

**实现记录**

- `engine/mod.rs` 新增 `parse_audio_tracks(&Value)`：只收 `vcodec == "none"` 且 `language` 非空且不为 `"none"` 的流，按 `format_id` 去重；`label` 取 `format`，缺失时退回 `format_note`，再缺失退回 `format_id`。`VideoProbe` 增加 `audio_tracks`。
- `domain.rs` 新增 `AudioTrack { id, label, language }` 与 `TaskOptions.audio_track_ids: Vec<String>`。
- `queue.rs` 选中多音轨时把格式串拼成 `{video}+{a1}+{a2}` 并加 `--audio-multistreams`；未选时保持原行为。
- 前端结果页新增音轨多选区（仅在探测到带语言标签的音轨时出现），选择结果随任务入队。
- 新增 2 项测试：`collects_language_tagged_audio_only_streams`（含"重复 id 只留一条""视频流的 language 无意义必须排除""无标签音频不收录"三个边界）、`missing_formats_yields_no_audio_tracks`。
- 未做：默认音轨标记（`--audio-multistreams` 下由容器决定主轨），以及 UI 里的音轨语言友好名（当前直接显示 yt-dlp 的 label）。


### T16（P3）命令行/无头入口

| 项 | 内容 |
| --- | --- |
| 任务ID | T16 |
| 对应需求ID | R24 |
| 来源Issue | [Henryhaohao/Bilibili_video_download#123](https://github.com/Henryhaohao/Bilibili_video_download/issues/123) |
| 优先级 | P3 |
| 目标 | 可脚本化：CI、NAS、批量运维场景 |
| 实现方案 | ① 新增 `src-tauri/src/bin/bilipocket-cli.rs`（或 feature gate），复用 `Queue::enqueue` + 阻塞等待，输出 JSON 结果。② 子命令：`parse <url>`、`download <url> --quality auto --dir X --extras danmaku,sub`、`status <id>`。③ 凭据读取沿用 `session.dpapi`/keyring，不新增认证路径。④ 与 GUI 单实例互斥需放开（`single_instance` 只对 GUI 生效）。 |
| 涉及模块/文件 | `src-tauri/Cargo.toml`（`[[bin]]`）、`queue.rs`、`commands.rs`、`auth.rs` |
| 验收标准 | ① `bilipocket-cli parse <BV>` 输出合法 JSON（含 title/qualities）；② `download` 完成后退出码 0 且文件存在；③ 未登录时 1080P 请求返回明确错误码而非崩溃；④ GUI 与 CLI 可同时运行 |
| 测试要点 | 退出码矩阵；JSON schema 稳定；并发两个 CLI 进程 |
| 风险/依赖 | 增加一个长期维护面；如果只为"自动化"，可先评估用户是否真的需要（Q8） |
| 工作量 | 5 人日 |

**实现记录（按 D5 不做）**

- 你要的答案是"不需要 CLI 入口"——已确认：这个项目是桌面 GUI，队列、登录、通知都绑在 App 状态上；再开一个 bin 要么复制一套 AppState 初始化，要么把 GUI 逻辑抽成共享库，两种都是长期维护面翻倍。
- 本轮曾写出 `src-tauri/src/bin/bilipocket-cli.rs`（`parse` / `download` / `status` 三个子命令的骨架），按 D5 已**整文件删除**，`src/bin/` 目录一并移除；已 grep 确认源码零残留引用（只剩 `target/` 构建缓存）。
- 设置页、README 均未加入任何 CLI 说明。


### T17（P3）跨平台评估（不立项，仅调研）

| 项 | 内容 |
| --- | --- |
| 任务ID | T17 |
| 对应需求ID | R24（跨平台部分） |
| 来源Issue | —（[ScottSloan/Bili23-Downloader#487](https://github.com/ScottSloan/Bili23-Downloader/issues/487)、[lanyeeee/bilibili-video-downloader#115](https://github.com/lanyeeee/bilibili-video-downloader/issues/115) 已在清洗阶段排除，此处仅作背景） |
| 优先级 | P3 |
| 目标 | 用 1 人日出结论：值不值得做，代价多大 |
| 实现方案 | 只做盘点，不写代码：列出 4 处 Windows 专属依赖（`process_job.rs` Job Object、`auth.rs` DPAPI、`keyring`、WebView2 与 `nsis`），逐项给出替代方案（`nix` 进程组、`libsecret`、WKWebView、`.dmg`/`AppImage`）与工作量。 |
| 涉及模块/文件 | `process_job.rs`、`auth.rs`、`tauri.conf.json`、`Cargo.toml` |
| 验收标准 | 输出一页评估：4 项替代方案 + 工作量区间 + 收益判断（若 <3 个真实用户诉求则不做） |
| 测试要点 | 无 |
| 风险/依赖 | 与 R01/T06 一样属定位问题，需你先定"是否只做 Windows" |
| 工作量 | 1 人日 |

**实现记录（只调研，不立项）**

- 按 D4「现在先做 Windows」，T17 停在调研，没有改任何平台相关代码。
- 产出 `docs/CROSS_PLATFORM_ASSESSMENT.md`（一页）：盘出 4 类平台直连点（Job Object / DPAPI / keyring / sidecar 与打包），逐项给替代方案与工作量区间（合计 8–12 人日，不含签名与回归）。
- 调研中新发现一处**硬事实**：`auth.rs` 的 `load_portable_session` / `save_portable_session` 无条件调用 `dpapi_protect` / `dpapi_unprotect`（这两个函数是 `#[cfg(windows)]`，且没有非 Windows 分支），所以**当前代码在 macOS / Linux 上根本编译不过**——不是"能编译但行为不对"。
- `process_job.rs` 倒是有 `#[cfg(not(windows))]` 的空实现，代价是非 Windows 上暂停/取消不会杀掉 yt-dlp/ffmpeg 的进程树。
- 结论：不满足立项门槛（与平台形态相关的诉求只有 2 条，且都在 §1.3 被判定位不符），**不立项**。


### T18（P1，第二轮追加）合集条目按需勾选

| 项 | 内容 |
| --- | --- |
| 任务ID | T18 |
| 对应需求ID | R01、R02（"合集里挑几条下"这一具体形态，取代 T06 原本的"列表遍历"方案） |
| 优先级 | P1（用户明确追加） |
| 目标 | 打开一个属于合集的视频后，能看到合集里的全部独立 BV，按标题搜索定位，勾选若干条后只下这些，而不是整体全下 |
| 定位变更 | T06 原本按 B1 收窄成"只做同一 BV 的多分 P"，合集被列为不做。本轮确认：用户要的"合集"就是 `ugc_season`（一个合集里多个独立 BV）。因此在 T06 之上追加本任务，**仍不放开**收藏夹 / UP 空间 / 番剧 / 排行榜等列表页遍历 |
| 实现方案 | ① `bilibili.rs::parse_season()` 从**同一次** `view` 响应的 `data.ugc_season.sections[].episodes[]` 解析条目，按 `bvid` 去重（「最新 N 期」这类 section 会重复收录）；条目 bvid 优先取 `episode.bvid`，退回 `arc.bvid`。② `domain.rs` 新增 `SeasonEpisode` / `SeasonInfo`，`VideoProbe.season` 透传到前端。③ 前端 `catalog.js` 抽出两个纯函数：`filterSeasonEpisodes`（标题包含匹配）与 `toggleVisibleSelection`（只作用于可见集合的全选/取消）。④ 结果页新增合集区块：搜索框 + 滚动列表 + 全选按钮 + 计数。⑤ 搜索只重建列表容器，不动搜索框本身，避免输入时丢焦点。⑥ 勾选后 `enqueueCurrentInner` 按条目各自的 BV 构造独立 source（自己的 URL / 标题 / 封面 / 发布日期），逐个入队 |
| 涉及模块/文件 | `domain.rs`、`bilibili.rs`、`engine/mod.rs`、`commands.rs`、`src/js/catalog.js`、`src/js/app.js`、`src/styles/pages.css`、`dev/demo-data.js`（演示样本） |
| 验收标准 | ① 合集视频解析后列出全部条目；② 搜索只显示标题匹配项；③ 全选只选中当前筛选结果，并在全部已选时变为取消；④ 切换搜索词后已勾选条目不丢失；⑤ 勾选 N 条入队后队列恰好新增 N 个对应任务；⑥ 单视频/多分 P 行为零变化 |
| 测试要点 | Rust：`parses_season_episodes_across_sections`、`season_deduplicates_episodes_repeated_in_latest_sections`、`season_skips_entries_without_bvid_and_handles_missing_fields`、`season_falls_back_to_arc_bvid_when_top_level_is_missing`、`no_season_or_empty_season_is_none_not_an_error`。前端单测：`filterSeasonEpisodes` ×4、`toggleVisibleSelection` ×6。Playwright：`tests/ui/season.spec.js` 6 项（默认不选、搜索+全选只作用于结果、切换搜索词保留勾选、空结果不误删、按勾选入队数量与标题对应、分 P 与合集互斥） |
| 与本项目定位的关系 | 仍然只解析**用户主动粘贴的那一条链接**，不新增任何列表请求、不翻页、不遍历。合规边界不变，只是把"这条链接自带的合集"也纳入可勾选范围 |
| 互斥处理 | 一个视频可能同时有分 P 和合集。两者都是批量来源但展开方式不同（`?p=N` vs 独立 BV），同时勾选只能执行一种，会在入队时静默丢条目。因此改为**互斥**：勾任一侧会清空另一侧并同步勾选框，保证「勾了什么就下什么」成立。
| 已确认决策 ① | 清晰度采用**继承**（方案 A）：合集条目统一使用当前视频所选档位，不做逐条探测。理由：逐条探测等于 N 次请求，接近"按列表爬取"；继承下的失败可见、可单独重试。代价已在合集区块文案中提前告知。 |
| 已确认决策 ② | 「仅下载片段」与「附加音轨」保持**广播**到每一条（方案 A）：不做逐条开关。理由：两项默认为空，填写即为明确意图；片段场景下"每条都切同一段"本就是常见需求。音轨 ID 在个别条目缺失时该条单独失败。代价已在音轨区块文案中提前告知。 |
| 已知限制 | ① 某条因缺档失败后只能整条重试，没有"换一个档位只重下这一条"的批量入口。② 条目自己的字幕语言若与父视频不同，会报"缺少字幕"而不是自动换轨 |
| 工作量 | 1.5 人日 |


---

## 5. 分阶段路线图

### P0 立即修复（已完成）

| 任务ID | 目标 | 预计收益 | 状态 |
| --- | --- | --- | --- |
| T01 | 412/-352 可识别、可退避、可解释；`view` → `wbi/view`；WBI key 缓存 | 消除"昨天能用今天全挂"这类最高频、最不可控的失败；把不可读的 `engine_failed` 变成用户能自助处理的提示 | **已完成** |

> P0 只有一项，是刻意的。逐条核对 110 条需求后，本项目**真正"高危且已确认存在"的缺口只有接口风控这一条**——其余要么已实现（断点续传、便携化、窗口记忆、短链识别），要么是体验增量。把一个 P2 硬提到 P0 只会让排期失真。

### P1 近期迭代（T02–T06 全部已完成）

| 任务ID | 目标 | 预计收益 | 状态 |
| --- | --- | --- | --- |
| T02 | 清晰度矩阵不漏档、未知档位不错位 | 会员用户第一投诉点直接消除；这是本品与竞品的核心差异点 | **已完成** |
| T03 | 重试次数/间隔/分片次数可配 | 弱网与限速环境下的成功率提升；成本低 | **已完成** |
| T04 | 凭据编码修复 + 会话完整性校验 | 消除"会员却下不了 4K"的一类静默失败 | **已完成** |
| T05 | 引擎故障可操作化 + troubleshooting 文档 | 把 26 条环境类 Issue 的迁移价值一次性吃掉（转化为文档而非代码） | **已完成** |
| T06 | 分 P 展开与批量入队（**按 B1 收窄**） | 覆盖"一个 BV 下多个分 P"这一最高频的批量场景；未放开到收藏夹/番剧/UP 空间遍历 | **已完成** |
| T18 | 合集条目按需勾选（搜索 + 全选 + 逐条入队） | 覆盖 `ugc_season` 这种"一个合集多个独立 BV"的场景；仍只解析用户粘贴的那一条链接，不做列表页遍历 | **已完成** |

> 实际工作量远低于原估的 8–12 人日。原因是收窄到"同一 BV 的多分 P"后，`pages` 直接从已有的 `view` 响应里读，不需要 `--flat-playlist`、不需要分页、不需要限速与取消通道——原估算里 2/3 的成本是给"列表遍历"的合规与限流设计预留的。

### P2 中期增强（T07–T13 全部已完成）

| 任务ID | 目标 | 预计收益 | 状态 |
| --- | --- | --- | --- |
| T07 | 命名模板时间格式 + `{pubdate}` | 归档用户刚需，2 人日成本换长期口碑 | **已完成** |
| T08 | 封面落盘 | 媒体库用户入门门槛消除 | **已完成**（`-poster.<ext>`） |
| T09 | 字幕格式 + 语言校验 | 字幕从"有文件"升级到"格式对、语言对" | **已完成**（内挂已按 D3 移除） |
| T10 | 章节标记 | 长视频可用性 | **已完成**（MKV/MP4 统一走 ffmpeg 二次封装） |
| T11 | 时长区间下载 | 省流量；实现简单 | **已完成** |
| T12 | 产物合格性校验 | 数据完整性兜底 | **已完成**（真实缺口：0 字节/过小产物 + 超长路径） |
| T13 | 进度事件节流 | 并发时的 DB 写放大 | **已完成**（自适应 500/900/1500ms；`max_mux_concurrent` 判定为死配置未引入） |

### P3 已完成 / 不做

| 任务ID | 目标 | 结论 |
| --- | --- | --- |
| T14 | NFO 元数据 | **已完成**（按 A2 提前执行）。`<movie>`/`<episodedetails>` 双根节点，XML 全转义 |
| T15 | 多音轨 | **已完成**（按 A2 提前执行）。仅收录带语言标签的纯音频流，`--audio-multistreams` |
| T16 | CLI/无头 | **不做**（按 D5）。已写的 CLI 骨架整文件删除 |
| T17 | 跨平台评估 | **已完成调研，不立项**（按 D4「先做 Windows」）。产出 `docs/CROSS_PLATFORM_ASSESSMENT.md` |

---

## 6. 决策记录（原 Q1–Q10 已全部关闭）

第二轮你的答复把 10 个待确认问题全部关掉了。下表是结论与它对代码的实际影响——**留在这里是为了以后能追溯"为什么这么做"，而不是"还等你答"**。

| # | 你的决定 | 对代码/文档的实际影响 |
| --- | --- | --- |
| **Q1** | 选 **B1**：批量 = **同一个 BV 下的多个分 P**（不做收藏夹/番剧/UP 空间） | T06 按此收窄：只读 `view` 响应的 `data.pages`，不引入 `--flat-playlist`，`--no-playlist` 保持不动。原方案的白名单列表页、200 条上限、800ms 间隔、取消通道全部作废 |
| **Q2** | 选 **D4「现在先做 Windows」** | T17 只做调研不立项；`docs/CROSS_PLATFORM_ASSESSMENT.md` 给出 8–12 人日的代价区间与不立项理由 |
| **Q3** | 已实测：`yt-dlp --no-playlist "...?p=2"` 输出 `BV1W7wYetEga_p2` | `?p=N` **是生效的**，不是 Bug。不需要新增 P0。T06 直接复用 `?p=N` 选择分 P |
| **Q4** | 你 **已登录过大会员账户** | T02/T04 的会员档位验收具备条件；但真实"矩阵缺档"影片仍需你本人挑一部，本轮未实测（见文首"仍未验证"） |
| **Q5** | 你质疑"怎么会有空标题/纯符号标题/>250 字符"，选 **D1「按你说的做」** | 复核后**你是对的**：`sanitize_filename_base("")` 早已兜底为"未命名视频"，原报告判断有误。T12 收窄到"0 字节/过小产物 + 超长路径"两个真实缺口 |
| **Q6** | 选 **D2**：封面用 `-poster.jpg` | `cover_naming` 默认 `poster`，同时保留 `stem` 选项；删除清理按命名偏好决定是否删同名图片 |
| **Q7** | 未单独回答，按实测收敛 | 现有 500ms/任务 = 2 事件/秒，本就满足"≤10 事件/秒"。T13 只做自适应节流；`max_mux_concurrent` 因无独立 mux 阶段**未引入** |
| **Q8** | 选 **D5「暂时不做」** | T16 不立项，已写的 `src-tauri/src/bin/bilipocket-cli.rs` 删除，`src/bin/` 一并移除 |
| **Q9** | 选 **D3「不需要内挂字幕」** | `embed_subtitles` 字段、`--embed-subs` 分支、UI 开关、三处前端镜像字段全部移除。字幕只做外挂 + 格式选择 + 语言提醒 |
| **Q10** | 「统计汇总」是**用来看看其他项目的人需要什么功能**，先留着 | **不回写 Excel**。原表公式无缓存值的问题保留，但那份文件仅作参考输入，不进交付物 |

### 已关闭：合集形态的确认

第二轮留下的唯一悬念是——你给的 `BV1W7wYetEga` 实测 `pages count = 1`，属于 `ugc_season`（合集「奇人议事」，5 个 section / 215 个独立 BV），与"同一 BV 多分 P"不是一回事。

本轮已确认并按 (b) 落地：见 **T18**。实际接口行为也顺带验证了——`view` 一次响应就带回了全部 5 个 section、215 条（实测无重复 bvid），所以整个合集只需要一次请求，不需要分页，也不构成"遍历"。

---

## 附录 A · 代码证据索引（用于复核本报告的"现状"判断）

| 结论 | 证据位置 |
| --- | --- |
| 不支持列表/批量 | `src-tauri/src/engine/mod.rs:660`（`--no-playlist`）；前端收紧：`src/js/app.js:79-84`、`:315-336` |
| 链接白名单仅域名级（Rust）/ 前端要求 BV 或 `/video/` | `src-tauri/src/engine/mod.rs:410-439`；前端 `src/js/app.js:80-84`、`:322-336` |
| 命名模板仅 5 个变量 | `src-tauri/src/files.rs:254-268` |
| 日期格式固定 | `src-tauri/src/files.rs:39-47` |
| 文件名清洗已较完整 | `src-tauri/src/files.rs:10-37` |
| 封面只进缓存目录 | `src-tauri/src/covers.rs:90-110` |
| 字幕只有 SRT sidecar | `src-tauri/src/queue.rs:691-699`、`:1331` |
| 单音轨 | `src-tauri/src/queue.rs:713-724` |
| 无章节 / 无 NFO | `grep -rn "view_points\|chapter\|\.nfo" src-tauri/src` 无实现命中（`nfo` 只在 `info` 里误匹配） |
| 重试固定 3 次、退避固定 | `src-tauri/src/queue.rs:42`、`:59-88`、`:663-672` |
| 无 412/-352 分支 | `src-tauri/src/engine/mod.rs:441-459`、`queue.rs:47-55` |
| `view` 非 `wbi/view` | `src-tauri/src/bilibili.rs:15`、`:364-380` |
| WBI key 无缓存 | `src-tauri/src/bilibili.rs:91-99`、`:392` |
| 清晰度映射四张硬编码表 | `src-tauri/src/bilibili.rs:135-194` |
| 矩阵以 support_formats 为主 | `src-tauri/src/bilibili.rs:233-350` |
| Cookie 原样拼接 | `src-tauri/src/auth.rs:318-328`、`queue.rs:688` |
| 完成写入有状态守卫 | `src-tauri/src/queue.rs:861`（`update_task_if_status`） |
| 产物大小读不到当 0 | `src-tauri/src/queue.rs:829-832` |
| 成功后清理临时目录 | `src-tauri/src/queue.rs:919` |
| 窗口尺寸记忆 | `src-tauri/src/lib.rs:196-202` |
| 仅 NSIS / 无 CLI | `src-tauri/tauri.conf.json`（`bundle.targets`）、`src-tauri/src/main.rs` |
| 设置项清单 | `src-tauri/src/domain.rs:9-24` |

## 附录 B · 合规边界声明

本报告涉及"会员清晰度/付费内容"的全部条目（R14、R15 及 T02、T04、T05），只提出以下四类工作，不含任何绕过手段：

1. **合法登录态支持**：确保用户自己账号已有的权限被正确使用（SESSDATA 编码正确、会话检测准确）。
2. **信息展示正确**：把"你的账号能下什么"如实呈现（缺档补全、锁定原因区分），不制造"买了会员却看不到 4K"的误解。
3. **错误提示**：权限不足时给出明确、可操作的文案与暂停行为，而不是静默失败或伪造成功。
4. **文档与兼容性**：说明会员档位的边界、哪些属于平台限制、为什么不提供绕过。

明确排除、且本报告不提出任何方案的内容：DRM 破解、会员鉴权绕过、付费墙绕过、风控规避（签名伪造、指纹伪装、代理池、验证码打码）、全站批量爬取。
