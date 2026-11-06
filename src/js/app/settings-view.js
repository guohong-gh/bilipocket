// @ts-check
// 设置页：下载行为、封面/字幕/NFO、并发与限速、引擎与更新状态。

import { $, $$, toast, confirmModal, formatCount, formatSize } from "../ui.js";
import { store } from "../runtime.js";
import { isDesktop, assetUrl } from "../bridge.js";
import * as desktop from "../tauri.js";
import { expandFilenameTemplate } from "../catalog.js";
import { parseState } from "./parse-store.js";
import { desktopAccountTier, preferredQualityAllowed, realQualityAllowed } from "./auth.js";
import { updateDataSummary, updateSidebar } from "./chrome.js";
import { renderQueue } from "./queue-view.js";
import { renderResult } from "./result-view.js";
import { currentRoute } from "./router.js";
import { ACCOUNT_TIER_IDS, AUTO_QUALITY, DEFAULT_QUALITY_ID, QUALITY_OPTIONS, accountTierMeta, isQualityAllowedForTier, qualityAccess, qualityOption, resolvePreferredQuality, supportedQualityOptions } from "../catalog.js";
import { demoSamples } from "../runtime.js";
import { DEFAULT_SETTINGS } from "../settings-schema.js";
import { updateStatus } from "../tauri.js";
import { escapeHtml, icon } from "../ui.js";
import { checkUpdate, exportDiagnostics, installUpdate, isTauri, pickDirectory, revealFile, setMinimizeToTray } from "../tauri.js";
import { promptModal } from "../ui.js";
import { renderHistory } from "./history-view.js";
import { renderHomeActivity, renderRecent } from "./home-view.js";
import { openConfiguredDirectory } from "./platform.js";

export function renderFilenamePreview() {
  const input = $("#filename-template");
  const preview = $("#filename-preview");
  if (!input || !preview) return;

  const sample = demoSamples[0] || {
    title: "示例视频",
    up: "UP 主",
    bvid: "BV1xx411c7mD",
    sizes: { "1080P": 1 },
  };
  const settings = store.getState().settings;
  const resolvedId = resolvePreferredQuality(sample, settings.preferredQuality, settings.accountTier);
  const quality = qualityOption(resolvedId) || qualityOption(DEFAULT_QUALITY_ID);
  const example = isDesktop
    ? {
        title: "示例视频",
        up: "UP 主",
        bvid: "BV1xx411c7mD",
        qualityLabel: settings.preferredQuality && settings.preferredQuality !== "auto" ? settings.preferredQuality : "1080P",
        format: "MP4",
        completedAt: Date.now(),
      }
    : {
        title: sample.title,
        up: sample.up,
        bvid: sample.bvid,
        qualityLabel: quality.label,
        format: quality.audio ? "MP3" : "MP4",
        completedAt: Date.now(),
      };

  preview.textContent = store.formatFilename(example, input.value || "{title} [{quality}]");
}

export function renderPreferredQualityChoices(settings) {
  const container = $("#preferred-quality");
  if (!container) return;

  const tier = isDesktop ? desktopAccountTier() : settings.accountTier;
  const choices = [
    { id: AUTO_QUALITY, label: "自动" },
    ...QUALITY_OPTIONS.filter((option) =>
      isDesktop ? realQualityAllowed(option.id, tier) : isQualityAllowedForTier(option.id, tier),
    ).map((option) => ({ id: option.id, label: option.label })),
  ];
  const activeId = choices.some((choice) => choice.id === settings.preferredQuality)
    ? settings.preferredQuality
    : AUTO_QUALITY;

  container.innerHTML = choices
    .map(
      (choice) => `
        <button
          class="segmented-option"
          type="button"
          role="radio"
          aria-checked="${choice.id === activeId}"
          tabindex="${choice.id === activeId ? "0" : "-1"}"
          data-quality="${escapeHtml(choice.id)}"
          title="${choice.id === AUTO_QUALITY ? "按视频与账号状态选择推荐档位" : `默认选择 ${escapeHtml(choice.label)}`}"
        >${escapeHtml(choice.label)}</button>
      `,
    )
    .join("");
}

