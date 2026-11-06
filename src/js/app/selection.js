// @ts-check
// 弹幕/字幕选择集与「更多设置」抽屉：纯前端状态 + 渲染，不触碰队列。

import {
  DANMAKU_TYPES,
  SUBTITLE_OPTIONS,
  availableDanmakuTypes,
  danmakuTotal,
  selectedDanmakuCount,
  subtitleLabel,
  supportedQualityOptions,
  qualityAccess,
} from "../catalog.js";
import { $, $$, escapeHtml, formatCount, icon, makeFocusTrap } from "../ui.js";
import { appShell, drawer, drawerRoot, stageResult } from "./dom.js";
import { store } from "../runtime.js";
import { parseExtras, parseState } from "./parse-store.js";
import { updateEnqueueAction } from "./action-bar.js";

export function selectQuality(qualityId) {
  const video = parseState.video;
  if (!video) return;
  if (video.__real) {
    const quality = (video.qualityOptions || []).find((item) => item.formatId === qualityId);
    if (!quality || quality.accessible === false) return;
  } else {
    if (!supportedQualityOptions(video).some((option) => option.id === qualityId)) return;
    if (!qualityAccess(qualityId, store.getState().settings.accountTier).accessible) return;
  }

  parseState.quality = qualityId;
  parseState.qualitySource = "manual";
  $$(".quality-option", stageResult).forEach((option) => {
    const active = option.dataset.quality === qualityId;
    option.classList.toggle("is-active", active);
    option.setAttribute("aria-checked", String(active));
    option.tabIndex = active ? 0 : -1;
  });
  updateEnqueueAction();
}

export function defaultSelection(video) {
  const settings = store.getState().settings;
  return {
    danmakuTypes:
      settings.defaultDanmaku === false
        ? []
        : availableDanmakuTypes(video?.danmakuTypeCounts).map((type) => type.id),
    subtitles: settings.defaultSubtitles === false ? [] : availableSubtitleIds(video),
  };
}

export function currentSelection() {
  return parseState.selection || { danmakuTypes: [], subtitles: [] };
}

export function availableSubtitleIds(video) {
  if (Array.isArray(video?.subtitleTracks)) {
    return video.subtitleTracks.filter((track) => track.accessible !== false).map((track) => track.id);
  }
  const available = new Set(Array.isArray(video?.subtitles) ? video.subtitles : []);
  return SUBTITLE_OPTIONS.filter((track) => available.has(track.id)).map((track) => track.id);
}

export function selectedExtraIds(kind) {
  const video = parseState.video;
  const selection = currentSelection();
  if (kind === "danmaku") {
    const available = new Set(availableDanmakuTypes(video?.danmakuTypeCounts).map((type) => type.id));
    return selection.danmakuTypes.filter((id) => available.has(id));
  }
  const available = new Set(availableSubtitleIds(video));
  return selection.subtitles.filter((id) => available.has(id));
}

export function selectedDanmakuTotal() {
  return selectedDanmakuCount(parseState.video?.danmakuTypeCounts, selectedExtraIds("danmaku"));
}

export function danmakuRowSummary() {
  const available = availableDanmakuTypes(parseState.video?.danmakuTypeCounts);
  if (!available.length) return "无可用弹幕";
  const selectedCount = selectedExtraIds("danmaku").length;
  const total = formatCount(danmakuTotal(parseState.video?.danmakuTypeCounts));
  if (!selectedCount) return `共 ${total} 条 · 未选择`;
  if (selectedCount === available.length) return `共 ${total} 条 · ${available.length} 类全选`;
  return `共 ${total} 条 · 已选 ${selectedCount}/${available.length} 类`;
}

export function subtitleRowSummary() {
  const available = availableSubtitleIds(parseState.video);
  if (!available.length) return "无可用字幕";
  const selectedCount = selectedExtraIds("subtitles").length;
  if (!selectedCount) return `${available.length} 种语言 · 未选择`;
  if (selectedCount === available.length) return `${available.length} 种语言 · 全部已选`;
  return `${available.length} 种语言 · 已选 ${selectedCount} 种`;
}

