// @ts-check
// 历史页：搜索、分组、再次下载。

import { $, $$, escapeHtml, formatHistoryTime, icon, toast } from "../ui.js";
import { store } from "../runtime.js";

/** 历史搜索关键词：只被本页使用，绑定层通过 setter 写。 */
export let historyQuery = "";
export function setHistoryQuery(next) { historyQuery = next; }
import { isDesktop } from "../bridge.js";
import * as desktop from "../tauri.js";
import { dayKey, dayLabel, formatClock, formatSize } from "../ui.js";
import { content } from "./dom.js";
import { extrasMeta } from "./selection.js";
import { openDirectory, revealFile } from "../tauri.js";
import { confirmModal, confirmOptionModal } from "../ui.js";
import { updateSidebar } from "./chrome.js";
import { reAddHistory, renderRecent } from "./home-view.js";

export function emptyHistoryMarkup() {
  return `
    <section class="empty-state">
      <div class="empty-visual" data-tone="green">
        <span class="empty-dot"></span>
        <span class="empty-core">${icon("history")}</span>
      </div>
      <h3>还没有下载记录</h3>
      <p>${isDesktop ? "每次下载完成后，任务会保存在这里。历史记录只存在本机，随时可以清空。" : "每次模拟下载完成后，任务会保存在这里。历史记录只存在本机，随时可以清空。"}</p>
      <button class="btn btn-primary btn-sm" type="button" data-route="download">${icon("arrow-right")}去解析一条链接</button>
    </section>
  `;
}

export function historyRow(entry) {
  const extra = extrasMeta(entry);

  return `
    <article class="history-row" data-id="${escapeHtml(entry.id)}">
      <img class="history-thumb" src="${escapeHtml(entry.cover)}" alt="" loading="lazy" />
      <div class="history-info">
        <div class="history-title" title="${escapeHtml(entry.title)}">${escapeHtml(entry.title)}</div>
        <div class="history-meta">
          <span class="meta-chip">${escapeHtml(entry.qualityLabel)}</span>
          <span>${escapeHtml(entry.format)}</span>
          <span class="dot-sep"></span>
          <span>${formatSize(entry.sizeMB)}</span>
          <span class="dot-sep"></span>
          <span>${escapeHtml(entry.up)}</span>
          ${
            extra.text
              ? `<span class="dot-sep"></span><span class="entry-extra" title="${escapeHtml(extra.title)}">${escapeHtml(extra.text)}</span>`
              : ""
          }
          ${
            entry.missingFile
              ? `<span class="dot-sep"></span><span class="history-missing">${icon("alert")}文件已丢失</span>`
              : ""
          }
          ${
            entry.extrasError
              ? `<span class="dot-sep"></span><span class="history-missing is-warning" title="${escapeHtml(entry.extrasError)}">${icon("alert")}附加内容未完整写入</span>`
              : ""
          }
        </div>
      </div>
      <div class="history-actions">
        <span class="history-time">${formatClock(entry.completedAt)}</span>
        ${
          entry.outputPath && !entry.missingFile
            ? `<button class="mini-btn" type="button" data-action="reveal">${icon("folder")}${entry.kind === "extras" ? "打开文件夹" : "打开文件"}</button>`
            : ""
        }
        <button class="mini-btn" type="button" data-action="re-add">${icon("download")}${entry.kind === "extras" ? "重下附加内容" : "再次下载"}</button>
        <button class="icon-btn is-danger" type="button" data-action="remove-history" title="移除记录" aria-label="移除这条历史记录">${icon("trash")}</button>
      </div>
    </article>
  `;
}