export function renderQualityAvailability(settings) {
  const container = $("#quality-availability");
  const summary = $("#quality-availability-summary");
  if (!container || !summary) return;

  const tier = isDesktop ? desktopAccountTier() : settings.accountTier;
  const rows = QUALITY_OPTIONS.map((option) => {
    const accessible = isDesktop
      ? realQualityAllowed(option.id, tier)
      : isQualityAllowedForTier(option.id, tier);
    const access = qualityAccess(option.id, tier);
    return { ...option, accessible, reason: access.reason };
  });
  const available = rows.filter((option) => option.accessible).length;
  summary.textContent = `${accountTierMeta(tier).label} · ${available} / ${rows.length} 档可用`;
  container.innerHTML = rows
    .map(
      (option) => `
        <span class="quality-tier${option.accessible ? "" : " is-locked"}" title="${escapeHtml(option.accessible ? option.detail : option.reason || "当前不可用")}">
          ${option.accessible ? "" : icon("lock")}
          ${escapeHtml(option.label)}
        </span>
      `,
    )
    .join("");
}

export function renderAccountTier(settings) {
  $$("#account-tier [data-account-tier]").forEach((button) => {
    const checked = button.dataset.accountTier === settings.accountTier;
    button.setAttribute("aria-checked", String(checked));
    button.tabIndex = checked ? 0 : -1;
  });
}

export function renderSettings() {
  const settings = store.getState().settings;

  const pathValue = $("#path-value");
  if (pathValue) {
    pathValue.textContent = settings.downloadDir;
    pathValue.title = settings.downloadDir;
  }

  const concurrency = $("#concurrency-input");
  if (concurrency && document.activeElement !== concurrency) {
    concurrency.value = String(settings.maxConcurrent);
  }

  const rateInput = $("#rate-limit");
  if (rateInput && document.activeElement !== rateInput) {
    rateInput.value = String(settings.rateLimitKbps ?? 0);
  }

  const retryMax = $("#retry-max");
  if (retryMax && document.activeElement !== retryMax) {
    retryMax.value = String(settings.retryMax ?? 3);
  }

  const retryBase = $("#retry-base");
  if (retryBase && document.activeElement !== retryBase) {
    retryBase.value = String(settings.retryBaseSeconds ?? 15);
  }

  const fragmentRetries = $("#fragment-retries");
  if (fragmentRetries && document.activeElement !== fragmentRetries) {
    fragmentRetries.value = String(settings.fragmentRetries ?? 5);
  }

  renderAccountTier(settings);
  renderPreferredQualityChoices(settings);
  renderQualityAvailability(settings);
  renderEngineStatus();
  renderUpdateStatus();

  const templateInput = $("#filename-template");
  if (templateInput && document.activeElement !== templateInput) {
    templateInput.value = settings.filenameTemplate;
  }
  renderFilenamePreview();

  const notifications = $("#toggle-notifications");
  const tray = $("#toggle-tray");
  if (notifications) notifications.setAttribute("aria-checked", String(settings.notifyOnComplete));
  if (tray) tray.setAttribute("aria-checked", String(settings.minimizeToTray));

  const defaultDanmaku = $("#toggle-default-danmaku");
  const defaultSubtitles = $("#toggle-default-subtitles");
  for (const [id, key] of [
    ["toggle-save-cover", "saveCover"],
    ["toggle-write-chapters", "writeChapters"],
    ["toggle-save-nfo", "saveNfo"],
  ]) {
    $(`#${id}`)?.setAttribute("aria-checked", String(settings[key] === true));
  }
  for (const [id, key, fallback] of [
    ["cover-naming", "coverNaming", "poster"],
    ["subtitle-format", "subtitleFormat", "srt"],
    ["nfo-title-source", "nfoTitleSource", "video"],
  ]) {
    const select = $(`#${id}`);
    if (select && document.activeElement !== select) {
      select.value = settings[key] || fallback;
    }
  }
  if (defaultDanmaku) defaultDanmaku.setAttribute("aria-checked", String(settings.defaultDanmaku !== false));
  if (defaultSubtitles) {
    defaultSubtitles.setAttribute("aria-checked", String(settings.defaultSubtitles !== false));
  }

  const autostart = $("#toggle-autostart");
  if (autostart) {
    autostart.setAttribute("aria-checked", String(store.autostartEnabled === true));
    autostart.disabled = !isDesktop || store.isPortable === true;
    autostart.title = !isDesktop
      ? "浏览器预览不支持开机自启"
      : store.isPortable
        ? "便携版不会写入系统启动项"
        : "开机时自动启动 BiliPocket";
  }

  const dataDir = $("#data-dir-value");
  if (dataDir) {
    dataDir.textContent = store.dataDirectory || "—";
    dataDir.title = store.dataDirectory || "";
  }

  updateDataSummary();
}

