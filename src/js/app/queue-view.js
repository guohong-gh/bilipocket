// @ts-check
// 队列页：任务分组、进度、操作按钮与实时刷新。

import { $, $$, escapeHtml, formatCount, formatEta, formatSize, formatSpeed, icon, toast, confirmModal, confirmOptionModal } from "../ui.js";
import { groupQueue } from "../queue-model.js";
import { store } from "../runtime.js";
import { isDesktop } from "../bridge.js";
import * as desktop from "../tauri.js";
import { formatHistoryTime } from "../ui.js";
import { content } from "./dom.js";
import { cancellingTaskIds } from "./parse-store.js";
import { extrasMeta } from "./selection.js";
import { openDirectory, revealFile } from "../tauri.js";
import { startAuthLogin } from "./auth.js";
import { updateSidebar } from "./chrome.js";
import { renderHomeActivity } from "./home-view.js";
import { openConfiguredDirectory } from "./platform.js";
import { navigate } from "./router.js";

export function progressOf(task) {
  const size = Number(task.sizeMB) || 0;
  if (size <= 0) return 0;
  return Math.min(100, (task.downloadedMB / size) * 100);
}

export function taskMetrics(task) {
  const percent = Math.min(100, Math.round(progressOf(task)));
  const remaining = Math.max(0, task.sizeMB - task.downloadedMB);

  if (task.status === "downloading") {
    const eta = task.speed > 0 ? remaining / task.speed : null;
    return `
      <span>${formatSize(task.downloadedMB)} / ${formatSize(task.sizeMB)}</span>
      <span class="metric-speed">${formatSpeed(task.speed)}</span>
      <span>剩余 ${formatEta(eta)}</span>
      <span class="task-percent">${percent}%</span>
    `;
  }

  if (task.status === "paused") {
    return `
      <span>${formatSize(task.downloadedMB)} / ${formatSize(task.sizeMB)}</span>
      <span class="${task.error ? "task-error" : ""}">${task.error ? `${icon("alert")}${escapeHtml(task.error)}` : "进度已保留"}</span>
      <span class="task-percent">${percent}%</span>
    `;
  }

  if (task.status === "queued") {
    const limit = store.getState().settings.maxConcurrent;
    const waiting = task.error
      ? `<span class="task-error">${icon("refresh")}${escapeHtml(task.error)}</span>`
      : `<span>${task.downloadedMB > 0 ? `已下载 ${formatSize(task.downloadedMB)} · 等待空闲下载位` : "等待空闲下载位"}</span>`;
    return `
      ${waiting}
      <span>并发上限 ${limit} 个</span>
      <span class="task-percent">${percent}%</span>
    `;
  }

  if (task.status === "failed") {
    return `
      <span class="task-error">${icon("alert")}${escapeHtml(task.error || "下载中断")}</span>
      <span class="task-percent">${percent}%</span>
    `;
  }

  if (task.status === "cancelled") {
    return `
      <span class="task-error">${icon("x")}${escapeHtml(task.error || "任务已取消")}</span>
      <span class="task-percent">${percent}%</span>
    `;
  }

  return `
    <span>已完成 · ${formatSize(task.sizeMB)}</span>
    <span>${escapeHtml(formatHistoryTime(task.completedAt))}</span>
    <span class="task-percent">100%</span>
  `;
}

export function taskErrorAction(task) {
  if (task.errorCode === "auth_required" || task.errorCode === "auth_expired") {
    return `<button class="mini-btn is-accent" type="button" data-action="login">${icon("lock")}登录</button>`;
  }
  if (
    ["vip_required", "disk_full", "permission_denied", "filename_invalid", "risk_control"].includes(
      task.errorCode,
    )
  ) {
    return `<button class="mini-btn" type="button" data-action="settings">${icon("settings")}设置</button>`;
  }
  return "";
}

