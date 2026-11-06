// @ts-check
// 结果页的「下载选项」区块：分 P、附加音轨、片段区间、合集入口。

import { escapeHtml } from "../ui.js";
import { paginateSeason, toggleVisibleSelection } from "../catalog.js";
import { stageResult } from "./dom.js";
import { seasonCountText, seasonListMarkup, seasonToggleLabel, seasonVisible } from "./season-panel.js";
import { updateEnqueueAction } from "./action-bar.js";
import { parseExtras } from "./parse-store.js";
import { seasonBlockMarkup } from "./season-panel.js";
import { SEASON_PAGE_SIZE } from "../catalog.js";
import { store } from "../runtime.js";
import { parseState } from "./parse-store.js";
import { seasonEpisodes } from "./season-panel.js";

export function advancedOptionsMarkup(video) {
  const pages = video.pages || [];
  const tracks = video.audioTracks || [];
  const seasons = video.season?.episodes || [];
  if (pages.length < 2 && tracks.length === 0 && seasons.length === 0 && !video.__real) return "";

  const seasonMarkup = seasonBlockMarkup(video);

  const pagesMarkup =
    pages.length > 1
      ? `<div class="adv-block">
          <div class="adv-head">
            <strong>分 P 选择</strong>
            <span>共 ${pages.length} 集，勾选后逐个加入队列（同一个 BV 内部）</span>
            <button class="mini-btn" type="button" data-action="pages-all">全选</button>
            <button class="mini-btn" type="button" data-action="pages-none">清空</button>
          </div>
          <div class="adv-pages">
            ${pages
              .map(
                (page) => `<label class="adv-check">
                  <input type="checkbox" class="page-check" data-page-index="${page.index}" ${
                    parseExtras.pageSelection.has(page.index) ? "checked" : ""
                  } />
                  <span>P${page.index} · ${escapeHtml(page.title || "未命名")}</span>
                </label>`,
              )
              .join("")}
          </div>
        </div>`
      : "";
  const tracksMarkup =
    tracks.length > 0
      ? `<div class="adv-block">
          <div class="adv-head"><strong>附加音轨</strong><span>仅 MKV 支持多音轨；不选时行为与现在一致${
            seasons.length > 0 ? "；勾选合集条目时会应用到每一条，个别条目没有该音轨时会单独失败" : ""
          }</span></div>
          <div class="adv-pages">
            ${tracks
              .map(
                (track) => `<label class="adv-check">
                  <input type="checkbox" class="audio-check" data-audio-id="${escapeHtml(track.id)}" ${
                    parseExtras.audioTrackIds.includes(track.id) ? "checked" : ""
                  } />
                  <span>${escapeHtml(track.label || track.id)}</span>
                </label>`,
              )
              .join("")}
          </div>
        </div>`
      : "";
  const sectionMarkup = `<div class="adv-block">
      <div class="adv-head"><strong>仅下载片段</strong><span>开始与结束都填才生效；留空表示下载完整视频。片段任务不参与断点续传</span></div>
      <div class="adv-fields">
        <label>开始 <input class="text-input" type="text" id="section-start" placeholder="00:01:00" maxlength="8" value="${escapeHtml(parseExtras.sectionStart)}" /></label>
        <label>结束 <input class="text-input" type="text" id="section-end" placeholder="00:05:00" maxlength="8" value="${escapeHtml(parseExtras.sectionEnd)}" /></label>
      </div>
    </div>`;
  if (!pagesMarkup && !tracksMarkup && !seasonMarkup && !video.__real) return "";
  return `<section class="adv-section" aria-label="下载选项">${seasonMarkup}${pagesMarkup}${tracksMarkup}${
    video.__real ? sectionMarkup : ""
  }</section>`;
}

export function clearPageSelection() {
  if (parseExtras.pageSelection.size === 0) return;
  parseExtras.pageSelection.clear();
  stageResult?.querySelectorAll(".page-check").forEach((input) => (input.checked = false));
}

export function clearSeasonSelection() {
  if (parseExtras.seasonSelection.size === 0) return;
  parseExtras.seasonSelection.clear();
  refreshSeasonList();
}