export function renderEngineStatus() {
  const engine = store.engineInfo;
  if (!isDesktop || !engine) return;
  const ytDlp = $("#engine-ytdlp");
  const ffmpeg = $("#engine-ffmpeg");
  const state = $("#engine-state");
  const message = $("#engine-message");
  if (ytDlp) ytDlp.textContent = engine.ytDlpVersion ? `yt-dlp ${engine.ytDlpVersion}` : "yt-dlp 缺失";
  if (ffmpeg) ffmpeg.textContent = engine.ffmpegVersion ? `ffmpeg ${engine.ffmpegVersion}` : "ffmpeg 缺失";
  if (state) {
    state.textContent = !engine.available ? "不可用" : engine.ffmpegVersion ? "可用" : "部分可用";
    state.dataset.tone = !engine.available ? "danger" : engine.ffmpegVersion ? "ok" : "warning";
  }
  if (message) {
    message.textContent =
      engine.message ||
      (engine.available
        ? "本地引擎已就绪；下载与合并由本机进程执行。"
        : "未找到可用的下载引擎。");
  }

  // 只有存在结构化问题时才给"重新校验"入口：它是应用端唯一能做的修复动作。
  const refresh = $("#engine-refresh");
  if (refresh) {
    const problem = engine.problem || null;
    refresh.hidden = !problem;
    refresh.disabled = engineRefreshing;
    refresh.title = problem
      ? `${problem.detail}（code: ${problem.code}）`
      : "重新校验本地引擎完整性";
    refresh.textContent = engineRefreshing ? "校验中…" : "重新校验";
  }
}

export function renderUpdateStatus() {
  if (!isDesktop) return;
  const state = $("#update-state");
  const message = $("#update-message");
  const button = $("#check-updates");
  if (!updateStatusPromise) {
    updateStatusPromise = desktop.updateStatus().catch((error) => {
      console.warn("[BiliPocket] 无法读取更新配置", error);
      return null;
    });
  }
  updateStatusPromise.then((status) => {
    const row = $("#update-row");
    if (!status) {
      if (row) row.hidden = true;
      return;
    }
    if (status.configured !== true) {
      if (row) row.hidden = true;
      return;
    }
    if (row) row.hidden = false;
    if (status.portable === true) {
      if (state) {
        state.textContent = "手动更新";
        state.dataset.tone = "warning";
      }
      if (message) {
        message.textContent =
          "便携版不会自动覆盖文件；请下载新版本便携包并手动替换。";
      }
      if (button) button.disabled = true;
      return;
    }
    if (state) {
      state.textContent = "已配置";
      state.dataset.tone = "ok";
    }
    if (message) {
      message.textContent = `通过签名 HTTPS 源检查更新；当前 v${status.currentVersion}。`;
    }
    if (button) button.disabled = false;
  });
}

export function applyConcurrency(raw) {
  const numeric = Number(raw);
  const next = Number.isFinite(numeric) ? Math.min(5, Math.max(1, Math.round(numeric))) : 2;
  const input = $("#concurrency-input");
  if (input) input.value = String(next);
  const current = store.getState().settings.maxConcurrent;
  if (next === current) return;

  const activeBefore = store.activeCount();
  store.updateSettings({ maxConcurrent: next });
  const paused = Math.max(0, activeBefore - store.activeCount());

  renderSettings();
  updateSidebar();
  if (currentRoute === "queue") renderQueue();

  if (paused > 0) {
    toast("同时下载数已调整", {
      tone: "info",
      message: `已暂停 ${paused} 个任务以遵守新的并发上限，进度会保留。`,
    });
  }
}