export function selectionSummaryText() {
  const danmakuCount = selectedExtraIds("danmaku").length;
  const subtitleCount = selectedExtraIds("subtitles").length;
  const parts = [];
  if (danmakuCount) {
    parts.push(`弹幕 ${danmakuCount} 类 · ${formatCount(selectedDanmakuTotal())} 条`);
  }
  if (subtitleCount) parts.push(`字幕 ${subtitleCount} 种`);
  return parts.length ? `已选 ${parts.join(" · ")}` : "未选择附加内容";
}

export function extraOptionMarkup(type, selected) {
  const count = Number(parseState.video?.danmakuTypeCounts?.[type.id]) || 0;
  return `
    <label class="extra-option" title="${escapeHtml(type.description)}">
      <input
        class="extra-check"
        type="checkbox"
        data-danmaku-type="${escapeHtml(type.id)}"
        ${selected ? "checked" : ""}
        aria-label="下载${escapeHtml(type.label)}，共 ${formatCount(count)} 条"
      />
      <span class="extra-box" aria-hidden="true"></span>
      <span class="extra-name">${escapeHtml(type.label)}</span>
      <span class="extra-count">${formatCount(count)}</span>
    </label>
  `;
}

export function subtitleOptionMarkup(track, selected) {
  return `
    <label class="extra-option">
      <input
        class="extra-check"
        type="checkbox"
        data-subtitle-track="${escapeHtml(track.id)}"
        ${selected ? "checked" : ""}
        aria-label="下载字幕：${escapeHtml(track.label)}"
      />
      <span class="extra-box" aria-hidden="true"></span>
      <span class="extra-name">${escapeHtml(track.label)}</span>
    </label>
  `;
}

export function setSelectionPart(kind, ids) {
  const selection = currentSelection();
  const next = [...new Set(ids)];
  parseState.selection =
    kind === "danmaku"
      ? { ...selection, danmakuTypes: next }
      : { ...selection, subtitles: next };
  syncExtrasUI();
}

export function setExtrasGroup(kind, selected) {
  const video = parseState.video;
  if (!video) return;
  const ids =
    kind === "danmaku"
      ? availableDanmakuTypes(video.danmakuTypeCounts).map((type) => type.id)
      : availableSubtitleIds(video);
  setSelectionPart(kind, selected ? ids : []);
}

export function toggleExtrasMaster(kind) {
  const video = parseState.video;
  if (!video) return;
  const availableCount =
    kind === "danmaku" ? availableDanmakuTypes(video.danmakuTypeCounts).length : availableSubtitleIds(video).length;
  const allSelected = availableCount > 0 && selectedExtraIds(kind).length === availableCount;
  setExtrasGroup(kind, !allSelected);
}

export function syncMasterCheckbox(input, kind, availableCount) {
  if (!input) return;
  const selectedCount = selectedExtraIds(kind).length;
  input.checked = availableCount > 0 && selectedCount === availableCount;
  input.indeterminate = selectedCount > 0 && selectedCount < availableCount;
  input.disabled = availableCount === 0;
}

export function drawerDanmakuMeta() {
  const available = availableDanmakuTypes(parseState.video?.danmakuTypeCounts);
  if (!available.length) return "无可用弹幕";
  return `共 ${formatCount(danmakuTotal(parseState.video?.danmakuTypeCounts))} 条 · 已选 ${selectedExtraIds("danmaku").length}/${available.length} 类`;
}

export function drawerSubtitleMeta() {
  const available = availableSubtitleIds(parseState.video);
  if (!available.length) return "无可用字幕";
  return `${available.length} 种语言 · 已选 ${selectedExtraIds("subtitles").length} 种`;
}

