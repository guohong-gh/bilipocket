// @ts-check
// 结果页：视频信息、清晰度网格、下载选项与主操作按钮的组合。

import { $$, $, escapeHtml, icon, formatCount, } from "../ui.js";
import { isDemo } from "../runtime.js";
import { assetUrl } from "../bridge.js";
import { advancedOptionsMarkup, bindAdvancedOptions } from "./advanced-options.js";
import { desktopQualityGridMarkup, desktopQualityStatus, qualityAccountText, qualityGridMarkup } from "./quality-picker.js";
import { availableSubtitleIds, closeExtrasDrawer, danmakuRowSummary, openExtrasDrawer, subtitleRowSummary, syncExtrasUI } from "./selection.js";
import { stageResult } from "./dom.js";
import { parseState } from "./parse-store.js";
import { updateEnqueueAction } from "./action-bar.js";
import { isDesktop } from "../bridge.js";
import { availableDanmakuTypes } from "../catalog.js";
import { store } from "../runtime.js";
import { drawer } from "./dom.js";
import { qualityOption } from "../catalog.js";
import { toast } from "../ui.js";
import { urlInput } from "./dom.js";
import { startParse } from "./download-parse.js";
import { enqueueCurrent, enqueueExtrasCurrent } from "./enqueue.js";
import { selectQuality, toggleExtrasMaster } from "./selection.js";

export function renderResult() {
  closeExtrasDrawer({ restoreFocus: false });
  const video = parseState.video;
  if (!video) return;

  const settings = store.getState().settings;
  const qualityMarkup = video.__real
    ? desktopQualityGridMarkup(video, parseState.quality)
    : qualityGridMarkup(video, settings.accountTier, parseState.quality);
  const qualityStatus = video.__real
    ? desktopQualityStatus(video)
    : qualityAccountText(video, settings.accountTier);

  const availableTypes = availableDanmakuTypes(video.danmakuTypeCounts);
  const subtitleTracks = availableSubtitleIds(video);
  const mockExtrasMarkup = `
    <section class="extras-section" aria-labelledby="extras-title">
      <div class="extras-head">
        <h3 id="extras-title">弹幕与字幕</h3>
        <span class="extras-hint">可随视频保存，也可单独下载</span>
      </div>
      <div class="extras-rows">
        <div class="extras-row">
          <label class="extras-select">
            <input
              class="extra-check"
              type="checkbox"
              data-extras-master="danmaku"
              aria-label="全选弹幕，共 ${availableTypes.length} 类"
              ${availableTypes.length ? "" : "disabled"}
            />
            <span class="extra-box" aria-hidden="true"></span>
            <span class="extras-copy">
              <span class="extras-name">弹幕</span>
              <span class="extras-meta" id="extras-danmaku-summary" data-extras-summary="danmaku">${escapeHtml(danmakuRowSummary())}</span>
            </span>
          </label>
          <button
            class="btn btn-ghost btn-sm extras-more"
            type="button"
            data-action="extras-open"
            data-extras-open="danmaku"
            aria-haspopup="dialog"
            aria-controls="extras-drawer"
            aria-expanded="false"
            aria-describedby="extras-danmaku-summary"
            aria-label="弹幕 · 更多设置"
            title="${availableTypes.length ? "选择弹幕类型" : "没有可选弹幕类型"}"
            ${availableTypes.length ? "" : "disabled"}
          >
            ${icon("settings")}<span>更多设置</span>
          </button>
        </div>
        <div class="extras-row">
          <label class="extras-select">
            <input
              class="extra-check"
              type="checkbox"
              data-extras-master="subtitles"
              aria-label="全选字幕，共 ${subtitleTracks.length} 种语言"
              ${subtitleTracks.length ? "" : "disabled"}
            />
            <span class="extra-box" aria-hidden="true"></span>
            <span class="extras-copy">
              <span class="extras-name">字幕</span>
              <span class="extras-meta" id="extras-subtitles-summary" data-extras-summary="subtitles">${escapeHtml(subtitleRowSummary())}</span>
            </span>
          </label>
          <button
            class="btn btn-ghost btn-sm extras-more"
            type="button"
            data-action="extras-open"
            data-extras-open="subtitles"
            aria-haspopup="dialog"
            aria-controls="extras-drawer"
            aria-expanded="false"
            aria-describedby="extras-subtitles-summary"
            aria-label="字幕 · 更多设置"
            title="${subtitleTracks.length ? "选择字幕语言" : "没有可选字幕"}"
            ${subtitleTracks.length ? "" : "disabled"}
          >
            ${icon("settings")}<span>更多设置</span>
          </button>
        </div>
      </div>
    </section>
  `;
  const extrasMarkup = mockExtrasMarkup;
  const advancedMarkup = advancedOptionsMarkup(video);

  stageResult.innerHTML = `
    <article class="result">
      <div class="result-cover-wrap">
        <img class="result-cover" src="${escapeHtml(video.cover)}" alt="${escapeHtml(video.title)} 封面" />
        <span class="result-duration">${escapeHtml(video.duration)}</span>
        <button class="cover-play" type="button" data-action="preview" aria-label="${isDesktop ? "预览封面，暂不支持在线播放" : "预览封面，原型不支持在线播放"}">
          <span>${icon("play")}</span>
        </button>
      </div>

      <div class="result-main">
        <div class="result-kicker">
          <span class="bvid">${escapeHtml(video.bvid)}</span>
          <span class="dot-sep"></span>
          <span class="mock-flag">${icon("info")}${video.__real ? "真实解析" : "模拟数据"}</span>
        </div>

        <h2 class="result-title">${escapeHtml(video.title)}</h2>

        <div class="up-row">
          <span class="up-avatar">${escapeHtml(video.avatarLetter || video.up.slice(0, 1))}</span>
          <span class="up-name">${escapeHtml(video.up)}</span>
          <span class="verified" title="模拟认证标识">${icon("check")}</span>
          <span class="dot-sep"></span>
          <span>${escapeHtml(video.views)} 播放</span>
          <span class="dot-sep"></span>
          <span>${escapeHtml(video.danmaku)} 弹幕</span>
          <span class="dot-sep"></span>
          <span>${escapeHtml(video.published)}</span>
        </div>

        <p class="result-intro">${escapeHtml(video.intro)}</p>

        <div class="quality-section">
          <div class="quality-head">
            <span>清晰度与格式</span>
            <span>${escapeHtml(qualityStatus)}</span>
          </div>
          ${qualityMarkup}
        </div>

        ${advancedMarkup}
        ${extrasMarkup}

        <div class="result-actions">
          <button class="btn btn-primary" type="button" data-action="enqueue" id="enqueue-btn">
            ${icon("download")}<span>加入下载队列</span>
          </button>
          <button class="btn btn-ghost" type="button" data-action="enqueue-extras" id="enqueue-extras-btn">
            ${icon("download")}<span>仅下载弹幕/字幕</span>
          </button>
          <button class="btn btn-ghost" type="button" data-action="reparse">
            ${icon("refresh")}<span>重新解析</span>
          </button>
          <span class="target-hint">
            ${icon("folder")}
            <span>保存至</span>
            <code>${escapeHtml(settings.downloadDir)}</code>
            <span>· 每个视频单独文件夹</span>
          </span>
        </div>

        <p class="result-legal">
          ${icon("shield")}
          仅用于下载自己拥有版权或已获授权的内容，请遵守哔哩哔哩服务条款及当地法律法规。
        </p>
      </div>
    </article>
  `;

  bindAdvancedOptions();
  syncExtrasUI();
  updateEnqueueAction();
}