export function applyRateLimit(raw) {
  const numeric = Number(raw);
  const value = Number.isFinite(numeric)
    ? Math.min(102400, Math.max(0, Math.round(numeric)))
    : 0;
  const input = $("#rate-limit");
  if (input) input.value = String(value);
  store.updateSettings({ rateLimitKbps: value });
  toast(value > 0 ? `下载限速已设为 ${value} KB/s` : "已关闭下载限速", {
    tone: "info",
    message: "对之后开始的任务生效。",
    duration: 1900,
  });
}

export function bindRetryField(field) {
  const input = $(`#${field.id}`);
  if (!input) return;
  const apply = () => {
    const numeric = Number(input.value);
    const value = Number.isFinite(numeric)
      ? Math.min(field.max, Math.max(field.min, Math.round(numeric)))
      : field.fallback;
    input.value = String(value);
    if (store.getState().settings[field.key] === value) return;
    store.updateSettings({ [field.key]: value });
    toast(`${field.label}已设为 ${value} ${field.unit}`, { tone: "info", duration: 1600 });
  };
  input.addEventListener("change", apply);
  input.addEventListener("blur", apply);
}

export function setPreferredQuality(qualityId, { focus = false } = {}) {
  const settings = store.getState().settings;
  const allowed =
    qualityId === AUTO_QUALITY ||
    preferredQualityAllowed(qualityId);
  if (!allowed) return;

  store.updateSettings({ preferredQuality: qualityId });
  const updated = store.getState().settings;
  $$("#preferred-quality [data-quality]").forEach((item) => {
    const checked = item.dataset.quality === updated.preferredQuality;
    item.setAttribute("aria-checked", String(checked));
    item.tabIndex = checked ? 0 : -1;
    if (checked && focus) item.focus();
  });
  renderFilenamePreview();
}

export function setAccountTier(tier, { focus = false } = {}) {
  if (!ACCOUNT_TIER_IDS.includes(tier)) return;
  if (store.getState().settings.accountTier === tier) {
    if (focus) $(`#account-tier [data-account-tier="${tier}"]`)?.focus();
    return;
  }

  store.updateSettings({ accountTier: tier });
  renderSettings();
  refreshResultQualityForAccount();
  if (focus) $(`#account-tier [data-account-tier="${tier}"]`)?.focus();
}

export function refreshResultQualityForAccount() {
  if (!parseState.video || parseState.status !== "result") return;

  const settings = store.getState().settings;
  let nextQuality = parseState.quality;

  if (parseState.qualitySource === "auto") {
    nextQuality = resolvePreferredQuality(parseState.video, AUTO_QUALITY, settings.accountTier);
  } else if (parseState.qualitySource === "preference") {
    nextQuality = resolvePreferredQuality(parseState.video, settings.preferredQuality, settings.accountTier);
    if (settings.preferredQuality === AUTO_QUALITY) parseState.qualitySource = "auto";
  } else if (parseState.quality) {
    const supported = supportedQualityOptions(parseState.video).some((option) => option.id === parseState.quality);
    const access = qualityAccess(parseState.quality, settings.accountTier);
    nextQuality =
      supported && access.accessible
        ? parseState.quality
        : resolvePreferredQuality(parseState.video, parseState.quality, settings.accountTier);
  } else {
    nextQuality = resolvePreferredQuality(parseState.video, settings.preferredQuality, settings.accountTier);
    parseState.qualitySource = settings.preferredQuality === AUTO_QUALITY ? "auto" : "preference";
  }

  parseState.quality = nextQuality;
  renderResult();
}

