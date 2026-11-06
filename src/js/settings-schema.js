// @ts-check
// 设置项的单一事实源。
//
// 背景：这些字段此前在 6 处各自手写一份（catalog 默认值、store-desktop 的初始 state /
// mapSettings / updateSettings 请求体 / 旧版迁移、mock-store 的 normalize / update），
// 漏改一处就会出现「桌面端生效、浏览器预览不生效」。这里把字段定义集中到 schema，
// 另外几处只调用下面的纯函数。
//
// 约束：本文件不得 import 其他业务模块（避免与 catalog.js 成环），跨字段规则通过
// 调用方传入的 `isQualityAllowed` 回调表达。

const AUTO_QUALITY = "auto";

/** 数值字段的钳制。 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 字段描述符：
 * - key         前端字段名
 * - rust        对应 Rust `Settings` 的 snake_case 字段名；null 表示纯前端字段，不进 wire
 * - kind        int / bool / enum / string / path
 * - default     前端默认值
 * - surfaceDefaults  按端覆盖的默认值（desktop / demo）
 * - values/fallback  枚举白名单与回退值
 * - min/max     数值边界
 * - legacy      是否属于旧原型迁移的字段子集
 * - fixed       指定端上恒定的值（例如桌面端 accountTier 恒为 guest）
 */
export const SETTINGS_SCHEMA = [
  { key: "theme", rust: "theme", kind: "enum", default: "light", values: ["light", "dark", "system"], fallback: "light", legacy: true },
  { key: "downloadDir", rust: "download_dir", kind: "path", default: "C:\\Users\\Public\\Videos\\BiliPocket", surfaceDefaults: { desktop: "" }, legacy: true },
  { key: "maxConcurrent", rust: "max_concurrent", kind: "int", default: 2, min: 1, max: 5, legacy: true },
  { key: "rateLimitKbps", rust: "rate_limit_kbps", kind: "int", default: 0, min: 0, max: 102400, legacy: true },
  { key: "filenameTemplate", rust: "filename_template", kind: "string", default: "{title} [{quality}]", legacy: true },
  { key: "preferredQuality", rust: "preferred_quality", kind: "string", default: AUTO_QUALITY, legacy: true },
  { key: "accountTier", rust: null, kind: "enum", default: "guest", values: ["guest", "member", "vip"], fallback: "guest", fixed: { desktop: "guest" } },
  { key: "notifyOnComplete", rust: "notify_on_complete", kind: "bool", default: true, legacy: true },
  { key: "minimizeToTray", rust: "minimize_to_tray", kind: "bool", default: false, legacy: true },
  { key: "defaultDanmaku", rust: "default_danmaku", kind: "bool", default: true },
  { key: "defaultSubtitles", rust: "default_subtitles", kind: "bool", default: true },
  { key: "authorizedAccepted", rust: "authorized_accepted", kind: "bool", default: false },
  { key: "retryMax", rust: "retry_max", kind: "int", default: 3, min: 0, max: 10 },
  { key: "retryBaseSeconds", rust: "retry_base_seconds", kind: "int", default: 15, min: 3, max: 300 },
  { key: "fragmentRetries", rust: "fragment_retries", kind: "int", default: 5, min: 0, max: 20 },
  { key: "saveCover", rust: "save_cover", kind: "bool", default: false },
  { key: "coverNaming", rust: "cover_naming", kind: "enum", default: "poster", values: ["poster", "stem"], fallback: "poster" },
  { key: "subtitleFormat", rust: "subtitle_format", kind: "enum", default: "srt", values: ["srt", "ass"], fallback: "srt" },
  { key: "writeChapters", rust: "write_chapters", kind: "bool", default: false },
  { key: "saveNfo", rust: "save_nfo", kind: "bool", default: false },
  { key: "nfoTitleSource", rust: "nfo_title_source", kind: "enum", default: "video", values: ["video", "page", "combined"], fallback: "video" },
];

export const SETTINGS_KEYS = SETTINGS_SCHEMA.map((field) => field.key);

/** 前端默认设置（冻结，避免调用方就地改写）。 */
export const DEFAULT_SETTINGS = Object.freeze(
  Object.fromEntries(SETTINGS_SCHEMA.map((field) => [field.key, field.default])),
);

function fieldDefault(field, surface) {
  return field.surfaceDefaults?.[surface] ?? field.default;
}

