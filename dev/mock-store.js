import {
  DANMAKU_TYPE_IDS,
  DEFAULT_QUALITY_ID,
  DEFAULT_SETTINGS,
  SUBTITLE_IDS,
  availableDanmakuTypes,
  isQualityAllowedForTier,
  isQualityId,
  qualityMeta,
  expandFilenameTemplate,
  selectedDanmakuCount,
} from "/js/catalog.js";
import { applySettingsPatch, hydrateSettings } from "/js/settings-schema.js";
import { createSeedState } from "/dev/demo-data.js";

const STORAGE_KEY = "bilipocket.prototype.v1";
const STORAGE_VERSION = 1;
const HISTORY_LIMIT = 30;
const TICK_SECONDS = 0.8;
const MAX_FILENAME_BASE = 120;
const RESERVED_FILENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

let persistTimer = null;
let storageBroken = false;

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function normalizeIdList(value, allowed) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => allowed.includes(id)))];
}

function normalizeExtras(raw) {
  const danmakuTypes = normalizeIdList(raw?.danmakuTypes, DANMAKU_TYPE_IDS);
  const subtitles = normalizeIdList(raw?.subtitles, SUBTITLE_IDS);
  const count = Number(raw?.danmakuCount);

  return {
    danmakuTypes,
    danmakuCount: danmakuTypes.length && Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0,
    subtitles,
  };
}

function resolveSelection(source, selection) {
  const counts =
    source?.danmakuTypeCounts && typeof source.danmakuTypeCounts === "object"
      ? source.danmakuTypeCounts
      : null;
  const availableTypeIds = counts
    ? availableDanmakuTypes(counts).map((type) => type.id)
    : DANMAKU_TYPE_IDS;
  const availableSubtitleIds = Array.isArray(source?.subtitles) ? source.subtitles : SUBTITLE_IDS;
  const hasSelection = selection && typeof selection === "object";
  const danmakuTypes =
    hasSelection && Array.isArray(selection.danmakuTypes)
      ? normalizeIdList(selection.danmakuTypes, availableTypeIds)
      : [...availableTypeIds];
  const subtitles =
    hasSelection && Array.isArray(selection.subtitles)
      ? normalizeIdList(selection.subtitles, availableSubtitleIds)
      : [...availableSubtitleIds];

  const suppliedCount = Number(selection?.danmakuCount);
  let danmakuCount = 0;
  if (danmakuTypes.length) {
    if (hasSelection && Number.isFinite(suppliedCount)) {
      danmakuCount = Math.max(0, Math.round(suppliedCount));
    } else if (counts) {
      danmakuCount = selectedDanmakuCount(counts, danmakuTypes);
    }
  }

  return { danmakuTypes, danmakuCount, subtitles };
}

function sanitizeFilenameBase(value) {
  let base = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  base = Array.from(base).slice(0, MAX_FILENAME_BASE).join("").trim().replace(/[. ]+$/g, "");

  if (!base) base = "示例视频";
  if (RESERVED_FILENAME.test(base)) base = `_${base}`;
  return base;
}

function safeCover(value) {
  const cover = typeof value === "string" ? value : "";
  return cover.startsWith("/dev/assets/covers/")
    ? cover
    : "/dev/assets/covers/cover-sunset.svg";
}

function normalizeSettings(raw) {
  // 字段白名单、默认值与枚举回退都在 settings-schema.js，这里只补 demo 端特有的档位规则。
  return hydrateSettings(raw, { surface: "demo", isQualityAllowed: isQualityAllowedForTier });
}