export function taskActions(task) {
  if (cancellingTaskIds.has(task.id)) {
    return `<button class="mini-btn" type="button" disabled>取消中…</button>`;
  }

  const remove = `<button class="icon-btn is-danger" type="button" data-action="delete" title="移除任务" aria-label="移除任务">${icon("trash")}</button>`;

  if (task.status === "downloading") {
    return `
      <button class="icon-btn" type="button" data-action="pause" title="暂停" aria-label="暂停任务">${icon("pause")}</button>
      <button class="icon-btn is-danger" type="button" data-action="cancel" title="取消下载" aria-label="取消下载任务">${icon("x")}</button>
      ${remove}
    `;
  }
  if (task.status === "paused") {
    return `
      <button class="icon-btn" type="button" data-action="resume" title="继续" aria-label="继续任务">${icon("play")}</button>
      ${taskErrorAction(task)}
      <button class="icon-btn is-danger" type="button" data-action="cancel" title="取消任务" aria-label="取消任务">${icon("x")}</button>
      ${remove}
    `;
  }
  if (task.status === "queued") {
    return `
      <button class="icon-btn" type="button" data-action="prioritize" title="优先下载" aria-label="将任务设为优先下载">${icon("arrow-up")}</button>
      <button class="icon-btn" type="button" data-action="pause" title="暂停等待" aria-label="暂停等待中的任务">${icon("pause")}</button>
      ${remove}
    `;
  }
  if (task.status === "failed") {
    return `
      ${taskErrorAction(task)}
      <button class="mini-btn is-accent" type="button" data-action="retry">${icon("refresh")}重试</button>
      ${remove}
    `;
  }
  if (task.status === "cancelled") {
    return `
      <button class="mini-btn is-accent" type="button" data-action="retry">${icon("refresh")}重新下载</button>
      ${remove}
    `;
  }
  if (task.status === "completed") {
    return `
      ${
        task.outputPath
          ? `<button class="mini-btn" type="button" data-action="reveal">${icon("folder")}${task.kind === "extras" ? "打开文件夹" : "打开文件"}</button>`
          : `<button class="mini-btn" type="button" data-action="folder">${icon("folder")}打开目录</button>`
      }
      ${remove}
    `;
  }
  return remove;
}

export function focusTaskAction(taskId, actionName = "pause") {
  window.requestAnimationFrame(() => {
    const row = $$(".task").find((item) => item.dataset.id === taskId);
    const target = row?.querySelector(`[data-action="${actionName}"]`) || row?.querySelector(".task-actions button");
    (target || $("#page-title"))?.focus({ preventScroll: true });
  });
}

export function focusAfterQueueRemoval(index) {
  window.requestAnimationFrame(() => {
    const rows = $$(".task");
    const row = rows[Math.min(index, rows.length - 1)];
    (row?.querySelector(".task-actions button") || $("#page-title"))?.focus({ preventScroll: true });
  });
}

export function taskRow(task, index) {
  const status = TASK_STATUS[task.status] || TASK_STATUS.queued;
  const percent = progressOf(task).toFixed(1);
  const extra = extrasMeta(task);

  return `
    <article class="task${task.status === "completed" ? " is-completed" : ""}" data-id="${escapeHtml(task.id)}" data-status="${task.status}">
      <span class="task-index" aria-hidden="true">${String(index).padStart(2, "0")}</span>
      <div class="task-cover">
        <img src="${escapeHtml(task.cover)}" alt="" loading="lazy" />
        <span class="task-duration">${escapeHtml(task.duration)}</span>
      </div>
      <div class="task-body">
        <div class="task-top">
          <h3 class="task-title" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</h3>
          <span class="status-badge ${status.className}"><i></i>${status.label}</span>
        </div>
        <div class="task-meta">
          <span>${escapeHtml(task.up)}</span>
          <span class="dot-sep"></span>
          <span>${escapeHtml(task.qualityLabel)}</span>
          <span class="dot-sep"></span>
          <span>${escapeHtml(task.format)}</span>
          <span class="dot-sep"></span>
          <span class="mono">${formatSize(task.sizeMB)}</span>
          ${
            extra.text
              ? `<span class="dot-sep"></span><span class="entry-extra" title="${escapeHtml(extra.title)}">${escapeHtml(extra.text)}</span>`
              : ""
          }
        </div>
        ${
          task.extrasError
            ? `<div class="task-warning" title="${escapeHtml(task.extrasError)}">${icon("alert")}<span>附加内容未完整写入：${escapeHtml(task.extrasError)}</span></div>`
            : ""
        }
        <div class="task-progress">
          <div
            class="progress-track"
            role="progressbar"
            aria-label="${escapeHtml(task.title)} 下载进度"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow="${Math.round(progressOf(task))}"
          ><span class="progress-fill" data-width="${percent}%"></span></div>
          <div class="task-metrics">${taskMetrics(task)}</div>
        </div>
      </div>
      <div class="task-actions">${taskActions(task)}</div>
    </article>
  `;
}