export function historyEntryMatches(entry, query) {
  if (!query) return true;
  const haystack = `${entry.title} ${entry.up} ${entry.bvid}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

export function filteredHistoryMarkup(query) {
  return `
    <section class="empty-state compact">
      <div class="empty-visual">
        <span class="empty-dot"></span>
        <span class="empty-core">${icon("search")}</span>
      </div>
      <h3>没有找到匹配记录</h3>
      <p>没有标题、UP 主或 BV 号包含 “${escapeHtml(query)}” 的记录。</p>
      <button class="btn btn-ghost btn-sm" type="button" data-action="clear-search">${icon("x")}清除搜索</button>
    </section>
  `;
}

export function resetHistorySearch({ focus = true } = {}) {
  historyQuery = "";
  const input = $("#history-search");
  if (input) input.value = "";
  const clearSearch = $("#history-search-clear");
  if (clearSearch) clearSearch.hidden = true;
  renderHistory();
  if (focus) input?.focus();
}

export function renderHistory() {
  const allEntries = [...store.getState().history].sort((a, b) => b.completedAt - a.completedAt);
  const container = $("#history-content");
  const summary = $("#history-summary");
  const clearButton = $("#clear-history");
  const searchInput = $("#history-search");
  const clearSearchButton = $("#history-search-clear");

  if (!allEntries.length && historyQuery) {
    historyQuery = "";
    if (searchInput) searchInput.value = "";
  }

  const query = historyQuery.trim();
  const entries = allEntries.filter((entry) => historyEntryMatches(entry, query));

  if (searchInput) searchInput.disabled = allEntries.length === 0;
  if (clearSearchButton) clearSearchButton.hidden = !query;
  if (clearButton) clearButton.disabled = allEntries.length === 0;

  if (summary) {
    const total = allEntries.reduce((sum, entry) => sum + entry.sizeMB, 0);
    if (!allEntries.length) {
      summary.textContent = "还没有下载记录";
    } else if (query) {
      summary.textContent = `找到 ${entries.length} 条 · 共 ${allEntries.length} 条${isDesktop ? "" : "（模拟）"}`;
    } else {
      summary.textContent = `共 ${allEntries.length} 条记录 · 约 ${formatSize(total)}${isDesktop ? "" : "（模拟）"}`;
    }
  }

  if (!container) return;

  if (!allEntries.length) {
    container.innerHTML = emptyHistoryMarkup();
    return;
  }

  if (!entries.length) {
    container.innerHTML = filteredHistoryMarkup(query);
    return;
  }

  const groups = [];
  entries.forEach((entry) => {
    const key = dayKey(entry.completedAt);
    let group = groups.find((item) => item.key === key);
    if (!group) {
      group = { key, label: dayLabel(entry.completedAt), entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  });

  container.innerHTML = `
    <div class="history-groups">
      ${groups
        .map(
          (group) => `
            <section>
              <div class="history-group-label">${escapeHtml(group.label)}</div>
              <div class="history-card">${group.entries.map(historyRow).join("")}</div>
            </section>
          `,
        )
        .join("")}
    </div>
  `;
}


const historySearchInput = $("#history-search");
historySearchInput?.addEventListener("input", () => {
  setHistoryQuery(historySearchInput.value);
  renderHistory();
});

historySearchInput?.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && historyQuery) {
    event.preventDefault();
    resetHistorySearch();
  }
});

$("#history-search-clear")?.addEventListener("click", (event) => {
  event.preventDefault();
  resetHistorySearch();
});

$("#history-content")?.addEventListener("click", async (event) => {
  const action = event.target.closest("[data-action]");
  if (!action) return;

  if (action.dataset.action === "clear-search") {
    resetHistorySearch();
    return;
  }

  const row = action.closest(".history-row");
  if (!row) return;

  const entry = store.getState().history.find((item) => item.id === row.dataset.id);
  if (!entry) return;

  if (action.dataset.action === "reveal") {
    const ok =
      entry.kind === "extras"
        ? await desktop.openDirectory(entry.outputPath)
        : await desktop.revealFile(entry.outputPath);
    if (!ok) {
      toast(entry.kind === "extras" ? "无法打开文件夹" : "无法定位下载文件", {
        tone: "error",
        message: "文件可能已被移动或删除。",
      });
    }
    return;
  }

  if (action.dataset.action === "re-add") {
    reAddHistory(entry);
    return;
  }

  if (action.dataset.action === "remove-history") {
    const hasFile = Boolean(entry.outputPath) && !entry.missingFile;
    let confirmed = false;
    let deleteFile = false;
    if (hasFile) {
      const choice = await confirmOptionModal({
        title: "移除这条历史记录？",
        message: isDesktop
          ? "移除后记录会消失；勾选后将同时删除磁盘上的文件。"
          : "移除后记录会消失；浏览器预览不会操作任何本地文件。",
        target: entry.title,
        confirmText: "移除",
        checkbox: {
          label: "同时删除已下载的文件",
          description:
            entry.kind === "extras"
              ? "包括该视频文件夹中的弹幕/字幕文件，删除后无法恢复。"
              : "包括视频以及对应的字幕/弹幕文件，删除后无法恢复。",
          checked: false,
        },
      });
      if (!choice?.confirmed) return;
      confirmed = true;
      deleteFile = choice.checked;
    } else {
      confirmed = await confirmModal({
        title: "移除这条历史记录？",
        message: isDesktop ? "此操作只移除本地历史记录，不会删除已下载的文件。" : "此操作只影响本地原型数据，不会删除任何文件。",
        target: entry.title,
        confirmText: "移除",
      });
    }
    if (!confirmed) return;

    const result = await store.removeHistory(entry.id, { deleteFile });
    if (!result?.ok) {
      toast("无法移除历史记录", {
        tone: "error",
        message: result?.message || result?.fileError || "请稍后重试。",
      });
      return;
    }
    renderHistory();
    renderRecent();
    updateSidebar();
    $("#page-title")?.focus({ preventScroll: true });
    let message = "历史记录已移除。";
    if (!isDesktop) {
      message = "浏览器预览只移除记录，不会删除真实文件。";
    } else if (result.fileError) {
      message = `记录已移除，但部分字幕/弹幕文件未能删除：${result.fileError}`;
    } else if (deleteFile && result.fileDeleted) {
      message = "历史记录已移除，下载文件已删除。";
    } else if (deleteFile) {
      message = "历史记录已移除；没有找到下载文件。";
    }
    toast("历史记录已移除", {
      tone: result.fileError ? "warning" : "success",
      message,
      duration: result.fileError ? 3600 : 2100,
    });
  }
});

$("#clear-history")?.addEventListener("click", async () => {
  const entries = store.getState().history;
  if (!entries.length) return;

  const confirmed = await confirmModal({
    title: "清空全部历史记录？",
    message: isDesktop ? "清空后无法恢复；只会移除本机历史记录，不会删除已下载的文件。" : "清空后无法恢复。只会影响本机保存的原型数据，不会删除任何文件。",
    confirmText: "清空",
  });
  if (!confirmed) return;

  store.clearHistory();
  renderHistory();
  renderRecent();
  updateSidebar();
  toast("历史记录已清空", { tone: "success" });
});
