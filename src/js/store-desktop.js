// @ts-check
import { desktopBridge as bridge, isDesktop, assetUrl } from "./bridge.js";
import { upsertTask } from "./queue-model.js";
import { expandFilenameTemplate } from "./catalog.js";
import {
  applySettingsPatch,
  hydrateSettings,
  legacySettingsPatch,
  toWireSettings,
} from "./settings-schema.js";

const PLACEHOLDER_COVER = "./assets/cover-placeholder.svg";
const LEGACY_STORAGE_KEY = "bilipocket.prototype.v1";
const MIGRATION_MARKER = "bilipocket.desktop.migrated.v08";
const THEME_MIRROR_KEY = "bilipocket.theme";
const pending = { progressChanged: false, structureChanged: false, completed: [] };
let state = {
  settings: hydrateSettings({}, { surface: "desktop" }),
  queue: [],
  history: [],
};
let historyTimer = null;
const pendingEnqueues = new Set();

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "—";
  const total = Math.round(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

function durationToSeconds(value) {
  const parts = String(value || "")
    .split(":")
    .map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return undefined;
}

function mapSettings(settings) {
  return hydrateSettings(settings, { surface: "desktop" });
}

function mapStatus(status) {
  // 阶段与任务类型共用 extras：这里把四个进行中阶段统一映射为 downloading，
  // 具体阶段保留在 task.phase 中供界面展示。
  if (status === "cancelled") return "cancelled";
  if (["probing", "downloading", "muxing", "extras"].includes(status)) return "downloading";
  return status;
}

function coverOf(entry) {
  return assetUrl(entry.coverPath) || PLACEHOLDER_COVER;
}

function syncThemeMirror(theme) {
  try {
    localStorage.setItem(THEME_MIRROR_KEY, String(theme || "light"));
  } catch {
    // Theme boot falls back to the legacy key when storage is unavailable.
  }
}

function mapTask(task) {
  const sizeMB = (Number(task.sizeBytes) || 0) / 1_000_000;
  const downloadedMB = (Number(task.downloadedBytes) || 0) / 1_000_000;
  const speed = (Number(task.speedBytesPerSec) || 0) / 1_000_000;
  const kind = task.kind === "extras" ? "extras" : "video";
  return {
    id: task.id,
    kind,
    bvid: task.bvid || "",
    title: task.title || "未命名视频",
    up: task.uploader || "未知 UP 主",
    cover: coverOf(task),
    coverPath: task.coverPath || null,
    coverUrl: task.coverUrl || null,
    duration: formatDuration(task.durationSeconds),
    quality: task.formatId || "",
    qualityLabel: kind === "extras" ? "附加内容" : task.qualityLabel || "—",
    baseQualityLabel: task.qualityLabel || "",
    format: kind === "extras" ? "附加文件" : (task.container || "mp4").toUpperCase(),
    sizeMB,
    downloadedMB,
    speed,
    speedBase: speed,
    status: mapStatus(task.status),
    phase: task.status,
    error: task.errorMessage || null,
    errorCode: task.errorCode || null,
    extrasError: task.extrasError || null,
    retryAt: task.retryAt || null,
    addedAt: task.createdAt,
    queuedAt: task.queuedAt || null,
    startedAt: task.startedAt || null,
    completedAt: task.completedAt || null,
    danmakuTypes: Array.isArray(task.danmakuTypes) ? task.danmakuTypes : [],
    danmakuCount: Number(task.danmakuCount) || 0,
    subtitles: Array.isArray(task.subtitleLangs) ? task.subtitleLangs : [],
    outputPath: task.outputPath || null,
    tempDir: task.tempDir || null,
    realStatus: task.status,
  };
}

function mapHistory(entry) {
  const kind = entry.kind === "extras" ? "extras" : "video";
  return {
    id: entry.id,
    kind,
    taskId: entry.taskId || null,
    bvid: entry.bvid || "",
    title: entry.title || "未命名视频",
    up: entry.uploader || "未知 UP 主",
    cover: coverOf(entry),
    coverPath: entry.coverPath || null,
    coverUrl: entry.coverUrl || null,
    duration: formatDuration(entry.durationSeconds),
    quality: entry.formatId || "",
    qualityLabel: kind === "extras" ? "附加内容" : entry.qualityLabel || "—",
    baseQualityLabel: entry.qualityLabel || "",
    format: kind === "extras" ? "附加文件" : (entry.container || "mp4").toUpperCase(),
    sizeMB: (Number(entry.sizeBytes) || 0) / 1_000_000,
    completedAt: entry.completedAt,
    danmakuTypes: Array.isArray(entry.danmakuTypes) ? entry.danmakuTypes : [],
    danmakuCount: Number(entry.danmakuCount) || 0,
    subtitles: Array.isArray(entry.subtitleLangs) ? entry.subtitleLangs : [],
    extrasError: entry.extrasError || null,
    outputPath: entry.outputPath || null,
    missingFile: entry.missingFile === true,
  };
}

function sanitizeFilenameBase(value) {
  let cleaned = String(value || "")
    .replaceAll(/[<>:"/\\|?*]/g, "_")
    .replaceAll(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!cleaned) cleaned = "未命名视频";
  if (cleaned.length > 120) cleaned = cleaned.slice(0, 120).replace(/[. ]+$/g, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned;
}

function refreshHistorySoon() {
  clearTimeout(historyTimer);
  historyTimer = window.setTimeout(refreshHistoryNow, 120);
}

async function refreshHistoryNow() {
  try {
    state.history = (await bridge.listHistory()).map(mapHistory);
    pending.structureChanged = true;
  } catch (error) {
    console.warn("[BiliPocket] 无法刷新历史", error);
  }
}

let reconcileInFlight = null;
let lastReconcileAt = 0;

function reconcile({ force = false } = {}) {
  if (reconcileInFlight) return reconcileInFlight;
  const now = Date.now();
  if (!force && now - lastReconcileAt < 2000) return Promise.resolve();
  lastReconcileAt = now;
  reconcileInFlight = Promise.all([refreshTasks(), refreshHistoryNow()])
    .catch((error) => console.warn("[BiliPocket] 队列对账失败", error))
    .finally(() => {
      reconcileInFlight = null;
    });
  return reconcileInFlight;
}

async function refreshTasks() {
  try {
    state.queue = (await bridge.listTasks()).map(mapTask);
    pending.structureChanged = true;
  } catch (error) {
    console.warn("[BiliPocket] 无法刷新任务", error);
  }
}

function handleTaskPayload(payload) {
  if (!payload || !payload.id) {
    refreshTasks();
    return;
  }
  const task = mapTask(payload);
  const { previous } = upsertTask(state.queue, task);

  const statusChanged = !previous || previous.status !== task.status || previous.realStatus !== task.realStatus;
  const isNewCompletion = task.status === "completed" && previous?.status !== "completed";
  if (statusChanged) pending.structureChanged = true;
  else if (previous && previous.downloadedMB !== task.downloadedMB) pending.progressChanged = true;

  if (isNewCompletion) {
    bridge
      .listHistory()
      .then((rows) => {
        state.history = rows.map(mapHistory);
        pending.structureChanged = true;
      })
      .catch((error) => console.warn("[BiliPocket] 无法刷新历史", error))
      .finally(() => pending.completed.push(task));
  }
}

export const desktopStore = {
  isDesktop: true,
  desktopBridge: bridge,

  async init() {
    if (!isDesktop) return state;
    const bootstrap = await bridge.bootstrap();
    state = {
      settings: mapSettings(bootstrap.settings),
      queue: bootstrap.tasks.map(mapTask),
      history: bootstrap.history.map(mapHistory),
    };
    this.engine = bootstrap.engine;
    this.auth = bootstrap.auth || { loggedIn: false, account: null };
    this.dataDir = bootstrap.dataDir || "";
    this.autostart = bootstrap.autostart === true;
    this.portable = bootstrap.portable === true;
    syncThemeMirror(state.settings.theme);
    await bridge.listen("tasks://changed", handleTaskPayload);
    await bridge.listen("tasks://deleted", refreshTasks);
    await bridge.listen("tasks://cleared", refreshTasks);
    await bridge.listen("history://changed", refreshHistorySoon);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void reconcile();
    });
    window.addEventListener("focus", () => {
      void reconcile();
    });
    await reconcile({ force: true });
    return state;
  },

  getState() {
    return state;
  },

  get engineInfo() {
    return this.engine || null;
  },

  async refreshEngine() {
    if (!isDesktop) return null;
    try {
      this.engine = await bridge.refreshEngine();
      return this.engine;
    } catch (error) {
      console.warn("[BiliPocket] 引擎重新校验失败", error);
      return null;
    }
  },

  get authInfo() {
    return this.auth || { loggedIn: false, account: null };
  },

  setAuth(auth) {
    this.auth = auth || { loggedIn: false, account: null };
  },

  get dataDirectory() {
    return this.dataDir || "";
  },

  get autostartEnabled() {
    return this.autostart === true;
  },

  get isPortable() {
    return this.portable === true;
  },

  async setAutostart(enabled) {
    try {
      const value = await bridge.setAutostart(enabled);
      this.autostart = value === true;
      return { ok: true, enabled: this.autostart };
    } catch (error) {
      return {
        ok: false,
        message: error?.message || error?.payload?.message || String(error),
      };
    }
  },

  activeCount() {
    return state.queue.filter((task) => task.status === "downloading").length;
  },

  pendingCount() {
    return state.queue.filter((task) => ["downloading", "queued", "paused", "failed"].includes(task.status)).length;
  },

  totalSpeed() {
    return state.queue.reduce((sum, task) => sum + (Number(task.speed) || 0), 0);
  },

  findDuplicate(bvid, quality, kind = "video") {
    return state.queue.find(
      (task) =>
        task.bvid === bvid &&
        (task.kind || "video") === kind &&
        (kind === "extras" || task.quality === quality) &&
        task.status !== "completed" &&
        task.status !== "cancelled",
    );
  },

  tick() {
    const result = {
      progressChanged: pending.progressChanged,
      structureChanged: pending.structureChanged,
      completed: [...pending.completed],
    };
    pending.progressChanged = false;
    pending.structureChanged = false;
    pending.completed.length = 0;
    return result;
  },

  async addTask(source, formatId, selection = {}, options = {}) {
    const quality = (source.qualityOptions || []).find((item) => item.formatId === formatId);
    if (!quality) return { ok: false, reason: "invalid_format", message: "找不到所选清晰度。" };
    const taskOptions = options.taskOptions || {};
    const pageKey = taskOptions.pageIndex ?? 0;
    const key = `${source.bvid}::video::${formatId}::p${pageKey}`;
    if (pendingEnqueues.has(key)) {
      return { ok: false, reason: "in_flight", message: "正在加入队列，请稍候。" };
    }
    if (
      pageKey === 0 &&
      this.findDuplicate(source.bvid, formatId, "video")
    ) {
      return {
        ok: false,
        reason: "duplicate",
        message: "同一视频与清晰度已在队列中；请先移除后再试。",
      };
    }

    pendingEnqueues.add(key);
    try {
      const selectedTypes = new Set(selection.danmakuTypes || []);
      const danmakuCount = Object.entries(source.danmakuTypeCounts || {})
        .filter(([type]) => selectedTypes.has(type))
        .reduce((sum, [, count]) => sum + (Number(count) || 0), 0);
      const raw = await bridge.enqueueTask({
        kind: "video",
        sourceUrl: source.sourceUrl,
        bvid: source.bvid,
        formatId,
        qualityLabel: quality.label,
        container: quality.container,
        title: source.title,
        uploader: source.up,
        coverUrl: source.coverUrl || null,
        coverPath: source.coverPath || null,
        durationSeconds: source.durationSeconds,
        sizeBytes: quality.sizeBytes,
        danmakuTypes: selection.danmakuTypes || [],
        danmakuCount,
        subtitleLangs: selection.subtitles || [],
        options: taskOptions,
      });
      const task = mapTask(raw);
      upsertTask(state.queue, task);
      pending.structureChanged = true;
      return { ok: true, task };
    } catch (error) {
      const code = error?.code || error?.payload?.code || "download_failed";
      const message = error?.message || error?.payload?.message || String(error);
      return { ok: false, reason: code, message };
    } finally {
      pendingEnqueues.delete(key);
    }
  },

  async addExtrasTask(source, selection = {}, options = {}) {
    const danmakuTypes = Array.isArray(selection.danmakuTypes)
      ? [...new Set(selection.danmakuTypes)]
      : [];
    const subtitles = Array.isArray(selection.subtitles) ? [...new Set(selection.subtitles)] : [];
    if (!danmakuTypes.length && !subtitles.length) {
      return { ok: false, reason: "no_extras", message: "请先选择弹幕类型或字幕语言。" };
    }
    const key = `${source.bvid}::extras`;
    if (pendingEnqueues.has(key)) {
      return { ok: false, reason: "in_flight", message: "正在加入队列，请稍候。" };
    }
    if (this.findDuplicate(source.bvid, "", "extras")) {
      return {
        ok: false,
        reason: "duplicate",
        message: "该视频的附加内容已在队列中；请先移除后再试。",
      };
    }

    pendingEnqueues.add(key);
    try {
      const selectedTypes = new Set(danmakuTypes);
      const danmakuCount =
        Number(selection.danmakuCount) ||
        Object.entries(source.danmakuTypeCounts || {})
          .filter(([type]) => selectedTypes.has(type))
          .reduce((sum, [, count]) => sum + (Number(count) || 0), 0);
      const raw = await bridge.enqueueTask({
        kind: "extras",
        sourceUrl: source.sourceUrl || `https://www.bilibili.com/video/${source.bvid}`,
        bvid: source.bvid,
        formatId: "",
        qualityLabel:
          options.qualityLabel || source.baseQualityLabel || source.qualityLabel || "附加内容",
        container: "extras",
        title: source.title,
        uploader: source.up,
        coverUrl: source.coverUrl || null,
        coverPath: source.coverPath || null,
        durationSeconds: source.durationSeconds ?? durationToSeconds(source.duration),
        sizeBytes: 0,
        danmakuTypes,
        danmakuCount,
        subtitleLangs: subtitles,
      });
      const task = mapTask(raw);
      upsertTask(state.queue, task);
      pending.structureChanged = true;
      return { ok: true, task };
    } catch (error) {
      const code = error?.code || error?.payload?.code || "download_failed";
      const message = error?.message || error?.payload?.message || String(error);
      return { ok: false, reason: code, message };
    } finally {
      pendingEnqueues.delete(key);
    }
  },

  updateSettings(patch) {
    const next = applySettingsPatch(state.settings, patch, { surface: "desktop" });
    state.settings = next;
    bridge
      .updateSettings(toWireSettings(next))
      .then((saved) => {
        // 桌面端 accountTier 由登录态派生，后端不返回该字段，hydrate 会保持 guest。
        state.settings = hydrateSettings(saved, { surface: "desktop" });
        syncThemeMirror(state.settings.theme);
      })
      .catch((error) => console.warn("[BiliPocket] 无法保存设置", error));
    return state.settings;
  },

  migratePrototypeSettings() {
    if (!isDesktop) return null;
    try {
      if (localStorage.getItem(MIGRATION_MARKER)) return null;
      const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!raw) {
        localStorage.setItem(MIGRATION_MARKER, "1");
        return null;
      }
      let legacy = null;
      try {
        legacy = JSON.parse(raw);
      } catch {
        legacy = null;
      }
      const saved = legacy?.settings && typeof legacy.settings === "object" ? legacy.settings : {};
      const previous = {
        queue: Array.isArray(legacy?.queue) ? legacy.queue.length : 0,
        history: Array.isArray(legacy?.history) ? legacy.history.length : 0,
      };
      try {
        localStorage.setItem(`${LEGACY_STORAGE_KEY}.archived`, raw);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch {
        // Keeping the original key is safer than losing prototype state.
      }

      const patch = legacySettingsPatch(saved);
      if (Object.keys(patch).length) this.updateSettings(patch);
      localStorage.setItem(MIGRATION_MARKER, "1");
      return { ...previous, settingsApplied: Object.keys(patch).length };
    } catch (error) {
      console.warn("[BiliPocket] 旧版设置迁移失败", error);
      return null;
    }
  },

  pauseTask(id) {
    const task = state.queue.find((item) => item.id === id);
    if (task) task.status = "paused";
    pending.structureChanged = true;
    bridge.pauseTask(id).catch(refreshTasks);
  },

  resumeTask(id) {
    const task = state.queue.find((item) => item.id === id);
    if (task) task.status = "queued";
    pending.structureChanged = true;
    bridge.resumeTask(id).catch(refreshTasks);
  },

  retryTask(id) {
    const task = state.queue.find((item) => item.id === id);
    if (task) task.status = "queued";
    pending.structureChanged = true;
    bridge.retryTask(id).catch(refreshTasks);
  },

  async cancelTask(id, { deletePartial = false } = {}) {
    try {
      const result = await bridge.cancelTask(id, deletePartial);
      const task = mapTask(result.task);
      upsertTask(state.queue, task);
      pending.structureChanged = true;
      return {
        ok: true,
        task,
        partialDeleted: result.partialDeleted === true,
        deleteError: result.deleteError || null,
      };
    } catch (error) {
      await refreshTasks();
      return {
        ok: false,
        message: error?.message || error?.payload?.message || String(error),
      };
    }
  },

  async removeTask(id, { deleteFile = false } = {}) {
    try {
      const result = await bridge.deleteTask(id, deleteFile);
      state.queue = state.queue.filter((item) => item.id !== id);
      pending.structureChanged = true;
      return {
        ok: true,
        fileDeleted: result.fileDeleted === true,
        fileError: result.fileError || null,
      };
    } catch (error) {
      await refreshTasks();
      return {
        ok: false,
        message: error?.message || error?.payload?.message || String(error),
      };
    }
  },

  pauseAll() {
    state.queue.filter((task) => task.status === "downloading" || task.status === "queued").forEach((task) => this.pauseTask(task.id));
  },

  resumeAll() {
    state.queue.filter((task) => task.status === "paused").forEach((task) => this.resumeTask(task.id));
  },

  prioritizeTask(id) {
    const index = state.queue.findIndex((task) => task.id === id);
    if (index < 0 || state.queue[index].status !== "queued") return false;
    const [task] = state.queue.splice(index, 1);
    state.queue.unshift(task);
    pending.structureChanged = true;
    bridge.prioritizeTask(id).catch(refreshTasks);
    return true;
  },

  clearCompleted() {
    state.queue = state.queue.filter((task) => task.status !== "completed");
    pending.structureChanged = true;
    bridge.clearCompleted().catch(refreshTasks);
  },

  clearQueue() {
    bridge
      .clearTasks()
      .then(refreshTasks)
      .catch(refreshTasks);
  },

  async reAddFromHistory(entry) {
    if (entry.kind === "extras") {
      return this.addExtrasTask(
        {
          sourceUrl: `https://www.bilibili.com/video/${entry.bvid}`,
          bvid: entry.bvid,
          title: entry.title,
          up: entry.up,
          coverUrl: entry.coverUrl || null,
          coverPath: entry.coverPath || null,
          duration: entry.duration,
        },
        {
          danmakuTypes: entry.danmakuTypes || [],
          subtitles: entry.subtitles || [],
          danmakuCount: entry.danmakuCount || 0,
        },
        { qualityLabel: entry.baseQualityLabel || entry.qualityLabel || "" },
      );
    }

    const key = `${entry.bvid}::video::${entry.quality}`;
    if (pendingEnqueues.has(key)) {
      return { ok: false, reason: "in_flight", message: "正在加入队列，请稍候。" };
    }
    if (this.findDuplicate(entry.bvid, entry.quality, "video")) {
      return {
        ok: false,
        reason: "duplicate",
        message: "相同视频与清晰度已在队列中；请先移除后再试。",
      };
    }
    pendingEnqueues.add(key);
    try {
      const raw = await bridge.enqueueTask({
        kind: "video",
        sourceUrl: `https://www.bilibili.com/video/${entry.bvid}`,
        bvid: entry.bvid,
        formatId: entry.quality,
        qualityLabel: entry.qualityLabel,
        container: String(entry.format || "mp4").toLowerCase(),
        title: entry.title,
        uploader: entry.up,
        coverUrl: entry.coverUrl || null,
        coverPath: entry.coverPath || null,
        durationSeconds: durationToSeconds(entry.duration),
        sizeBytes: Math.round((Number(entry.sizeMB) || 0) * 1_000_000),
        danmakuTypes: entry.danmakuTypes || [],
        danmakuCount: entry.danmakuCount || 0,
        subtitleLangs: entry.subtitles || [],
      });
      const task = mapTask(raw);
      upsertTask(state.queue, task);
      pending.structureChanged = true;
      return { ok: true, task };
    } catch (error) {
      return { ok: false, reason: error?.code || "download_failed", message: error?.message || String(error) };
    } finally {
      pendingEnqueues.delete(key);
    }
  },

  async removeHistory(id, { deleteFile = false } = {}) {
    try {
      const result = await bridge.deleteHistory(id, deleteFile);
      state.history = state.history.filter((entry) => entry.id !== id);
      pending.structureChanged = true;
      return {
        ok: true,
        fileDeleted: result.fileDeleted === true,
        fileError: result.fileError || null,
      };
    } catch (error) {
      refreshHistorySoon();
      return {
        ok: false,
        message: error?.message || error?.payload?.message || String(error),
      };
    }
  },

  clearHistory() {
    state.history = [];
    pending.structureChanged = true;
    bridge.clearHistory().catch(() => {});
  },

  updateHistory() {
    refreshHistorySoon();
  },

  resetDemo() {
    refreshTasks();
    refreshHistorySoon();
  },

  formatFilename(entry, templateOverride = null) {
    const now = new Date(entry?.completedAt || Date.now());
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const template = templateOverride ?? state.settings.filenameTemplate ?? "{title} [{quality}]";
    const base = expandFilenameTemplate(
      template,
      { ...entry, qualityLabel: entry?.qualityLabel || "auto" },
      date,
    );
    const extension = entry?.format === "MP3" ? "mp3" : "mp4";
    return `${sanitizeFilenameBase(base)}.${extension}`;
  },

  flush() {
    void reconcile({ force: true });
  },
};