function normalizeTask(raw) {
  if (!raw || typeof raw !== "object") return null;

  const sizeMB = Number(raw.sizeMB);
  if (!Number.isFinite(sizeMB) || sizeMB <= 0) return null;

  const statuses = ["downloading", "paused", "queued", "failed", "cancelled", "completed"];
  const status = statuses.includes(raw.status) ? raw.status : "paused";
  const kind = raw.kind === "extras" ? "extras" : "video";
  const quality =
    kind === "extras" ? "extras" : isQualityId(raw.quality) ? raw.quality : DEFAULT_QUALITY_ID;
  const meta =
    kind === "extras"
      ? { id: "extras", label: "附加内容", format: "附加文件" }
      : qualityMeta(quality);
  const downloaded = Number(raw.downloadedMB);

  return {
    id: typeof raw.id === "string" ? raw.id : uid("task"),
    kind,
    bvid: typeof raw.bvid === "string" ? raw.bvid : "BV1xx411c7mD",
    title: typeof raw.title === "string" ? raw.title : "未命名视频",
    up: typeof raw.up === "string" ? raw.up : "未知 UP 主",
    cover: safeCover(raw.cover),
    duration: typeof raw.duration === "string" ? raw.duration : "00:00",
    quality,
    qualityLabel: meta.label,
    baseQualityLabel:
      typeof raw.baseQualityLabel === "string" ? raw.baseQualityLabel : meta.label,
    format: meta.format,
    sizeMB,
    downloadedMB:
      status === "completed" ? sizeMB : Number.isFinite(downloaded) ? clamp(downloaded, 0, sizeMB) : 0,
    speed: status === "downloading" && Number.isFinite(Number(raw.speed)) ? Number(raw.speed) : 0,
    speedBase: Number.isFinite(Number(raw.speedBase)) ? Number(raw.speedBase) : randomBetween(8, 14),
    status,
    error: typeof raw.error === "string" ? raw.error : null,
    extrasError: typeof raw.extrasError === "string" ? raw.extrasError : null,
    addedAt: Number(raw.addedAt) || Date.now(),
    queuedAt: Number(raw.queuedAt) || null,
    startedAt: Number(raw.startedAt) || null,
    completedAt: Number(raw.completedAt) || null,
    ...normalizeExtras(raw),
  };
}

function normalizeHistory(raw) {
  if (!raw || typeof raw !== "object") return null;

  const sizeMB = Number(raw.sizeMB);
  if (!Number.isFinite(sizeMB) || sizeMB <= 0) return null;

  const kind = raw.kind === "extras" ? "extras" : "video";
  const quality =
    kind === "extras" ? "extras" : isQualityId(raw.quality) ? raw.quality : DEFAULT_QUALITY_ID;
  const meta =
    kind === "extras"
      ? { id: "extras", label: "附加内容", format: "附加文件" }
      : qualityMeta(quality);

  return {
    id: typeof raw.id === "string" ? raw.id : uid("hist"),
    kind,
    taskId: typeof raw.taskId === "string" ? raw.taskId : null,
    bvid: typeof raw.bvid === "string" ? raw.bvid : "BV1xx411c7mD",
    title: typeof raw.title === "string" ? raw.title : "未命名视频",
    up: typeof raw.up === "string" ? raw.up : "未知 UP 主",
    cover: safeCover(raw.cover),
    duration: typeof raw.duration === "string" ? raw.duration : "00:00",
    quality,
    qualityLabel: meta.label,
    baseQualityLabel:
      typeof raw.baseQualityLabel === "string" ? raw.baseQualityLabel : meta.label,
    format: meta.format,
    sizeMB,
    extrasError: typeof raw.extrasError === "string" ? raw.extrasError : null,
    completedAt: Number(raw.completedAt) || Date.now(),
    ...normalizeExtras(raw),
  };
}

function readStorage() {
  if (storageBroken) return null;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== STORAGE_VERSION) return null;
    if (!Array.isArray(parsed.queue) || !Array.isArray(parsed.history)) return null;

    return {
      settings: normalizeSettings(parsed.settings),
      queue: parsed.queue.map(normalizeTask).filter(Boolean),
      history: parsed.history.map(normalizeHistory).filter(Boolean).slice(0, HISTORY_LIMIT),
    };
  } catch (error) {
    console.warn("[BiliPocket] 本地数据读取失败，将使用新的演示数据。", error);
    return null;
  }
}

