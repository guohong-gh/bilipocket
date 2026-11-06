// @ts-check
// 首页：最近下载与进行中活动。

import { $, $$, escapeHtml, formatCount, icon } from "../ui.js";
import { store } from "../runtime.js";
import { isDesktop } from "../bridge.js";
import { formatHistoryTime, formatSpeed, toast } from "../ui.js";
import { updateSidebar } from "./chrome.js";
import { applyDynamicWidths, progressOf } from "./queue-view.js";
import { navigate } from "./router.js";
import { extrasMeta } from "./selection.js";
import { TASK_STATUS } from "./queue-view.js";

export function renderRecent() {
  const container = $("#recent-list");
  if (!container) return;

  const entries = [...store.getState().history]
    .sort((a, b) => b.completedAt - a.completedAt)
    .slice(0, 3);

  if (!entries.length) {
    container.innerHTML = `
      <div class="recent-empty">
        <span class="recent-empty-icon">${icon("history")}</span>
        <strong>还没有完成记录</strong>
        <span>${isDesktop ? "完成一次下载后，会在这里留下记录。" : "完成一次模拟下载后，会在这里留下记录。"}</span>
      </div>
    `;
    return;
  }

  container.innerHTML = entries
    .map(
      (entry) => `
        <button class="recent-item" type="button" data-history-id="${escapeHtml(entry.id)}" aria-label="再次下载 ${escapeHtml(entry.title)}">
          <img class="recent-thumb" src="${escapeHtml(entry.cover)}" alt="" />
          <span class="recent-info">
            <span class="recent-title" title="${escapeHtml(entry.title)}">${escapeHtml(entry.title)}</span>
            <span class="recent-meta">${escapeHtml(entry.qualityLabel)} <span class="dot-sep"></span> ${escapeHtml(formatHistoryTime(entry.completedAt))}</span>
          </span>
          <span class="recent-action">${icon("download")}</span>
        </button>
      `,
    )
    .join("");
}

export async function reAddHistory(entry) {
  const result = await store.reAddFromHistory(entry);
  const extra = extrasMeta(entry);
  const isExtras = entry.kind === "extras";
  updateSidebar();
  renderHomeActivity();

  if (!result.ok) {
    toast(result.reason === "duplicate" ? "这个任务已经在队列中" : "无法加入下载队列", {
      tone: result.reason === "duplicate" ? "info" : "error",
      message:
        result.reason === "duplicate"
          ? isExtras
            ? "该视频的附加内容已在队列中；请先移除后再试。"
            : "相同视频与清晰度已在队列中；请先移除后再试。"
          : result.message || "请稍后重试。",
      action: { label: "查看队列", onClick: () => navigate("queue") },
    });
    return;
  }

  toast(isExtras ? "已加入弹幕/字幕下载" : "已重新加入下载队列", {
    tone: "success",
    message: [entry.title, isExtras ? extra.text : entry.qualityLabel, ...(isExtras ? [] : [extra.text])]
      .filter(Boolean)
      .join(" · "),
    action: { label: "查看队列", onClick: () => navigate("queue") },
  });
}

export function activityTaskMarkup(task) {
  const status = TASK_STATUS[task.status] || TASK_STATUS.queued;
  const percent = Math.round(progressOf(task));

  return `
    <button
      class="activity-item"
      type="button"
      data-route="queue"
      data-id="${escapeHtml(task.id)}"
      data-status="${task.status}"
      aria-label="查看队列任务：${escapeHtml(task.title)}"
    >
      <span class="activity-thumb">
        <img src="${escapeHtml(task.cover)}" alt="" loading="lazy" />
        <i class="activity-state-dot" aria-hidden="true"></i>
      </span>
      <span class="activity-info">
        <span class="activity-item-top">
          <span class="activity-item-title" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</span>
          <span class="activity-percent">${percent}%</span>
        </span>
        <span class="activity-track"><i data-width="${progressOf(task).toFixed(1)}%"></i></span>
        <span class="activity-meta">
          <span>${status.label}</span>
          <span class="dot-sep"></span>
          <span>${escapeHtml(task.qualityLabel)}</span>
          ${task.status === "downloading" ? `<span class="dot-sep"></span><span>${formatSpeed(task.speed)}</span>` : ""}
        </span>
      </span>
    </button>
  `;
}

export function renderHomeActivity() {
  const section = $("#home-activity");
  const items = $("#activity-items");
  if (!section || !items) return;

  const queue = store.getState().queue;
  const pending = queue.filter((task) => ["downloading", "queued", "paused", "failed"].includes(task.status));

  if (!pending.length) {
    section.hidden = true;
    items.innerHTML = "";
    return;
  }

  section.hidden = false;

  const active = pending.filter((task) => task.status === "downloading");
  const title = $("#activity-title");
  const speed = $("#activity-speed");
  const pulse = $("#activity-pulse");

  if (active.length) {
    if (title) title.textContent = `正在下载 ${active.length} 个任务`;
    if (speed) speed.textContent = `合计 ${store.totalSpeed().toFixed(1)} MB/s`;
    pulse?.classList.remove("is-idle");
  } else {
    if (title) title.textContent = `队列里有 ${pending.length} 个任务`;
    if (speed) {
      speed.textContent = pending.some((task) => task.status === "failed") ? "有任务需要处理" : "当前没有下载中的任务";
    }
    pulse?.classList.add("is-idle");
  }

  const priority = { downloading: 0, queued: 1, paused: 2, failed: 3 };
  const shown = [...pending].sort((a, b) => priority[a.status] - priority[b.status]).slice(0, 2);
  items.innerHTML = shown.map(activityTaskMarkup).join("");
  applyDynamicWidths(items);
}

export function updateHomeActivityLive() {
  const section = $("#home-activity");
  if (!section || section.hidden) return;

  const queue = store.getState().queue;
  const active = queue.filter((task) => task.status === "downloading");
  const speed = $("#activity-speed");
  if (speed && active.length) speed.textContent = `合计 ${store.totalSpeed().toFixed(1)} MB/s`;

  $$(".activity-item", section).forEach((item) => {
    const task = queue.find((entry) => entry.id === item.dataset.id);
    if (!task) return;

    const percent = progressOf(task);
    const percentElement = item.querySelector(".activity-percent");
    const fill = item.querySelector(".activity-track i");
    if (percentElement) percentElement.textContent = `${Math.round(percent)}%`;
    if (fill) fill.style.width = `${percent.toFixed(1)}%`;
  });
}


$("#recent-list")?.addEventListener("click", (event) => {
  const item = event.target.closest("[data-history-id]");
  if (!item) return;
  const entry = store.getState().history.find((record) => record.id === item.dataset.historyId);
  if (entry) reAddHistory(entry);
});

/* ---------- Home queue activity ---------- */