export function bindSeasonChecks() {
  stageResult?.querySelector('[data-action="season-more"]')?.addEventListener("click", () => {
    const page = paginateSeason(seasonVisible(), parseExtras.seasonLimit);
    parseExtras.seasonLimit = page.nextLimit;
    refreshSeasonList();
  });
  stageResult?.querySelectorAll(".season-check").forEach((input) => {
    input.addEventListener("change", () => {
      const bvid = input.dataset.bvid;
      if (!bvid) return;
      if (input.checked) {
        clearPageSelection();
        parseExtras.seasonSelection.add(bvid);
      } else {
        parseExtras.seasonSelection.delete(bvid);
      }
      refreshSeasonSummary();
    });
  });
}

export function refreshSeasonSummary() {
  const visible = seasonVisible();
  const count = stageResult?.querySelector("#season-count");
  if (count) count.textContent = seasonCountText(visible);
  const toggle = stageResult?.querySelector('[data-action="season-toggle"]');
  if (toggle) toggle.textContent = seasonToggleLabel(visible);
  updateEnqueueAction();
}

export function refreshSeasonList() {
  if (seasonEpisodes().length === 0) return;
  const visible = seasonVisible();
  const list = stageResult?.querySelector("#season-list");
  if (list) list.innerHTML = seasonListMarkup(visible);
  refreshSeasonSummary();
  bindSeasonChecks();
}

export function bindAdvancedOptions() {
  bindSeasonChecks();
  stageResult?.querySelector("#season-search")?.addEventListener("input", (event) => {
    parseExtras.seasonQuery = String(event.currentTarget.value || "");
    // 换了关键词就回到首屏，避免沿用上次展开到几百条的状态。
    parseExtras.seasonLimit = SEASON_PAGE_SIZE;
    refreshSeasonList();
  });
  stageResult?.querySelector('[data-action="season-toggle"]')?.addEventListener("click", () => {
    // 全选/取消全选只作用于当前筛选出来的条目。
    const bvids = seasonVisible().map((episode) => episode.bvid);
    parseExtras.seasonSelection = toggleVisibleSelection(parseExtras.seasonSelection, bvids);
    if (parseExtras.seasonSelection.size > 0) clearPageSelection();
    refreshSeasonList();
  });
  stageResult?.querySelectorAll(".page-check").forEach((input) => {
    input.addEventListener("change", () => {
      const index = Number(input.dataset.pageIndex);
      if (input.checked) {
        clearSeasonSelection();
        parseExtras.pageSelection.add(index);
      } else {
        parseExtras.pageSelection.delete(index);
      }
      updateEnqueueAction();
    });
  });
  stageResult?.querySelectorAll(".audio-check").forEach((input) => {
    input.addEventListener("change", () => {
      const id = input.dataset.audioId;
      parseExtras.audioTrackIds = input.checked
        ? [...new Set([...parseExtras.audioTrackIds, id])]
        : parseExtras.audioTrackIds.filter((item) => item !== id);
    });
  });
  for (const [id, key] of [
    ["section-start", "sectionStart"],
    ["section-end", "sectionEnd"],
  ]) {
    stageResult?.querySelector(`#${id}`)?.addEventListener("change", (event) => {
      parseExtras[key] = String(event.currentTarget.value || "").trim();
    });
  }
  stageResult?.querySelector('[data-action="pages-all"]')?.addEventListener("click", () => {
    const pages = parseState.video?.pages || [];
    clearSeasonSelection();
    parseExtras.pageSelection = new Set(pages.map((page) => page.index));
    stageResult
      ?.querySelectorAll(".page-check")
      .forEach((input) => (input.checked = true));
    updateEnqueueAction();
  });
  stageResult?.querySelector('[data-action="pages-none"]')?.addEventListener("click", () => {
    parseExtras.pageSelection.clear();
    stageResult
      ?.querySelectorAll(".page-check")
      .forEach((input) => (input.checked = false));
    updateEnqueueAction();
  });
}
