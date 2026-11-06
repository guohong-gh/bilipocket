// @ts-check
// 合集区块的渲染片段（纯展示，不含事件绑定与刷新逻辑）。
// 刷新与绑定仍留在 app.js：它们会回调 updateEnqueueAction，过早搬出会形成环。

import { filterSeasonEpisodes, paginateSeason, SEASON_PAGE_SIZE } from "../catalog.js";
import { escapeHtml } from "../ui.js";
import { formatDurationSeconds } from "./format.js";
import { parseExtras, parseState } from "./parse-store.js";
import { store } from "../runtime.js";
import { updateEnqueueAction } from "./action-bar.js";

export function seasonEpisodes() {
  return parseState.video?.season?.episodes || [];
}

export function seasonEpisodeSource(video, episode) {
  return {
    ...video,
    bvid: episode.bvid,
    title: episode.title || episode.bvid,
    sourceUrl: `https://www.bilibili.com/video/${episode.bvid}`,
    durationSeconds: episode.durationSeconds ?? video.durationSeconds,
    coverUrl: episode.coverUrl || video.coverUrl || null,
    coverPath: null,
    publishedAt: episode.publishedAt ?? video.publishedAt ?? null,
    pages: [],
    season: null,
    // 弹幕条数按条目各自统计，下载完成后由真实 XML 回填。
    danmakuTypeCounts: {},
  };
}

export function seasonVisible() {
  return filterSeasonEpisodes(seasonEpisodes(), parseExtras.seasonQuery);
}

export function seasonAllVisibleSelected(visible) {
  return (
    visible.length > 0 &&
    visible.every((episode) => parseExtras.seasonSelection.has(episode.bvid))
  );
}

export function seasonToggleLabel(visible) {
  return seasonAllVisibleSelected(visible) ? "取消全选" : "全选";
}

export function seasonListMarkup(visible) {
  if (visible.length === 0) {
    return `<div class="adv-empty">没有标题匹配的条目，换个关键词试试。</div>`;
  }
  const page = paginateSeason(visible, parseExtras.seasonLimit);
  const rows = page.shown
    .map((episode) => {
      const meta = [episode.section, formatDurationSeconds(episode.durationSeconds)]
        .filter((part) => part && part !== "—")
        .join(" · ");
      return `<label class="adv-check">
        <input type="checkbox" class="season-check" data-bvid="${escapeHtml(episode.bvid)}" ${
          parseExtras.seasonSelection.has(episode.bvid) ? "checked" : ""
        } />
        <span class="adv-season-title">${escapeHtml(episode.title || episode.bvid)}</span>
        ${meta ? `<span class="adv-season-meta">${escapeHtml(meta)}</span>` : ""}
      </label>`;
    })
    .join("");
  // 超出部分不渲染，但仍在筛选结果里——全选与已选计数不受影响。
  const more =
    page.remaining > 0
      ? `<button class="mini-btn adv-more" type="button" data-action="season-more">继续显示（还有 ${page.remaining} 条）</button>`
      : "";
  return rows + more;
}

export function seasonCountText(visible) {
  const total = seasonEpisodes().length;
  const parts = [`已选 ${parseExtras.seasonSelection.size} / 共 ${total} 个`];
  if (String(parseExtras.seasonQuery).trim()) {
    parts.push(`当前筛选出 ${visible.length} 个`);
  }
  const limit = parseExtras.seasonLimit || SEASON_PAGE_SIZE;
  if (visible.length > limit) {
    parts.push(`已显示前 ${limit} 条`);
  }
  return parts.join(" · ");
}

export function seasonBlockMarkup(video) {
  const episodes = video.season?.episodes || [];
  if (episodes.length === 0) return "";
  const visible = seasonVisible();
  const seasonTitle = video.season?.title ? `《${escapeHtml(video.season.title)}》` : "该视频";
  return `<div class="adv-block adv-season">
      <div class="adv-head">
        <strong>合集条目</strong>
        <span>${seasonTitle}共 ${episodes.length} 个独立视频；勾选后按上方所选清晰度逐个入队，个别条目不支持该档位时会单独失败</span>
        <button class="mini-btn" type="button" data-action="season-toggle">${seasonToggleLabel(visible)}</button>
      </div>
      <div class="adv-search">
        <input class="text-input" type="search" id="season-search" autocomplete="off" aria-label="按标题搜索合集条目"
          placeholder="按标题搜索，留空显示全部" value="${escapeHtml(parseExtras.seasonQuery)}" />
      </div>
      <div class="adv-pages adv-season-list" id="season-list">${seasonListMarkup(visible)}</div>
      <div class="adv-count" id="season-count">${seasonCountText(visible)}</div>
    </div>`;
}