export let engineRefreshing = false;
export let updateStatusPromise = null;
export const RETRY_FIELDS = [
  { id: "retry-max", key: "retryMax", min: 0, max: 10, fallback: DEFAULT_SETTINGS.retryMax, label: "自动重试次数", unit: "次" },
  { id: "retry-base", key: "retryBaseSeconds", min: 3, max: 300, fallback: DEFAULT_SETTINGS.retryBaseSeconds, label: "重试间隔", unit: "秒" },
  { id: "fragment-retries", key: "fragmentRetries", min: 0, max: 20, fallback: DEFAULT_SETTINGS.fragmentRetries, label: "分片重试次数", unit: "次" },
];

// 引擎「重新校验」按钮：与上面的 engineRefreshing 状态同属本页。
$("#engine-refresh")?.addEventListener("click", async () => {
  if (engineRefreshing) return;
  engineRefreshing = true;
  renderEngineStatus();
  try {
    const info = await store.refreshEngine();
    if (!info) {
      toast("引擎校验失败", { tone: "error", message: "后端没有返回引擎状态。" });
      return;
    }
    renderEngineStatus();
    toast(info.problem ? "引擎仍不可用" : "引擎校验通过", {
      tone: info.problem ? "info" : "success",
      message: info.problem ? info.problem.detail : "下次下载会使用新校验的引擎。",
    });
  } finally {
    engineRefreshing = false;
    renderEngineStatus();
  }
});


$("#concurrency-input")?.addEventListener("change", (event) => {
  applyConcurrency(event.currentTarget.value);
});
$("#concurrency-input")?.addEventListener("blur", (event) => {
  applyConcurrency(event.currentTarget.value);
});

$("#rate-limit")?.addEventListener("change", (event) => {
  applyRateLimit(event.currentTarget.value);
});
$("#rate-limit")?.addEventListener("blur", (event) => {
  applyRateLimit(event.currentTarget.value);
});

RETRY_FIELDS.forEach(bindRetryField);

$("#preferred-quality")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-quality]");
  if (!button) return;
  setPreferredQuality(button.dataset.quality);
});

$("#account-tier")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-account-tier]");
  if (!button) return;
  setAccountTier(button.dataset.accountTier);
});

$("#account-tier")?.addEventListener("keydown", (event) => {  const group = event.currentTarget;
  const current = event.target.closest("[data-account-tier]");
  if (!current) return;

  const options = $$("[data-account-tier]", group);
  const currentIndex = options.indexOf(current);
  if (currentIndex < 0) return;

  let nextIndex = null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    nextIndex = (currentIndex + 1) % options.length;
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    nextIndex = (currentIndex - 1 + options.length) % options.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = options.length - 1;
  }

  if (nextIndex === null) return;
  event.preventDefault();
  setAccountTier(options[nextIndex].dataset.accountTier, { focus: true });
});

$("#preferred-quality")?.addEventListener("keydown", (event) => {
  const group = event.currentTarget;
  const current = event.target.closest("[data-quality]");
  if (!current) return;

  const options = $$("[data-quality]", group);
  const currentIndex = options.indexOf(current);
  if (currentIndex < 0) return;

  let nextIndex = null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    nextIndex = (currentIndex + 1) % options.length;
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    nextIndex = (currentIndex - 1 + options.length) % options.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = options.length - 1;
  }

  if (nextIndex === null) return;
  event.preventDefault();
  setPreferredQuality(options[nextIndex].dataset.quality, { focus: true });
});

$("#filename-template")?.addEventListener("input", () => {
  renderFilenamePreview();
  window.clearTimeout(templateDebounce);
  templateDebounce = window.setTimeout(() => {
    const value = $("#filename-template")?.value ?? "";
    if (value.trim()) store.updateSettings({ filenameTemplate: value });
  }, 300);
});

$("#filename-template")?.addEventListener("blur", () => {
  window.clearTimeout(templateDebounce);
  const input = $("#filename-template");
  if (!input) return;

  const template = input.value.trim() ? input.value : DEFAULT_SETTINGS.filenameTemplate;
  if (input.value !== template) input.value = template;
  store.updateSettings({ filenameTemplate: template });
  renderFilenamePreview();
});

