// @ts-check
// 清晰度网格：把档位矩阵渲染成可点选的卡片，只读入参不做状态写入。

import {
  accountTierMeta,
  isQualityAllowedForTier,
  qualityAccess,
  qualityOption,
  supportedQualityOptions,
} from "../catalog.js";
import { escapeHtml, icon } from "../ui.js";
import { recommendedQualityId } from "../catalog.js";
import { formatSize } from "../ui.js";

export function desktopQualityStatus(video) {
  const options = video.qualityOptions || [];
  if (!options.length) return "无可用清晰度";
  const accessible = options.filter((quality) => quality.accessible !== false).length;
  const locked = options.length - accessible;
  if (!accessible) return "真实解析 · 无可下载档位";
  return `真实解析 · ${accessible} 档可用${locked ? ` · ${locked} 档受限` : ""}`;
}

export function codecLabel(codec) {
  const value = String(codec || "").toLowerCase();
  if (!value || value === "locked") return "";
  if (value.startsWith("avc") || value.startsWith("h264")) return "AVC";
  if (value.startsWith("hev") || value.startsWith("hvc") || value.startsWith("hevc")) return "HEVC";
  if (value.startsWith("av01") || value.startsWith("av1")) return "AV1";
  if (value.startsWith("mp4a") || value.startsWith("aac")) return "AAC";
  if (value.startsWith("opus")) return "Opus";
  if (value.startsWith("flac")) return "FLAC";
  return "";
}

export function realQualityOptionMarkup(quality, selectedId, recommendedId) {
  const accessible = quality.accessible !== false;
  const active = quality.formatId === selectedId;
  const recommended = quality.formatId === recommendedId;
  const label = escapeHtml(quality.label);
  const size = quality.sizeBytes ? formatSize(Number(quality.sizeBytes) / 1_000_000) : "大小未知";
  const format = quality.audioOnly ? "MP3" : String(quality.container || "mp4").toUpperCase();
  const codec = codecLabel(quality.codec);
  const detail = [format, codec, size].filter(Boolean).join(" · ");
  const reasonId = `real-quality-reason-${String(quality.formatId).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const reason = quality.reason || "当前账号不可用";
  const ariaLabel = accessible
    ? `选择 ${label}，${detail}`
    : `${label}，${escapeHtml(reason)}，${detail}`;

  return `
    <button
      class="quality-option${active ? " is-active" : ""}${accessible ? "" : " is-locked"}"
      type="button"
      role="radio"
      aria-checked="${active}"
      tabindex="${active ? "0" : "-1"}"
      aria-label="${ariaLabel}"
      ${accessible ? "" : `aria-describedby="${reasonId}" disabled`}
      data-quality="${escapeHtml(quality.formatId)}"
      title="${escapeHtml([quality.codec, quality.resolution, quality.fps ? `${Math.round(quality.fps)} FPS` : ""].filter(Boolean).join(" · "))}"
    >
      <span class="q-radio" aria-hidden="true"></span>
      <span class="q-body">
        <span class="q-line">
          <span class="q-res">${label}${recommended ? '<span class="q-recommend">推荐</span>' : ""}</span>
        </span>
        <span class="q-line q-meta">
          <span class="q-detail">${detail}</span>
          ${accessible ? "" : `<span class="q-access" id="${reasonId}">${icon("lock")}<span>${escapeHtml(reason)}</span></span>`}
        </span>
      </span>
    </button>
  `;
}

export function desktopQualityGridMarkup(video, selectedId) {
  const options = video.qualityOptions || [];
  if (!options.length) {
    return `<p class="quality-empty">该视频没有可下载的清晰度。</p>`;
  }
  const accessible = options.filter((quality) => quality.accessible !== false).length;
  const warnings = (video.warnings || []).filter(Boolean).slice(0, 2);
  return `
    <div class="quality-grid" role="radiogroup" aria-label="选择清晰度">
      ${options.map((quality) => realQualityOptionMarkup(quality, selectedId, video.recommendedQuality)).join("")}
    </div>
    ${accessible ? "" : `<p class="quality-note">当前账号状态没有可下载的清晰度。</p>`}
    ${warnings.map((warning) => `<p class="quality-note">${icon("info")}<span>${escapeHtml(warning)}</span></p>`).join("")}
  `;
}

export function qualityReasonId(optionId) {
  return `quality-reason-${optionId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

export function qualityAccountText(video, accountTier) {
  const tier = accountTierMeta(accountTier);
  const options = supportedQualityOptions(video);
  if (!options.length) return "无可用清晰度";

  const lockedCount = options.filter((option) => !qualityAccess(option.id, accountTier).accessible).length;
  if (!lockedCount) return `${tier.label} · 全部可用`;
  if (lockedCount === options.length) return `${tier.label} · 无可下载档位`;
  return `${tier.label} · ${lockedCount} 档受限`;
}

export function qualityOptionMarkup(option, video, accountTier, selectedId, recommendedId) {
  const size = Number(video.sizes?.[option.id]) || 0;
  const access = qualityAccess(option.id, accountTier);
  const active = option.id === selectedId;
  const recommended = option.id === recommendedId;
  const format = option.audio ? "MP3" : "MP4";
  const reasonId = qualityReasonId(option.id);
  const label = escapeHtml(option.label);
  const ariaLabel = access.accessible
    ? `选择 ${label}，预计 ${formatSize(size)}`
    : `${label}，${escapeHtml(access.reason)}，预计 ${formatSize(size)}`;

  return `
    <button
      class="quality-option${active ? " is-active" : ""}${access.accessible ? "" : " is-locked"}"
      type="button"
      role="radio"
      aria-checked="${active}"
      tabindex="${active ? "0" : "-1"}"
      aria-label="${ariaLabel}"
      ${access.accessible ? "" : `aria-describedby="${reasonId}" disabled`}
      data-quality="${escapeHtml(option.id)}"
      title="${escapeHtml(option.detail)}"
    >
      <span class="q-radio" aria-hidden="true"></span>
      <span class="q-body">
        <span class="q-line">
          <span class="q-res">${label}${recommended ? '<span class="q-recommend">推荐</span>' : ""}</span>
        </span>
        <span class="q-line q-meta">
          <span class="q-detail">${format} · ${formatSize(size)}</span>
          ${access.accessible ? "" : `<span class="q-access" id="${reasonId}">${icon("lock")}<span>${escapeHtml(access.reason)}</span></span>`}
        </span>
      </span>
    </button>
  `;
}

export function qualityGridMarkup(video, accountTier, selectedId) {
  const options = supportedQualityOptions(video);
  if (!options.length) {
    return `<p class="quality-empty">该视频没有可下载的清晰度。</p>`;
  }

  const recommendedId = recommendedQualityId(video, accountTier);
  const accessibleCount = options.filter((option) => qualityAccess(option.id, accountTier).accessible).length;
  const cards = options
    .map((option) => qualityOptionMarkup(option, video, accountTier, selectedId, recommendedId))
    .join("");

  return `
    <div class="quality-grid" role="radiogroup" aria-label="选择清晰度">${cards}</div>
    ${accessibleCount ? "" : `<p class="quality-note">当前账号状态没有可下载的清晰度。</p>`}
  `;
}