export function emptyQueueMarkup() {
  return `
    <section class="empty-state">
      <div class="empty-visual">
        <span class="empty-dot"></span>
        <span class="empty-core">${icon("layers")}</span>
      </div>
      <h3>队列还是空的</h3>
      <p>${isDesktop ? "粘贴一条链接、选择清晰度，任务就会出现在这里。文件会写入设置的下载目录。" : "粘贴一条链接、选择清晰度，任务就会出现在这里。原型不会写入磁盘，也不会占用带宽。"}</p>
      <button class="btn btn-primary btn-sm" type="button" data-route="download">${icon("arrow-right")}去解析一个链接</button>
    </section>
  `;
}

export function updateQueueLiveSummary() {
  const live = $("#queue-live");
  const summary = $("#queue-live-summary");
  if (!live || !summary) return;

  const active = store.getState().queue.filter((task) => task.status === "downloading");
  if (!active.length) {
    live.hidden = true;
    summary.textContent = "";
    return;
  }

  const speed = active.reduce((sum, task) => sum + (Number(task.speed) || 0), 0);
  const remaining = active.reduce((sum, task) => sum + Math.max(0, task.sizeMB - task.downloadedMB), 0);
  const eta = speed > 0 ? remaining / speed : null;

  live.hidden = false;
  summary.innerHTML = `
    <span><strong>${active.length}</strong> 个任务下载中</span>
    <span class="dot-sep"></span>
    <span>总速度 <strong>${formatSpeed(speed)}</strong></span>
    <span class="dot-sep"></span>
    <span>预计剩余 <strong>${formatEta(eta)}</strong></span>
  `;
}

export function updateQueueToolbar() {
  const tasks = store.getState().queue;
  const groups = groupQueue(tasks);
  const counts = {
    downloading: tasks.filter((task) => task.status === "downloading").length,
    queued: tasks.filter((task) => task.status === "queued").length,
    paused: tasks.filter((task) => task.status === "paused").length,
    ...groups.counts,
  };

  const stats = $("#queue-stats");
  if (stats) {
    stats.innerHTML = `
      <span class="stat-chip" data-tone="active" title="下载 ${counts.downloading} · 等待 ${counts.queued} · 暂停 ${counts.paused}"><i></i><strong>${counts.active}</strong>进行中</span>
      <span class="stat-chip" data-tone="completed"><i></i><strong>${counts.completed}</strong>已完成</span>
      <span class="stat-chip" data-tone="failed"><i></i><strong>${counts.terminated}</strong>已取消/失败</span>
    `;
  }

  const pauseAll = $("#pause-all");
  const resumeAll = $("#resume-all");
  const clearCompleted = $("#clear-completed");
  const clearQueue = $("#clear-queue");

  if (pauseAll) pauseAll.disabled = counts.downloading + counts.queued === 0;
  if (resumeAll) resumeAll.disabled = counts.paused === 0;
  if (clearCompleted) clearCompleted.disabled = counts.completed === 0;
  if (clearQueue) clearQueue.disabled = tasks.length === 0;

  updateQueueLiveSummary();
}

export function taskGroupMarkup(group, title, tasks, startIndex) {
  if (!tasks.length) return "";
  const headingId = `queue-group-${group}`;
  return `
    <section class="task-group" data-group="${group}" aria-labelledby="${headingId}">
      <div class="task-group-head">
        <h3 id="${headingId}">${title}</h3>
        <span class="task-group-count">${tasks.length}</span>
      </div>
      <div class="task-list">
        ${tasks.map((task, index) => taskRow(task, startIndex + index + 1)).join("")}
      </div>
    </section>
  `;
}

export function renderQueue() {
  const queue = store.getState().queue;
  const toolbar = $("#page-queue .page-toolbar");
  if (toolbar) toolbar.hidden = queue.length === 0;

  updateQueueToolbar();

  const container = $("#queue-content");
  if (!container) return;

  if (!queue.length) {
    container.innerHTML = emptyQueueMarkup();
    return;
  }

  const groups = groupQueue(queue);
  const activeMarkup = taskGroupMarkup("active", "进行中", groups.active, 0);
  const completedMarkup = taskGroupMarkup(
    "completed",
    "已完成",
    groups.completed,
    groups.active.length,
  );
  const terminatedMarkup = taskGroupMarkup(
    "terminated",
    "已取消/失败",
    groups.terminated,
    groups.active.length + groups.completed.length,
  );

  container.innerHTML = `<div class="task-groups">${activeMarkup}${completedMarkup}${terminatedMarkup}</div>`;
  applyDynamicWidths(container);
}