export function syncExtrasUI() {
  const video = parseState.video;
  if (!video) return;

  syncMasterCheckbox(
    $('[data-extras-master="danmaku"]', stageResult),
    "danmaku",
    availableDanmakuTypes(video.danmakuTypeCounts).length,
  );
  syncMasterCheckbox(
    $('[data-extras-master="subtitles"]', stageResult),
    "subtitles",
    availableSubtitleIds(video).length,
  );

  const danmakuSummary = $("#extras-danmaku-summary");
  if (danmakuSummary) danmakuSummary.textContent = danmakuRowSummary();
  const subtitleSummary = $("#extras-subtitles-summary");
  if (subtitleSummary) subtitleSummary.textContent = subtitleRowSummary();

  updateEnqueueAction();

  const drawer = $("#extras-drawer");
  if (!drawer) return;

  const selection = currentSelection();
  const danmakuSet = new Set(selection.danmakuTypes);
  const subtitleSet = new Set(selection.subtitles);
  $$("[data-danmaku-type]", drawer).forEach((input) => {
    input.checked = danmakuSet.has(input.dataset.danmakuType);
  });
  $$("[data-subtitle-track]", drawer).forEach((input) => {
    input.checked = subtitleSet.has(input.dataset.subtitleTrack);
  });

  const summary = $("#extras-drawer-summary", drawer);
  if (summary) summary.textContent = selectionSummaryText();
  const danmakuMeta = $("#extras-drawer-danmaku-meta", drawer);
  if (danmakuMeta) danmakuMeta.textContent = drawerDanmakuMeta();
  const subtitleMeta = $("#extras-drawer-subtitles-meta", drawer);
  if (subtitleMeta) subtitleMeta.textContent = drawerSubtitleMeta();
}

export function drawerGroupMarkup(kind) {
  const isDanmaku = kind === "danmaku";
  const available = isDanmaku
    ? availableDanmakuTypes(parseState.video?.danmakuTypeCounts)
    : availableSubtitleIds(parseState.video);
  const subtitleChoices =
    !isDanmaku && Array.isArray(parseState.video?.subtitleTracks) && parseState.video.subtitleTracks.length
      ? parseState.video.subtitleTracks
      : SUBTITLE_OPTIONS;
  const selection = currentSelection();
  const selected = new Set(isDanmaku ? selection.danmakuTypes : selection.subtitles);
  const meta = isDanmaku ? drawerDanmakuMeta() : drawerSubtitleMeta();
  const optionMarkup = isDanmaku
    ? available.map((type) => extraOptionMarkup(type, selected.has(type.id))).join("")
    : subtitleChoices
        .filter((track) => available.includes(track.id))
        .map((track) => subtitleOptionMarkup(track, selected.has(track.id)))
        .join("");

  return `
    <section class="drawer-group" data-drawer-group="${kind}" aria-labelledby="extras-drawer-${kind}-title">
      <div class="drawer-group-head">
        <div class="drawer-group-copy">
          <h3 id="extras-drawer-${kind}-title">${isDanmaku ? "弹幕" : "字幕"}</h3>
          <span id="extras-drawer-${kind}-meta">${escapeHtml(meta)}</span>
        </div>
        <span class="extras-tools">
          <button class="link-btn" type="button" data-drawer-all="${kind}" ${available.length ? "" : "disabled"}>全选</button>
          <button class="link-btn" type="button" data-drawer-none="${kind}" ${available.length ? "" : "disabled"}>清空</button>
        </span>
      </div>
      ${
        available.length
          ? `<div class="drawer-options">${optionMarkup}</div>`
          : `<p class="drawer-empty">${isDanmaku ? "该视频没有可下载的弹幕。" : "本视频没有可下载的字幕。"}</p>`
      }
    </section>
  `;
}

export function extrasDrawerMarkup() {
  return `
    <div class="drawer-backdrop">
      <aside
        class="extras-drawer"
        id="extras-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="extras-drawer-title"
        aria-describedby="extras-drawer-summary"
        tabindex="-1"
      >
        <header class="drawer-head">
          <div class="drawer-head-copy">
            <h2 id="extras-drawer-title">弹幕与字幕</h2>
            <p>可随视频保存，也可单独下载</p>
          </div>
          <button class="drawer-close" type="button" data-drawer-close aria-label="关闭弹幕与字幕设置">
            ${icon("x")}
          </button>
        </header>
        <div class="drawer-body">
          <p class="drawer-summary" id="extras-drawer-summary" role="status" aria-live="polite">${escapeHtml(selectionSummaryText())}</p>
          ${drawerGroupMarkup("danmaku")}
          ${drawerGroupMarkup("subtitles")}
        </div>
        <footer class="drawer-foot">
          <button class="btn btn-primary btn-sm" type="button" data-drawer-close>完成</button>
        </footer>
      </aside>
    </div>
  `;
}