$("#open-dir")?.addEventListener("click", () => {
  openConfiguredDirectory();
});

$("#change-dir")?.addEventListener("click", async () => {
  const current = store.getState().settings.downloadDir;
  let picked = null;

  if (desktop.isTauri) {
    picked = await desktop.pickDirectory();
  } else {
    picked = await promptModal({
      title: "选择下载目录",
      message: "浏览器预览无法打开系统文件夹选择器，可以直接输入一个路径。原型只会保存这段文字。",
      label: "目录路径",
      value: current,
      placeholder: "例如 D:\\Videos\\BiliPocket",
      confirmText: "保存路径",
    });
  }

  if (!picked || !String(picked).trim()) return;

  store.updateSettings({ downloadDir: String(picked).trim() });
  renderSettings();

  const targetHint = $(".target-hint code");
  if (targetHint) targetHint.textContent = String(picked).trim();

  toast("下载目录已更新", { tone: "success", message: "仅保存路径，不会创建目录或写入文件。" });
});

$("#toggle-notifications")?.addEventListener("click", () => {
  const next = !store.getState().settings.notifyOnComplete;
  store.updateSettings({ notifyOnComplete: next });
  $("#toggle-notifications")?.setAttribute("aria-checked", String(next));

  if (next) {
    toast("完成通知已开启", {
      tone: "info",
      message: desktop.isTauri ? (isDesktop ? "下载完成时会发送系统通知。" : "模拟任务完成时会发送系统通知。") : "浏览器预览只会显示应用内提示。",
      duration: 2600,
    });
  }
});

$("#toggle-tray")?.addEventListener("click", async () => {
  const next = !store.getState().settings.minimizeToTray;
  store.updateSettings({ minimizeToTray: next });
  $("#toggle-tray")?.setAttribute("aria-checked", String(next));

  if (desktop.isTauri) {
    await desktop.setMinimizeToTray(next);
  } else {
    toast("在桌面版中生效", {
      tone: "info",
      message: "浏览器预览无法最小化到系统托盘。",
      duration: 2600,
    });
  }
});

$("#toggle-default-danmaku")?.addEventListener("click", () => {
  const next = !(store.getState().settings.defaultDanmaku !== false);
  store.updateSettings({ defaultDanmaku: next });
  $("#toggle-default-danmaku")?.setAttribute("aria-checked", String(next));
});

$("#toggle-default-subtitles")?.addEventListener("click", () => {
  const next = !(store.getState().settings.defaultSubtitles !== false);
  store.updateSettings({ defaultSubtitles: next });
  $("#toggle-default-subtitles")?.setAttribute("aria-checked", String(next));
});

for (const [id, key] of [
  ["toggle-save-cover", "saveCover"],
  ["toggle-write-chapters", "writeChapters"],
  ["toggle-save-nfo", "saveNfo"],
]) {
  $(`#${id}`)?.addEventListener("click", () => {
    const next = !(store.getState().settings[key] === true);
    store.updateSettings({ [key]: next });
    $(`#${id}`)?.setAttribute("aria-checked", String(next));
  });
}
for (const [id, key] of [
  ["cover-naming", "coverNaming"],
  ["subtitle-format", "subtitleFormat"],
  ["nfo-title-source", "nfoTitleSource"],
]) {
  $(`#${id}`)?.addEventListener("change", (event) => {
    store.updateSettings({ [key]: String(event.currentTarget.value || "") });
  });
}

$("#toggle-autostart")?.addEventListener("click", async () => {
  if (!isDesktop || store.isPortable) return;
  const button = $("#toggle-autostart");
  if (!button) return;
  const next = !(store.autostartEnabled === true);
  button.disabled = true;
  const result = await store.setAutostart(next);
  button.disabled = false;
  if (!result.ok) {
    button.setAttribute("aria-checked", String(store.autostartEnabled === true));
    toast("无法修改开机自启", {
      tone: "error",
      message: result.message || "请稍后重试。",
    });
    return;
  }
  button.setAttribute("aria-checked", String(result.enabled === true));
  toast(result.enabled ? "已开启开机自启" : "已关闭开机自启", {
    tone: "info",
    message: result.enabled ? "下次登录 Windows 时会自动启动。" : "不会随系统自动启动。",
    duration: 2200,
  });
});