function saveNow() {
  if (storageBroken) return;

  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }

  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: STORAGE_VERSION,
        settings,
        queue,
        history,
      }),
    );
  } catch (error) {
    storageBroken = true;
    console.warn("[BiliPocket] 无法写入 localStorage，进度将只保留在当前会话。", error);
  }
}

function scheduleSave(immediate = false) {
  if (storageBroken) return;

  if (immediate) {
    saveNow();
    return;
  }

  if (!persistTimer) {
    persistTimer = setTimeout(saveNow, 1200);
  }
}

/* State is kept at module scope so the UI layer never mutates it directly. */
let state = null;
let settings = { ...DEFAULT_SETTINGS };
let queue = [];
let history = [];

function completeTask(task, now) {
  task.status = "completed";
  task.downloadedMB = task.sizeMB;
  task.speed = 0;
  task.error = null;
  task.completedAt = now;

  if (!history.some((entry) => entry.taskId === task.id)) {
    const kind = task.kind === "extras" ? "extras" : "video";
    const meta =
      kind === "extras"
        ? { id: "extras", label: "附加内容", format: "附加文件" }
        : qualityMeta(task.quality);
    history.unshift({
      id: uid("hist"),
      kind,
      taskId: task.id,
      bvid: task.bvid,
      title: task.title,
      up: task.up,
      cover: task.cover,
      duration: task.duration,
      quality: meta.id,
      qualityLabel: meta.label,
      baseQualityLabel: task.baseQualityLabel || meta.label,
      format: meta.format,
      sizeMB: task.sizeMB,
      danmakuTypes: [...(task.danmakuTypes || [])],
      danmakuCount: Number(task.danmakuCount) || 0,
      subtitles: [...(task.subtitles || [])],
      extrasError: task.extrasError || null,
      completedAt: now,
    });
    if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
  }
}

function lastIndexOfStatus(status) {
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (queue[index].status === status) return index;
  }
  return -1;
}

function insertQueuedTask(task) {
  const lastQueued = lastIndexOfStatus("queued");
  if (lastQueued >= 0) {
    queue.splice(lastQueued + 1, 0, task);
    return;
  }
  queue.splice(lastIndexOfStatus("downloading") + 1, 0, task);
}

function moveToQueuedEnd(task) {
  const index = queue.indexOf(task);
  if (index >= 0) queue.splice(index, 1);
  insertQueuedTask(task);
}

function promoteQueued(now = Date.now()) {
  let slots = Math.max(0, settings.maxConcurrent - queue.filter((task) => task.status === "downloading").length);
  if (slots <= 0) return false;

  let changed = false;
  for (const task of queue) {
    if (slots <= 0) break;
    if (task.status !== "queued") continue;
    if (task.queuedAt && task.queuedAt > now) continue;

    task.status = "downloading";
    task.error = null;
    task.startedAt = task.startedAt || now;
    task.speedBase = clamp(Number(task.speedBase) || randomBetween(8, 15), 5, 19);
    task.speed = task.speedBase;
    slots -= 1;
    changed = true;
  }

  return changed;
}

