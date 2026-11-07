# 贡献指南

感谢你愿意参与。这个项目不大，规则也尽量少。提交之前花两分钟读完下面几节，能省掉来回沟通。

## 环境准备

```bash
npm install
npm run dev:web     # 浏览器演示入口，改界面时最快
npm run dev         # 桌面应用（验证窗口、通知、托盘、真实下载）
```

需要 Node.js 18+、Rust stable（Windows 用 MSVC toolchain）。打包还需要 MSVC Build Tools 与 WebView2 Runtime。

**打包与桌面 E2E 的前置条件**：`npm run build`、`package:portable`、`test:desktop*`、`verify:sidecars`、`verify:release` 都依赖 `src-tauri/binaries/` 下两个不入库的 sidecar exe。首次克隆需按 `src-tauri/binaries/ENGINE_MANIFEST.json` 自行放置，并用 `npm run verify:sidecars` 校验 SHA-256；未放置时这些命令会失败，CI 上对应步骤会自动跳过。清单只有来源首页与哈希，没有下载直链。详见 README「打包」与「待确认事项」T4。

## 提交前必须通过

```bash
npm run typecheck
npm run test:unit
npm run test:ui
cd src-tauri && cargo test --lib && cargo clippy --lib --tests
```

五项全绿再提 PR。任何一项变红，说明改动越界了，先修再提。

## 代码约定

**前端没有构建步骤。** `src/` 由 Tauri 直接加载，浏览器也能直接跑 ESM。不要引入打包器、框架或需要编译的语法——`jsconfig.json` 的 `include` 是显式白名单，新增文件必须加进去，否则类型检查会静默跳过。

**模块边界按依赖方向切。** 纯渲染（无状态）在底层，视图依赖它，外壳依赖视图。模块之间允许循环导入，因为函数声明在实例化阶段就已就绪、调用都发生在加载之后；但不要用循环导入传递可变状态。

**状态只有一份。** 跨模块共享的状态放在 `src/js/app/parse-store.js`，整体替换走 `setXxx()`，不要给导入的绑定直接赋值（ESM 语法层面禁止）。对象内部的属性读写不受此限。

**设置项只有一个来源。** 新增设置字段改 `src/js/settings-schema.js` 一处即可，Rust 侧对应改 `domain.rs`；`tests/unit/settings-schema.test.mjs` 会校验两边字段集一致。

**后端先校验再执行。** 来自前端的数据一律在 `commands.rs` 入口做形状校验（参考 `TaskOptions::validate`），不要把脏值留给 yt-dlp 或文件系统去报错。

**碰文件路径的地方要过围栏。** 任何由用户输入拼接出的路径，必须走 `files.rs` 里的清洗与 `canonicalize` + `starts_with(root)` 校验。

## 提交信息

用 `<type>(<scope>): <subject>` 的形式，一行说清做了什么：

```text
fix(queue): 重试计数在恢复任务时被重置
feat(season): 合集条目支持按标题筛选后全选
docs: 补充 sidecar 校验步骤
```

正文里写「为什么」，不要复述 diff。

## PR

- 一个 PR 做一件事；重构和功能改动分开发
- 描述里写清验证方式（跑了哪些测试、有没有手动验证）
- 涉及界面的改动附截图；涉及下载行为的改动说明怎么复现
- 不要顺手改无关文件的格式

## 报告问题

提 issue 时请附上：

- 应用版本（设置页「关于」）、Windows 版本
- 复现步骤与期望结果
- 设置页导出的脱敏诊断包（不含 Cookie、账号标识与下载目录）

涉及下载失败时，`docs/TROUBLESHOOTING.md` 列出了常见原因，先对照一遍能省不少时间。

## 许可

提交的代码会以 [MIT](LICENSE) 发布。