$("#check-updates")?.addEventListener("click", async () => {
  if (!isDesktop) return;
  const button = $("#check-updates");
  const state = $("#update-state");
  const message = $("#update-message");
  if (button) button.disabled = true;
  if (state) {
    state.textContent = "检查中";
    state.dataset.tone = "";
  }
  if (message) message.textContent = "正在读取签名更新清单…";
  try {
    const result = await desktop.checkUpdate();
    if (!result.available) {
      if (state) {
        state.textContent = "已是最新";
        state.dataset.tone = "ok";
      }
      if (message) message.textContent = `当前 v${result.currentVersion} 已是最新版本。`;
      toast("已是最新版本", { tone: "success", message: `当前 v${result.currentVersion}`, duration: 2200 });
      return;
    }
    if (state) {
      state.textContent = `发现 v${result.version}`;
      state.dataset.tone = "ok";
    }
    if (message) {
      message.textContent = result.notes || "新版本将从配置的 HTTPS 源下载，并在安装前校验签名。";
    }
    const confirmed = await confirmModal({
      title: `发现新版本 v${result.version}`,
      message: result.notes || "更新包会从配置的 HTTPS 源下载，并在安装前校验签名。",
      target: `当前 v${result.currentVersion} · 安装会重启应用，下载期间请保持窗口开启。`,
      confirmText: "下载并安装",
      cancelText: "稍后",
      tone: "info",
      iconName: "download",
    });
    if (!confirmed) return;
    if (state) {
      state.textContent = "下载更新中";
      state.dataset.tone = "";
    }
    if (message) message.textContent = "正在下载并校验更新包，完成后应用会自动重启。";
    await desktop.installUpdate();
    toast("正在安装更新", { tone: "success", message: "下载完成后应用会自动重启。" });
  } catch (error) {
    const code = error?.code || error?.payload?.code;
    const detail = error?.message || error?.payload?.message || String(error);
    if (state) {
      state.textContent = code === "update_not_configured" ? "未配置" : "检查失败";
      state.dataset.tone = "warning";
    }
    if (message) message.textContent = detail;
    if (code !== "update_not_configured") {
      toast("检查更新失败", { tone: "error", message: detail });
    }
  } finally {
    if (button) button.disabled = false;
  }
});

$("#export-diagnostics")?.addEventListener("click", async () => {
  if (!isDesktop) return;
  const button = $("#export-diagnostics");
  if (button) button.disabled = true;
  try {
    const path = await desktop.exportDiagnostics();
    if (!path) throw new Error("没有返回诊断文件路径。");
    const revealed = await desktop.revealFile(path);
    const filename = String(path).split(/[\\/]/).pop() || "诊断文件";
    toast("诊断已导出", {
      tone: "success",
      message: revealed
        ? `已生成 ${filename}，并可在文件管理器中查看。`
        : `已生成 ${filename}；无法自动定位文件时请查看应用数据目录。`,
      duration: 4200,
    });
  } catch (error) {
    toast("导出诊断失败", { tone: "error", message: error?.message || String(error) });
  } finally {
    if (button) button.disabled = false;
  }
});

$("#reset-demo")?.addEventListener("click", async () => {
  const confirmed = await confirmModal({
    title: "重置演示数据？",
    message: "演示队列和历史会恢复到初始状态，设置与主题偏好会保留。",
    confirmText: "重置",
    iconName: "refresh",
  });
  if (!confirmed) return;

  store.resetDemo();
  renderSettings();
  renderRecent();
  renderHomeActivity();
  updateSidebar();
  if (currentRoute === "queue") renderQueue();
  if (currentRoute === "history") renderHistory();
  toast("演示数据已重置", { tone: "success", message: "队列与历史已恢复初始演示状态。" });
});

// 模板输入防抖定时器，只被本页的输入绑定使用。
let templateDebounce = null;
