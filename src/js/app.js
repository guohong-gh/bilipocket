// @ts-check



import { store } from "./runtime.js";
import { isDesktop } from "./bridge.js";
import { $, confirmModal, } from "./ui.js";
import * as desktop from "./tauri.js";
import { navigate, renderRoute } from "./app/router.js";
import { startTicker, updateSidebar } from "./app/chrome.js";
import { syncWindowMaximized } from "./app/shell.js";
import { renderRecent } from "./app/home-view.js";
import {
  consumeFirstRunLoginRequest,
  ensureDesktopPreferredQuality,
  hideAuthPanel,
  renderAuth,
  setFirstRunLoginRequested,
} from "./app/auth.js";
import { applyTheme } from "./app/theme.js";
import {
  closeWindow,
  isTauri,
  onWindowResized,
  pickDirectory,
  setMinimizeToTray,
} from "./tauri.js";
import { logoutAuth, refreshAuthStatus, startAuthLogin } from "./app/auth.js";

// @ts-check













if (!store) {
  document.body.innerHTML =
    '<main class="boot-fallback">' +
    "<h1>这是桌面版页面</h1>" +
    "<p>浏览器预览请打开 <code>http://localhost:1420/dev/</code>（先运行 <code>npm run dev:web</code>）。</p>" +
    "</main>";
  throw new Error("BiliPocket demo store is not available on this entry");
}



/* ---------- Parse flow ---------- */

// 把合集条目变成一个可入队的 source：它有自己的 BV / 标题 / 封面 / 发布日期。
// 分 P 与合集元信息都不继承，避免把当前视频的信息带到别的条目上；
// 封面路径置空，等任务真正开始时由队列按该条目自己的封面重新缓存。
// 分 P 与合集是两种互斥的批量来源：一个按 ?p=N 展开同一个 BV，
// 另一个按独立 BV 展开。同时勾选时只能选一种，否则会有条目被静默丢掉，
// 所以在切到另一侧时清空并同步勾选框，让「勾了什么就下什么」保持成立。
// 只刷新计数与全选按钮文案；不动列表 DOM，避免打乱滚动位置与正在输入的搜索框。
// 搜索或全选之后重建列表：只替换列表容器与其摘要，搜索框本身保留焦点。
/* ---------- Init ---------- */

try {
  await store.init();
} catch (error) {
  console.error("[BiliPocket] 无法初始化本地后端", error);
}

const migrationNotice = isDesktop ? store.migratePrototypeSettings?.() : null;
if (migrationNotice) {
  await confirmModal({
    title: "已迁移桌面设置",
    message:
      "主题、下载目录、并发、限速与命名模板已带入桌面版。演示队列与历史是虚构数据，不会变成真实任务，也不会写入数据库。",
    target: `旧演示数据 ${migrationNotice.queue} 个任务 / ${migrationNotice.history} 条历史已归档保留。`,
    confirmText: "知道了",
    cancelText: "关闭",
    tone: "info",
    iconName: "database",
  });
}

$("#auth-login")?.addEventListener("click", () => { void startAuthLogin(); });
$("#auth-logout")?.addEventListener("click", () => { void logoutAuth(); });
$("#auth-cancel")?.addEventListener("click", hideAuthPanel);

if (isDesktop) {
  document.documentElement.dataset.runtime = "desktop";
  ensureDesktopPreferredQuality();
  renderAuth(store.authInfo);
}

applyTheme(store.getState().settings.theme);

if (isDesktop && !store.getState().settings.authorizedAccepted) {
  const accepted = await confirmModal({
    title: "使用前确认",
    message:
      "BiliPocket 仅用于下载你拥有版权或已获授权的内容。登录只用于访问你自己账号已有权限的清晰度与字幕；不包含会员/付费内容绕过、DRM 破解、批量抓取或风控规避。",
    target: "继续即表示你已阅读并同意上述边界，并自行遵守哔哩哔哩服务条款与当地法律。",
    confirmText: "我已知悉并继续",
    cancelText: "退出应用",
    tone: "info",
    iconName: "shield-check",
  });
  if (!accepted) {
    await desktop.closeWindow();
  } else {
    store.updateSettings({ authorizedAccepted: true });
    const engine = store.engineInfo;
    const engineLine = !engine
      ? "引擎状态未知"
      : engine.available
        ? `yt-dlp ${engine.ytDlpVersion || "未知"} · ffmpeg ${engine.ffmpegVersion || "缺失"}`
        : engine.message || "下载引擎不可用";
    const settings = store.getState().settings;
    const chooseDirectory = await confirmModal({
      title: "准备开始",
      message:
        "内置 yt-dlp + ffmpeg 负责真实解析与下载。你可以在设置中扫码登录自己的 Bilibili 账号，只访问该账号已有权限的内容。",
      target: `引擎：${engineLine} · 保存目录：${settings.downloadDir}`,
      confirmText: "选择下载目录",
      cancelText: "使用默认目录",
      tone: "info",
      iconName: "folder",
    });
    if (chooseDirectory) {
      const picked = await desktop.pickDirectory();
      if (picked && String(picked).trim()) {
        store.updateSettings({ downloadDir: String(picked).trim() });
      }
    }
    const loginNow = await confirmModal({
      title: "现在登录账号？（可选）",
      message:
        "登录后可访问你账号已有权限的清晰度与字幕；不登录也可以下载公开、免费内容。",
      target: "只会打开哔哩哔哩二维码；凭据存入 Windows 凭据库，不包含会员或付费内容绕过。",
      confirmText: "扫码登录",
      cancelText: "稍后再说",
      tone: "info",
      iconName: "lock",
    });
    if (loginNow) setFirstRunLoginRequested(true);
  }
}

renderRoute();
renderRecent();
updateSidebar();
startTicker();

if (isDesktop) {
  void refreshAuthStatus();
  if (consumeFirstRunLoginRequest()) {
    navigate("settings");
    window.requestAnimationFrame(() => {
      void startAuthLogin();
    });
  }
}

window.addEventListener("pagehide", () => {
  if (!isDesktop) store.flush();
});
document.addEventListener("visibilitychange", () => {
  if (!isDesktop && document.visibilityState === "hidden") store.flush();
});

if (desktop.isTauri) {
  desktop.setMinimizeToTray(store.getState().settings.minimizeToTray);
  syncWindowMaximized();
  desktop.onWindowResized(() => syncWindowMaximized());
}
