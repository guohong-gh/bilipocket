// @ts-check
// 全局「刷新总线」：侧栏、数据摘要、完成通知、定时轮询。
// 这两个函数被多个视图调用，但只读 store 写 DOM，没有副作用顺序要求。

import { $, formatCount, formatSize, toast } from "../ui.js";
import { groupQueue } from "../queue-model.js";
import { isDesktop } from "../bridge.js";
import * as desktop from "../tauri.js";
import { parseState } from "./parse-store.js";
import { navigate } from "./router.js";
import { renderQueue, updateQueueLive } from "./queue-view.js";
import { renderHistory } from "./history-view.js";
import { renderHomeActivity, renderRecent, updateHomeActivityLive } from "./home-view.js";
import { updateEnqueueAction } from "./action-bar.js";
import { store } from "../runtime.js";
import { formatDurationSeconds } from "./format.js";
import { extrasMeta } from "./selection.js";
import { currentRoute } from "./router.js";
import { sendNotification } from "../tauri.js";


export let ticker = null;

export function updateSidebar() {
  const pending = store.pendingCount();
  const badge = $("#nav-queue-count");
  if (badge) {
    badge.textContent = String(pending);
    badge.hidden = pending <= 0;
  }

  const active = store.activeCount();
  document.title = active > 0 ? `(${active}) 下载中 · BiliPocket` : "BiliPocket · 轻量哔哩下载器";

  updateDataSummary();
}

export function updateDataSummary() {
  const summary = $("#data-summary");
  if (!summary) return;
  const { queue, history } = store.getState();
  const groups = groupQueue(queue);
  summary.textContent = `队列 ${queue.length} · 进行中 ${groups.counts.active} · 已完成 ${groups.counts.completed} · 历史 ${history.length}`;
}

export function announceCompletion(tasks) {
  const settings = store.getState().settings;

  tasks.forEach((task) => {
    const shortTitle = task.title.length > 22 ? `${task.title.slice(0, 22)}…` : task.title;
    const isExtras = task.kind === "extras";
    const extra = extrasMeta(task);
    toast(isExtras ? `《${shortTitle}》弹幕/字幕已保存` : `《${shortTitle}》下载完成`, {
      tone: "success",
      message: isExtras
        ? extra.text || "附加内容已保存"
        : `${task.qualityLabel} · ${formatSize(task.sizeMB)}${isDesktop ? "" : " · 模拟任务"}`,
      action: { label: "查看历史", onClick: () => navigate("history") },
      duration: 5600,
    });

    if (task.extrasError) {
      toast("部分附加内容未写入", {
        tone: "info",
        message: task.extrasError,
        duration: 6000,
      });
    }

    if (!isDesktop && settings.notifyOnComplete) {
      desktop.sendNotification(
        isExtras ? "BiliPocket · 模拟附加内容保存" : "BiliPocket · 模拟下载完成",
        isExtras
          ? `${task.title}（弹幕/字幕）\n原型演示：未写入任何文件`
          : `${task.title}（${task.qualityLabel}）\n原型演示：未写入任何文件`,
      );
    }
  });
}

export function startTicker() {
  window.clearInterval(ticker);
  ticker = window.setInterval(() => {
    const result = store.tick();
    if (!result.progressChanged && !result.structureChanged && !result.completed.length) return;

    updateSidebar();

    if (currentRoute === "queue") {
      if (result.structureChanged) renderQueue();
      else updateQueueLive();
    }

    if (currentRoute === "download" && parseState.status === "idle") {
      if (result.structureChanged || result.completed.length) renderHomeActivity();
      else updateHomeActivityLive();
    }

    if (result.completed.length) {
      if (currentRoute === "history") renderHistory();
      renderRecent();
      renderHomeActivity();
      updateEnqueueAction();
      announceCompletion(result.completed);
    }
  }, 800);
}