export const store = {
  init() {
    const saved = readStorage();
    if (saved) {
      settings = saved.settings;
      queue = saved.queue;
      history = saved.history;
    } else {
      const seed = createSeedState();
      settings = seed.settings;
      queue = seed.queue;
      history = seed.history;
      saveNow();
    }

    state = { settings, queue, history };
    return state;
  },

  getState() {
    return state;
  },

  get dataDirectory() {
    return "浏览器预览 · localStorage";
  },

  get autostartEnabled() {
    return false;
  },

  get isPortable() {
    return false;
  },

  async setAutostart() {
    return { ok: false, message: "浏览器预览不支持开机自启。" };
  },

  activeCount() {
    return queue.filter((task) => task.status === "downloading").length;
  },

  pendingCount() {
    return queue.filter((task) => ["downloading", "queued", "paused", "failed"].includes(task.status)).length;
  },

  totalSpeed() {
    return queue
      .filter((task) => task.status === "downloading")
      .reduce((sum, task) => sum + (Number(task.speed) || 0), 0);
  },

  findDuplicate(bvid, quality, kind = "video") {
    return queue.find(
      (task) =>
        task.bvid === bvid &&
        (task.kind || "video") === kind &&
        (kind === "extras" || task.quality === quality) &&
        task.status !== "completed" &&
        task.status !== "cancelled",
    );
  },

  addTask(source, qualityId, selection = null) {
    if (!isQualityId(qualityId)) {
      return { ok: false, reason: "unavailable" };
    }

    const meta = qualityMeta(qualityId);
    const duplicate = this.findDuplicate(source.bvid, qualityId, "video");
    if (duplicate) {
      return { ok: false, reason: "duplicate", task: duplicate };
    }

    const hasSizes = source?.sizes && typeof source.sizes === "object";
    const sizeMB = hasSizes ? Number(source.sizes[qualityId]) : Number(source?.sizeMB);
    if (!Number.isFinite(sizeMB) || sizeMB <= 0) {
      return { ok: false, reason: "unavailable" };
    }

    const now = Date.now();
    const canStart = this.activeCount() < settings.maxConcurrent;
    const extras = resolveSelection(source, selection);

    const task = {
      id: uid("task"),
      kind: "video",
      bvid: String(source?.bvid || "BV1xx411c7mD"),
      title: String(source?.title || "未命名视频"),
      up: String(source?.up || "未知 UP 主"),
      cover: safeCover(source?.cover),
      duration: String(source?.duration || "00:00"),
      quality: meta.id,
      qualityLabel: meta.label,
      baseQualityLabel: meta.label,
      format: meta.format,
      sizeMB,
      ...extras,
      downloadedMB: 0,
      speed: canStart ? randomBetween(8, 15) : 0,
      speedBase: randomBetween(8, 15),
      status: canStart ? "downloading" : "queued",
      error: null,
      extrasError: null,
      addedAt: now,
      queuedAt: now,
      startedAt: canStart ? now : null,
      completedAt: null,
    };

    queue.unshift(task);
    if (!canStart) moveToQueuedEnd(task);
    scheduleSave(true);
    return { ok: true, task };
  },

  addExtrasTask(source, selection = {}, options = {}) {
    const extras = resolveSelection(source, selection);
    if (!extras.danmakuTypes.length && !extras.subtitles.length) {
      return { ok: false, reason: "no_extras", message: "请先选择弹幕类型或字幕语言。" };
    }
    const duplicate = this.findDuplicate(source.bvid, "extras", "extras");
    if (duplicate) {
      return { ok: false, reason: "duplicate", task: duplicate };
    }

    const now = Date.now();
    const canStart = this.activeCount() < settings.maxConcurrent;
    const sizeMB = 0.02;
    const task = {
      id: uid("task"),
      kind: "extras",
      bvid: String(source?.bvid || "BV1xx411c7mD"),
      title: String(source?.title || "未命名视频"),
      up: String(source?.up || "未知 UP 主"),
      cover: safeCover(source?.cover),
      duration: String(source?.duration || "00:00"),
      quality: "extras",
      qualityLabel: "附加内容",
      baseQualityLabel: String(options.qualityLabel || source?.baseQualityLabel || "附加内容"),
      format: "附加文件",
      sizeMB,
      ...extras,
      downloadedMB: 0,
      speed: canStart ? randomBetween(8, 15) : 0,
      speedBase: randomBetween(8, 15),
      status: canStart ? "downloading" : "queued",
      error: null,
      extrasError: null,
      addedAt: now,
      queuedAt: now,
      startedAt: canStart ? now : null,
      completedAt: null,
    };

    queue.unshift(task);
    if (!canStart) moveToQueuedEnd(task);
    scheduleSave(true);
    return { ok: true, task };
  },

  pauseTask(id) {
    const task = queue.find((item) => item.id === id);
    if (!task || !["downloading", "queued"].includes(task.status)) return false;

    task.status = "paused";
    task.speed = 0;
    scheduleSave(true);
    return true;
  },

  resumeTask(id) {
    const task = queue.find((item) => item.id === id);
    if (!task || task.status !== "paused") return false;

    task.status = "queued";
    task.queuedAt = Date.now();
    task.speed = 0;
    moveToQueuedEnd(task);
    promoteQueued();
    scheduleSave(true);
    return true;
  },

  cancelTask(id, { deletePartial = false } = {}) {
    const task = queue.find((item) => item.id === id);
    if (!task || !["downloading", "queued", "paused"].includes(task.status)) {
      return { ok: false, message: "任务状态不允许取消。" };
    }

    task.status = "cancelled";
    task.speed = 0;
    task.error = "任务已取消";
    task.completedAt = Date.now();
    promoteQueued();
    scheduleSave(true);
    return {
      ok: true,
      task,
      partialDeleted: false,
      deleteError: null,
      preview: !deletePartial,
    };
  },

  retryTask(id) {
    const task = queue.find((item) => item.id === id);
    if (!task || !["failed", "cancelled"].includes(task.status)) return false;

    task.status = "queued";
    task.downloadedMB = 0;
    task.speed = 0;
    task.error = null;
    task.startedAt = null;
    task.completedAt = null;
    task.queuedAt = Date.now();
    moveToQueuedEnd(task);
    promoteQueued();
    scheduleSave(true);
    return true;
  },

  prioritizeTask(id) {
    const index = queue.findIndex((task) => task.id === id);
    if (index < 0 || queue[index].status !== "queued") return false;

    const [task] = queue.splice(index, 1);
    task.queuedAt = Date.now();

    const nextQueuedIndex = queue.findIndex((item) => item.status === "queued");
    queue.splice(nextQueuedIndex < 0 ? queue.length : nextQueuedIndex, 0, task);

    promoteQueued();
    scheduleSave(true);
    return true;
  },

  removeTask(id, { deleteFile = false } = {}) {
    const index = queue.findIndex((task) => task.id === id);
    if (index < 0) return { ok: false, message: "任务不存在。" };

    queue.splice(index, 1);
    scheduleSave(true);
    return { ok: true, fileDeleted: false, fileError: null, preview: !deleteFile };
  },

  pauseAll() {
    let count = 0;
    for (const task of queue) {
      if (task.status === "downloading" || task.status === "queued") {
        task.status = "paused";
        task.speed = 0;
        count += 1;
      }
    }
    if (count) scheduleSave(true);
    return count;
  },

  resumeAll() {
    const now = Date.now();
    let count = 0;
    for (const task of queue) {
      if (task.status === "paused") {
        task.status = "queued";
        task.queuedAt = now;
        task.speed = 0;
        count += 1;
      }
    }
    if (count) {
      promoteQueued(now);
      scheduleSave(true);
    }
    return count;
  },

  clearCompleted() {
    const before = queue.length;
    queue = queue.filter((task) => task.status !== "completed");
    const count = before - queue.length;
    state.queue = queue;
    if (count) scheduleSave(true);
    return count;
  },

  clearQueue() {
    const count = queue.length;
    if (!count) return 0;

    queue = [];
    state.queue = queue;
    scheduleSave(true);
    return count;
  },

  removeHistory(id, { deleteFile = false } = {}) {
    const before = history.length;
    history = history.filter((entry) => entry.id !== id);
    state.history = history;
    const removed = before !== history.length;
    if (removed) scheduleSave(true);
    return {
      ok: removed,
      fileDeleted: false,
      fileError: removed ? null : "历史记录不存在。",
      preview: !deleteFile,
    };
  },

  clearHistory() {
    const count = history.length;
    history = [];
    state.history = history;
    if (count) scheduleSave(true);
    return count;
  },

  reAddFromHistory(entry) {
    if (entry.kind === "extras") {
      return this.addExtrasTask(
        {
          bvid: entry.bvid,
          title: entry.title,
          up: entry.up,
          cover: entry.cover,
          duration: entry.duration,
          baseQualityLabel: entry.baseQualityLabel,
        },
        {
          danmakuTypes: entry.danmakuTypes,
          danmakuCount: entry.danmakuCount,
          subtitles: entry.subtitles,
        },
        { qualityLabel: entry.baseQualityLabel },
      );
    }
    return this.addTask(
      {
        bvid: entry.bvid,
        title: entry.title,
        up: entry.up,
        cover: entry.cover,
        duration: entry.duration,
        sizeMB: entry.sizeMB,
      },
      entry.quality,
      {
        danmakuTypes: entry.danmakuTypes,
        danmakuCount: entry.danmakuCount,
        subtitles: entry.subtitles,
      },
    );
  },

  updateSettings(patch) {
    if (!patch || typeof patch !== "object") return settings;

    const previousConcurrency = settings.maxConcurrent;
    // 字段级归一（含枚举白名单、数值 clamp、清晰度与档位的兼容回落）统一走 schema。
    const next = applySettingsPatch(settings, patch, {
      surface: "demo",
      isQualityAllowed: isQualityAllowedForTier,
    });

    settings = next;
    state.settings = settings;

    if (next.maxConcurrent < previousConcurrency) {
      const downloading = queue
        .filter((task) => task.status === "downloading")
        .sort((a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0));

      for (const task of downloading.slice(next.maxConcurrent)) {
        task.status = "paused";
        task.speed = 0;
      }
    }

    if (next.maxConcurrent !== previousConcurrency) {
      promoteQueued();
    }

    scheduleSave(true);
    return settings;
  },

  resetDemo() {
    const seed = createSeedState();
    queue = seed.queue;
    history = seed.history;
    state.queue = queue;
    state.history = history;
    saveNow();
    return state;
  },

  tick(now = Date.now()) {
    let structureChanged = promoteQueued(now);
    let progressChanged = false;
    const completed = [];

    for (const task of queue) {
      if (task.status !== "downloading") continue;

      const base = clamp(Number(task.speedBase) || randomBetween(8, 15), 5, 19);
      task.speedBase = clamp(base + randomBetween(-0.7, 0.7), 5, 19);
      task.speed = clamp(task.speedBase + randomBetween(-1.1, 1.1), 2.6, 20);

      const before = task.downloadedMB;
      task.downloadedMB = Math.min(task.sizeMB, before + task.speed * TICK_SECONDS);
      if (task.downloadedMB > before) progressChanged = true;

      if (task.sizeMB - task.downloadedMB <= 0.05) {
        completeTask(task, now);
        completed.push(task);
        structureChanged = true;
      }
    }

    if (structureChanged || progressChanged || completed.length) {
      scheduleSave(completed.length > 0);
    }

    return { structureChanged, progressChanged, completed };
  },

  formatFilename(entry, templateOverride = null) {
    const now = new Date(entry?.completedAt || Date.now());
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const quality = entry?.qualityLabel || qualityMeta(entry?.quality).label;
    const extension = entry?.format === "MP3" ? "mp3" : "mp4";
    const template = templateOverride ?? settings.filenameTemplate ?? DEFAULT_SETTINGS.filenameTemplate;
    const base = expandFilenameTemplate(
      template,
      { ...entry, qualityLabel: quality || DEFAULT_QUALITY_ID },
      date,
    );

    return `${sanitizeFilenameBase(base)}.${extension}`;
  },

  flush() {
    saveNow();
  },
};
