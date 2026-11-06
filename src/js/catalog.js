// @ts-check
// 共享常量与纯函数：桌面端与 dev 演示入口共用，不含任何虚构视频数据。

export const QUALITY_OPTIONS = [
  { id: "8K", label: "8K", detail: "MP4 · H.265", requiredTier: "vip" },
  { id: "4K", label: "4K", detail: "MP4 · H.265", requiredTier: "vip" },
  { id: "1080P60", label: "1080P60", detail: "MP4 · 60fps", requiredTier: "vip" },
  { id: "1080P+", label: "1080P+", detail: "MP4 · 高码率", requiredTier: "vip" },
  { id: "1080P", label: "1080P", detail: "MP4 · H.264", requiredTier: "member" },
  { id: "720P", label: "720P", detail: "MP4 · H.264", requiredTier: "guest" },
  { id: "480P", label: "480P", detail: "MP4 · H.264", requiredTier: "guest" },
  { id: "360P", label: "360P", detail: "MP4 · H.264", requiredTier: "guest" },
  { id: "audio", label: "仅音频", detail: "MP3 · 320 kbps", requiredTier: "guest", audio: true },
];

export const ACCOUNT_TIERS = [
  { id: "guest", label: "未登录" },
  { id: "member", label: "已登录" },
  { id: "vip", label: "大会员" },
];

export const AUTO_QUALITY = "auto";
export const DEFAULT_QUALITY_ID = "1080P";
export const QUALITY_IDS = QUALITY_OPTIONS.map((option) => option.id);
export const ACCOUNT_TIER_IDS = ACCOUNT_TIERS.map((tier) => tier.id);
const TIER_RANK = { guest: 0, member: 1, vip: 2 };

export function accountTierMeta(id) {
  return ACCOUNT_TIERS.find((tier) => tier.id === id) || ACCOUNT_TIERS[0];
}

export function qualityOption(id) {
  return QUALITY_OPTIONS.find((option) => option.id === id) || null;
}

export function isQualityId(id) {
  return QUALITY_IDS.includes(id);
}

export function qualityAccess(id, accountTier = "guest") {
  const option = qualityOption(id);
  if (!option) return { accessible: false, reason: "不可用" };

  const currentRank = TIER_RANK[accountTier] ?? TIER_RANK.guest;
  const requiredRank = TIER_RANK[option.requiredTier] ?? TIER_RANK.guest;
  if (currentRank >= requiredRank) return { accessible: true, reason: "" };

  return {
    accessible: false,
    reason: option.requiredTier === "member" ? "登录后可下载" : "大会员专享",
  };
}

export function isQualityAllowedForTier(id, accountTier = "guest") {
  return Boolean(qualityOption(id)) && qualityAccess(id, accountTier).accessible;
}

export function supportedQualityOptions(video) {
  const sizes = video?.sizes;
  if (!sizes || typeof sizes !== "object") return [];
  return QUALITY_OPTIONS.filter((option) => Number(sizes[option.id]) > 0);
}

export function accessibleQualityOptions(video, accountTier = "guest") {
  return supportedQualityOptions(video).filter((option) => qualityAccess(option.id, accountTier).accessible);
}

export function recommendedQualityId(video, accountTier = "guest") {
  const options = accessibleQualityOptions(video, accountTier);
  if (!options.length) return null;

  const standard = options.find((option) => option.id === DEFAULT_QUALITY_ID);
  if (standard) return standard.id;

  const videoOption = options.find((option) => !option.audio);
  return (videoOption || options[0]).id;
}

function nearestQualityId(options, targetId) {
  const targetIndex = QUALITY_IDS.indexOf(targetId);
  let best = options[0];
  let bestIndex = QUALITY_IDS.indexOf(best.id);
  let bestDistance = Math.abs(bestIndex - targetIndex);

  for (const option of options.slice(1)) {
    const index = QUALITY_IDS.indexOf(option.id);
    const distance = Math.abs(index - targetIndex);
    if (distance < bestDistance || (distance === bestDistance && index > bestIndex)) {
      best = option;
      bestIndex = index;
      bestDistance = distance;
    }
  }
  return best.id;
}

export function resolvePreferredQuality(video, preferredId = AUTO_QUALITY, accountTier = "guest") {
  const options = accessibleQualityOptions(video, accountTier);
  if (!options.length) return null;

  if (!preferredId || preferredId === AUTO_QUALITY || !isQualityId(preferredId)) {
    return recommendedQualityId(video, accountTier);
  }

  if (options.some((option) => option.id === preferredId)) return preferredId;
  return nearestQualityId(options, preferredId);
}

export const DANMAKU_TYPES = [
  { id: "scroll", label: "滚动弹幕", description: "从右向左滚动" },
  { id: "top", label: "顶部弹幕", description: "固定在画面顶部" },
  { id: "bottom", label: "底部弹幕", description: "固定在画面底部" },
  { id: "reverse", label: "逆向弹幕", description: "从左向右逆向滚动" },
  { id: "advanced", label: "高级弹幕", description: "定位与动画弹幕" },
];

export const SUBTITLE_OPTIONS = [
  { id: "zh-auto", label: "中文（自动生成）" },
  { id: "zh", label: "中文" },
  { id: "en", label: "English" },
  { id: "ja", label: "日本語" },
];

export const DANMAKU_TYPE_IDS = DANMAKU_TYPES.map((type) => type.id);
export const SUBTITLE_IDS = SUBTITLE_OPTIONS.map((track) => track.id);