stageResult?.addEventListener("click", (event) => {
  const qualityOption = event.target.closest(".quality-option");
  if (qualityOption) {
    selectQuality(qualityOption.dataset.quality);
    return;
  }

  const action = event.target.closest("[data-action]");
  if (!action) return;

  if (action.dataset.action === "extras-open") {
    openExtrasDrawer(action.dataset.extrasOpen, action);
    return;
  }
  if (action.dataset.action === "enqueue") enqueueCurrent();
  if (action.dataset.action === "enqueue-extras") enqueueExtrasCurrent();
  if (action.dataset.action === "reparse") startParse(parseState.input || urlInput.value);
  if (action.dataset.action === "preview") {
    toast(isDesktop ? "暂不提供在线播放" : "原型不提供在线播放", { tone: "info", message: "这里只展示解析后的信息卡片。" });
  }
});

stageResult?.addEventListener("change", (event) => {
  const master = event.target.closest("[data-extras-master]");
  if (!master) return;
  toggleExtrasMaster(master.dataset.extrasMaster);
});

stageResult?.addEventListener("keydown", (event) => {
  const grid = event.target.closest(".quality-grid");
  if (!grid) return;

  const current = event.target.closest(".quality-option");
  if (!current) return;

  const options = $$(".quality-option:not(:disabled)", grid);
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
  selectQuality(options[nextIndex].dataset.quality);
  options[nextIndex].focus();
});