/** 单项归一：任何异常输入都退回默认值，不抛错。 */
function coerceValue(field, raw, fallback) {
  switch (field.kind) {
    case "int": {
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) return fallback;
      return clamp(Math.round(numeric), field.min ?? 0, field.max ?? Number.MAX_SAFE_INTEGER);
    }
    case "bool":
      return typeof raw === "boolean" ? raw : fallback;
    case "enum":
      return field.values.includes(raw) ? raw : field.fallback;
    case "string": {
      const text = typeof raw === "string" ? raw.trim() : "";
      return text || fallback;
    }
    case "path": {
      const text = typeof raw === "string" ? raw.trim() : "";
      return text || fallback;
    }
    default:
      return fallback;
  }
}

/**
 * 全量归一（用于从后端 / localStorage 载入）。
 * @param {unknown} raw
 * @param {{ surface: "desktop" | "demo", isQualityAllowed?: (quality: string, tier: string) => boolean }} options
 */
export function hydrateSettings(raw, options) {
  const { surface, isQualityAllowed } = options;
  const saved = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const field of SETTINGS_SCHEMA) {
    const fallback = fieldDefault(field, surface);
    const fixed = field.fixed?.[surface];
    result[field.key] = fixed !== undefined ? fixed : coerceValue(field, saved[field.key], fallback);
  }
  return applyQualityRule(result, isQualityAllowed);
}

/** 清晰度必须与账号档位兼容，否则回落到 auto（仅 demo 端启用，与改动前一致）。 */
function applyQualityRule(settings, isQualityAllowed) {
  if (!isQualityAllowed) return settings;
  const tier = String(settings.accountTier ?? "guest");
  const quality = String(settings.preferredQuality ?? AUTO_QUALITY);
  if (quality !== AUTO_QUALITY && !isQualityAllowed(quality, tier)) {
    settings.preferredQuality = AUTO_QUALITY;
  }
  return settings;
}

/**
 * 真 patch：只改出现的键，未出现的键保持不变。
 * 供 mock-store 的 updateSettings 使用（桌面端的 patch 最终以整份 wire 提交）。
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} patch
 * @param {{ surface: "desktop" | "demo", isQualityAllowed?: (quality: string, tier: string) => boolean }} options
 */
export function applySettingsPatch(base, patch, options) {
  const { surface, isQualityAllowed } = options;
  const source = patch && typeof patch === "object" ? patch : {};
  const next = { ...base };
  for (const field of SETTINGS_SCHEMA) {
    const raw = source[field.key];
    if (raw === undefined) continue;
    const fixed = field.fixed?.[surface];
    if (fixed !== undefined) {
      next[field.key] = fixed;
      continue;
    }
    if (field.kind === "path") {
      // 空值视为「不改」：清空下载目录没有意义，后端也会回退到默认目录。
      const text = typeof raw === "string" ? raw.trim() : "";
      if (text) next[field.key] = text;
      continue;
    }
    if (field.kind === "bool") {
      next[field.key] = Boolean(raw);
      continue;
    }
    next[field.key] = coerceValue(field, raw, fieldDefault(field, surface));
  }
  return applyQualityRule(next, isQualityAllowed);
}

/** 提交给 Rust 的请求体：跳过纯前端字段，保证键集与 `Settings` 结构体一一对应。 */
export function toWireSettings(settings) {
  /** @type {Record<string, unknown>} */
  const wire = {};
  for (const field of SETTINGS_SCHEMA) {
    if (!field.rust) continue;
    wire[field.key] = settings[field.key];
  }
  return wire;
}

/** 旧原型设置迁移：只挑 schema 标记了 legacy 且原值本身合法的字段。 */
export function legacySettingsPatch(saved) {
  const source = saved && typeof saved === "object" ? saved : {};
  /** @type {Record<string, unknown>} */
  const patch = {};
  for (const field of SETTINGS_SCHEMA) {
    if (!field.legacy) continue;
    const raw = source[field.key];
    if (raw === undefined || raw === null) continue;
    switch (field.kind) {
      case "enum":
        if (field.values.includes(raw)) patch[field.key] = raw;
        break;
      case "bool":
        if (typeof raw === "boolean") patch[field.key] = raw;
        break;
      case "int": {
        const numeric = Number.parseInt(String(raw), 10);
        if (Number.isFinite(numeric) && numeric >= (field.min ?? 0)) patch[field.key] = numeric;
        break;
      }
      default: {
        const text = typeof raw === "string" ? raw.trim() : "";
        if (text) patch[field.key] = text;
        break;
      }
    }
  }
  return patch;
}