export function updateQueueLive() {
  const container = $("#queue-content");
  if (!container) return;

  $$(".task", container).forEach((row) => {
    const task = store.getState().queue.find((item) => item.id === row.dataset.id);
    if (!task) return;
    row.dataset.status = task.status;
    const fill = row.querySelector(".progress-fill");
    const metrics = row.querySelector(".task-metrics");
    const track = row.querySelector(".progress-track");
    if (fill) fill.style.width = `${progressOf(task).toFixed(1)}%`;
    if (track) track.setAttribute("aria-valuenow", String(Math.round(progressOf(task))));
    if (metrics) metrics.innerHTML = taskMetrics(task);
  });

  updateQueueLiveSummary();
}

export function applyDynamicWidths(root) {
  root?.querySelectorAll("[data-width]").forEach((node) => {
    node.style.width = node.dataset.width || "0%";
  });
}


export const TASK_STATUS = {
  downloading: { label: "下载中", className: "status-downloading" },
  paused: { label: "已暂停", className: "status-paused" },
  queued: { label: "等待中", className: "status-queued" },
  failed: { label: "下载失败", className: "status-failed" },
  cancelled: { label: "已取消", className: "status-cancelled" },
  completed: { label: "已完成", className: "status-completed" },
};



// 模板里的动态宽度不能写在 style 属性上（CSP 已禁用内联样式），
// 改为渲染时带 data-width、插入后用 CSSOM 写入——CSSOM 不受 CSP 限制。
$("#queue-content")?.addEventListener("click", async (event) => {
  const action = event.target.closest("[data-action]");
  if (!action) return;
  const row = action.closest(".task");
  if (!row) return;

  const task = store.getState().queue.find((item) => item.id === row.dataset.id);
  if (!task) return;

  const type = action.dataset.action;

  if (type === "prioritize") {
    const prioritized = store.prioritizeTask(task.id);
    if (!prioritized) return;

    renderQueue();
    updateSidebar();

    const updated = store.getState().queue.find((item) => item.id === task.id);
    focusTaskAction(task.id, "pause");
    toast(updated?.status === "downloading" ? "已优先开始下载" : "已设为优先下载", {
      tone: "success",
      duration: 1900,
    });
    return;
  }

  if (type === "pause") {
    store.pauseTask(task.id);
    renderQueue();
    updateSidebar();
    focusTaskAction(task.id, "resume");
    toast("任务已暂停", { tone: "info", duration: 1900 });
    return;
  }

  if (type === "resume") {
    store.resumeTask(task.id);
    renderQueue();
    updateSidebar();
    focusTaskAction(task.id, "pause");
    toast("任务已继续", { tone: "success", duration: 1900 });
    return;
  }

  if (type === "login") {
    navigate("settings");
    window.requestAnimationFrame(() => {
      void startAuthLogin();
    });
    return;
  }

  if (type === "settings") {
    navigate("settings");
    return;
  }

  if (type === "retry") {
    store.retryTask(task.id);
    renderQueue();
    updateSidebar();
    focusTaskAction(task.id, "pause");
    toast("已重新加入下载队列", { tone: "success", message: task.title, duration: 2400 });
    return;
  }

  if (type === "cancel") {
    const choice = await confirmOptionModal({
      title: "取消这个下载任务？",
      message:
        "取消会停止本地下载进程，任务会保留在“已取消/失败”分组中，之后仍可重新下载。",
      target: task.title,
      confirmText: "取消任务",
      cancelText: "继续下载",
      iconName: "alert",
      checkbox: {
        label: "同时删除已下载的临时文件",
        description: "勾选后重新下载会从头开始；不勾选则保留临时文件以便续传。",
        checked: false,
      },
    });
    if (!choice?.confirmed) return;

    cancellingTaskIds.add(task.id);
    renderQueue();
    updateSidebar();
    const result = await store.cancelTask(task.id, { deletePartial: choice.checked });
    cancellingTaskIds.delete(task.id);
    renderQueue();
    updateSidebar();
    if (!result?.ok) {
      toast("无法取消任务", {
        tone: "error",
        message: result?.message || "请稍后重试。",
      });
      return;
    }

    focusTaskAction(task.id, "retry");
    let message = "可以点击“重新下载”继续，或从队列移除。";
    if (!isDesktop) {
      message = "浏览器预览只更新任务状态，不会删除真实文件。";
    } else if (result.partialDeleted) {
      message = "临时文件已删除，重新下载会从头开始。";
    } else if (result.deleteError) {
      message = `临时文件删除失败：${result.deleteError}`;
    }
    toast("任务已取消", {
      tone: result.deleteError ? "warning" : "info",
      message,
      duration: result.deleteError ? 3600 : 2400,
    });
    return;
  }

  if (type === "reveal") {
    const ok =
      task.kind === "extras"
        ? await desktop.openDirectory(task.outputPath)
        : await desktop.revealFile(task.outputPath);
    if (!ok) {
      toast(task.kind === "extras" ? "无法打开文件夹" : "无法定位下载文件", {
        tone: "error",
        message: "文件可能已被移动或删除。",
      });
    }
    return;
  }

  if (type === "folder") {
    await openConfiguredDirectory();
    return;
  }

  if (type === "delete") {
    const hasFile = Boolean(task.outputPath);
    let confirmed = false;
    let deleteFile = false;
    if (hasFile) {
      const choice = await confirmOptionModal({
        title: "从队列移除这个任务？",
        message: isDesktop
          ? "移除后任务会从队列消失；勾选后将同时删除磁盘上的文件。"
          : "移除后任务会从队列消失；浏览器预览不会操作任何本地文件。",
        target: task.title,
        confirmText: "移除",
        checkbox: {
          label: "同时删除已下载的文件",
          description:
            task.kind === "extras"
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
        title: "从队列移除这个任务？",
        message: isDesktop
          ? "移除后进度将不再保留，临时文件会一并清理。"
          : "移除后进度将不再保留；浏览器预览不会操作任何本地文件。",
        target: task.title,
        confirmText: "移除",
      });
    }
    if (!confirmed) return;

    const index = $$(".task").findIndex((row) => row.dataset.id === task.id);
    const result = await store.removeTask(task.id, { deleteFile });
    if (!result?.ok) {
      toast("无法移除任务", {
        tone: "error",
        message: result?.message || "请稍后重试。",
      });
      return;
    }
    renderQueue();
    updateSidebar();
    focusAfterQueueRemoval(index);
    let message = "任务已从队列移除。";
    if (!isDesktop) {
      message = "浏览器预览只移除任务，不会删除真实文件。";
    } else if (result.fileError) {
      message = `任务已移除，但部分字幕/弹幕文件未能删除：${result.fileError}`;
    } else if (deleteFile && result.fileDeleted) {
      message = "任务已移除，下载文件已删除。";
    } else if (deleteFile) {
      message = "任务已移除；没有找到下载文件。";
    }
    toast("已从队列移除", {
      tone: result.fileError ? "warning" : "success",
      message,
      duration: result.fileError ? 3600 : 2200,
    });
  }
});

$("#pause-all")?.addEventListener("click", () => {
  const count = store.pauseAll();
  if (!count) return;
  renderQueue();
  updateSidebar();
  toast(`已暂停 ${count} 个任务`, { tone: "info", duration: 2100 });
});

$("#resume-all")?.addEventListener("click", () => {
  const count = store.resumeAll();
  if (!count) return;
  renderQueue();
  updateSidebar();
  toast(`已继续 ${count} 个任务`, { tone: "success", duration: 2100 });
});

$("#clear-completed")?.addEventListener("click", () => {
  const count = store.clearCompleted();
  if (!count) return;
  renderQueue();
  updateSidebar();
  $("#page-title")?.focus({ preventScroll: true });
  toast(`已清除 ${count} 个已完成任务`, { tone: "success", duration: 2200 });
});

$("#clear-queue")?.addEventListener("click", async () => {
  const queue = store.getState().queue;
  if (!queue.length) return;

  const activeCount = queue.filter((task) => ["downloading", "queued"].includes(task.status)).length;
  const confirmed = await confirmModal({
    title: "清空整个下载队列？",
    message: isDesktop ? "所有可移除任务都会从队列移除。历史记录与已下载文件不受影响。" : "所有任务都会从队列移除。历史记录与本机文件不受影响，原型也不会删除任何真实文件。",
    target: `${queue.length} 个任务${activeCount ? `（其中 ${activeCount} 个进行中或排队）` : ""}`,
    confirmText: "清空队列",
  });
  if (!confirmed) return;

  const count = store.clearQueue();
  renderQueue();
  updateSidebar();
  renderHomeActivity();
  $("#page-title")?.focus({ preventScroll: true });
  toast(`已清空队列（${count} 个任务）`, { tone: "success" });
});