export function danmakuTotal(counts = {}) {
  return DANMAKU_TYPES.reduce((sum, type) => {
    const count = Number(counts?.[type.id]);
    return sum + (Number.isFinite(count) && count > 0 ? count : 0);
  }, 0);
}

export function availableDanmakuTypes(counts = {}) {
  return DANMAKU_TYPES.filter((type) => Number(counts?.[type.id]) > 0);
}

export function selectedDanmakuCount(counts = {}, ids = []) {
  const selected = new Set(Array.isArray(ids) ? ids : []);
  return DANMAKU_TYPES.reduce((sum, type) => {
    if (!selected.has(type.id)) return sum;
    const count = Number(counts?.[type.id]);
    return sum + (Number.isFinite(count) && count > 0 ? count : 0);
  }, 0);
}

export function subtitleLabel(id) {
  return SUBTITLE_OPTIONS.find((track) => track.id === id)?.label || String(id || "");
}

// 默认值来自 settings-schema.js（单一事实源），这里只做转出以保持既有 import 路径不变。
export { DEFAULT_SETTINGS } from "./settings-schema.js";

export function qualityMeta(id) {
  const option = qualityOption(id) || qualityOption(DEFAULT_QUALITY_ID) || QUALITY_OPTIONS[0];
  return {
    id: option.id,
    label: option.label,
    format: option.audio ? "MP3" : "MP4",
  };
}

// 合集条目筛选：只按标题做大小写不敏感的包含匹配。
// 空关键词返回原数组（保持接口顺序），不做任何排序。
export function filterSeasonEpisodes(episodes, query) {
  const list = Array.isArray(episodes) ? episodes : [];
  const keyword = String(query ?? "")
    .trim()
    .toLowerCase();
  if (!keyword) return list;
  return list.filter((episode) =>
    String(episode?.title ?? "")
      .toLowerCase()
      .includes(keyword),
  );
}

/** 合集列表一次渲染多少条；超出部分按需追加。 */
export const SEASON_PAGE_SIZE = 200;

/**
 * 合集列表的渲染切片。
 * 只影响「渲染多少行」，不影响筛选与全选——那两者始终作用于完整筛选结果，
 * 否则用户会漏选没被渲染出来的条目。
 */
export function paginateSeason(episodes, limit) {
  const list = Array.isArray(episodes) ? episodes : [];
  const size = Number.isFinite(limit) && limit > 0 ? limit : SEASON_PAGE_SIZE;
  return {
    shown: list.slice(0, size),
    remaining: Math.max(0, list.length - size),
    limit: size,
    nextLimit: size + SEASON_PAGE_SIZE,
  };
}

// 全选 / 取消全选：只作用于「当前可见」的条目，而不是整个合集。
// 可见项全部已选时改为取消，否则补齐剩余——同一个按钮既能选也能取消。
// 不修改传入的 Set，返回新 Set，避免调用方状态被就地篡改。
export function toggleVisibleSelection(selected, visibleBvids) {
  const next = new Set(selected);
  const visible = (visibleBvids || []).filter(Boolean);
  if (visible.length === 0) return next;
  const allSelected = visible.every((bvid) => next.has(bvid));
  for (const bvid of visible) {
    if (allSelected) next.delete(bvid);
    else next.add(bvid);
  }
  return next;
}

// 与 Rust files.rs::render_template 保持一致的模板变量展开（用于实时预览）。
// 预览必须和真实落盘结果同源，否则用户看到的文件名和下载出来的不是一回事。
export function expandFilenameTemplate(template, entry, date) {
  // 后端 `published_at` 是秒（B 站 `pubdate` 原样），`completed_at` 是毫秒；
  // 这里统一归一化成毫秒，避免预览把发布时间算成 1970 年。
  const toMs = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return numeric < 1e12 ? numeric * 1000 : numeric;
  };
  const formatAt = (ms, format) => {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    const map = {
      Y: String(d.getFullYear()),
      m: pad(d.getMonth() + 1),
      d: pad(d.getDate()),
      H: pad(d.getHours()),
      M: pad(d.getMinutes()),
      S: pad(d.getSeconds()),
    };
    return String(format).replace(/%([YmdHMS])/g, (_, key) => map[key]);
  };
  const completedMs = toMs(entry?.completedAt);
  // `date` 是调用方给的「今天」字符串，仅在拿不到完成时间时兜底。
  const today = typeof date === "string" && date ? date : formatAt(Date.now(), "%Y-%m-%d");
  // 与 Rust 一致：没有发布时间就用完成时间，而不是留下字面量。
  const publishedMs = toMs(entry?.publishedAt) ?? completedMs ?? Date.now();
  const values = {
    title: entry?.title || "未命名视频",
    up: entry?.up || "未知UP主",
    quality: entry?.qualityLabel || "1080P",
    bvid: entry?.bvid || "BV1xx411c7mD",
    p: entry?.pageIndex != null ? String(entry.pageIndex) : "",
    p_title: entry?.pageTitle || "",
  };
  return String(template).replace(/\{([^{}]+)\}/g, (whole, token) => {
    const [name, format] = String(token).split(":");
    if (name === "date") {
      if (format) return formatAt(completedMs ?? Date.now(), format);
      return completedMs === null ? today : formatAt(completedMs, "%Y-%m-%d");
    }
    if (name === "pubdate") return formatAt(publishedMs, format || "%Y-%m-%d");
    if (Object.prototype.hasOwnProperty.call(values, name)) return values[name];
    return whole;
  });
}