export function setExtrasExpanded(expanded) {
  $$('[data-action="extras-open"]', stageResult).forEach((button) => {
    button.setAttribute("aria-expanded", String(expanded));
  });
}

export function openExtrasDrawer(kind = "danmaku", opener = null) {
  if (drawer.node || !parseState.video || !drawerRoot) return;

  const previousFocus = opener instanceof HTMLElement ? opener : document.activeElement;
  drawerRoot.innerHTML = extrasDrawerMarkup();
  const sheet = drawerRoot.querySelector(".extras-drawer");
  let active = true;
  const removeTrap = makeFocusTrap(sheet, () => closeExtrasDrawer());

  const close = ({ restoreFocus = true } = {}) => {
    if (!active) return;
    active = false;
    removeTrap();
    drawerRoot.replaceChildren();
    if (appShell) appShell.inert = false;
    drawer.node = null;
    setExtrasExpanded(false);
    if (restoreFocus && previousFocus instanceof HTMLElement) previousFocus.focus();
  };

  drawer.node = { close, sheet };
  if (appShell) appShell.inert = true;
  setExtrasExpanded(true);

  const group = sheet.querySelector(`[data-drawer-group="${kind === "subtitles" ? "subtitles" : "danmaku"}"]`);
  const focusTarget = group?.querySelector("input:not(:disabled)") || sheet.querySelector(".drawer-close");
  window.requestAnimationFrame(() => {
    if (drawer.node?.sheet !== sheet) return;
    focusTarget?.focus();
  });
}

export function closeExtrasDrawer({ restoreFocus = true } = {}) {
  drawer.node?.close({ restoreFocus });
}

export function extrasMeta(entry) {
  const danmakuTypes = Array.isArray(entry?.danmakuTypes) ? entry.danmakuTypes : [];
  const subtitles = Array.isArray(entry?.subtitles) ? entry.subtitles : [];
  const parts = [];
  if (danmakuTypes.length) {
    parts.push(`弹幕 ${danmakuTypes.length} 类 · ${formatCount(entry.danmakuCount)} 条`);
  }
  if (subtitles.length) parts.push(`字幕 ${subtitles.length} 项`);

  const typeLabels = danmakuTypes
    .map((id) => DANMAKU_TYPES.find((type) => type.id === id)?.label)
    .filter(Boolean);
  const subtitleLabels = subtitles.map(subtitleLabel).filter(Boolean);
  const titleParts = [];
  if (typeLabels.length) titleParts.push(`弹幕：${typeLabels.join("、")}`);
  if (subtitleLabels.length) titleParts.push(`字幕：${subtitleLabels.join("、")}`);

  return { text: parts.join(" · "), title: titleParts.join(" · ") };
}

drawerRoot?.addEventListener("click", (event) => {
  if (event.target.classList.contains("drawer-backdrop")) {
    closeExtrasDrawer();
    return;
  }

  if (event.target.closest("[data-drawer-close]")) {
    closeExtrasDrawer();
    return;
  }

  const allButton = event.target.closest("[data-drawer-all]");
  if (allButton) {
    setExtrasGroup(allButton.dataset.drawerAll, true);
    return;
  }

  const noneButton = event.target.closest("[data-drawer-none]");
  if (noneButton) {
    setExtrasGroup(noneButton.dataset.drawerNone, false);
  }
});

drawerRoot?.addEventListener("change", (event) => {
  const danmakuInput = event.target.closest("[data-danmaku-type]");
  if (danmakuInput) {
    const next = new Set(currentSelection().danmakuTypes);
    if (danmakuInput.checked) next.add(danmakuInput.dataset.danmakuType);
    else next.delete(danmakuInput.dataset.danmakuType);
    setSelectionPart("danmaku", [...next]);
    return;
  }

  const subtitleInput = event.target.closest("[data-subtitle-track]");
  if (subtitleInput) {
    const next = new Set(currentSelection().subtitles);
    if (subtitleInput.checked) next.add(subtitleInput.dataset.subtitleTrack);
    else next.delete(subtitleInput.dataset.subtitleTrack);
    setSelectionPart("subtitles", [...next]);
  }
});
