// @ts-check
// 入队：把当前选择打包成任务，分批提交，并给出结果提示。

import { toast } from "../ui.js";
import { store } from "../runtime.js";
import { isDesktop } from "../bridge.js";
import { seasonEpisodeSource, seasonEpisodes } from "./season-panel.js";
import { currentSelection } from "./selection.js";
import { updateSidebar } from "./chrome.js";
import { navigate } from "./router.js";
import { renderHomeActivity } from "./home-view.js";
import { parseExtras, parseState, setEnqueuePending, setEnqueueProgress } from "./parse-store.js";
import { formatCount } from "../ui.js";
import { updateEnqueueAction } from "./action-bar.js";
import { enqueuePending, extrasPending, setExtrasPending } from "./parse-store.js";
import { selectedDanmakuTotal } from "./selection.js";

/** 批量入队时每批并发数：过大只会把后端 DB 锁排队放大，10 是实测的折中值。 */
export const ENQUEUE_BATCH_SIZE = 10;

export function enqueueCurrent() {
  if (!parseState.video) return;
  void enqueueCurrentAsync();
}

export async function enqueueCurrentAsync() {
  if (!parseState.video || enqueuePending) return;
  setEnqueuePending(true);
  setEnqueueProgress({ done: 0, total: 0 });
  updateEnqueueAction();
  try {
    await enqueueCurrentInner();
  } finally {
    setEnqueuePending(false);
    setEnqueueProgress({ done: 0, total: 0 });
    updateEnqueueAction();
  }
}

export async function enqueueCurrentInner() {
  if (!parseState.video) return;
  if (!parseState.quality) {
    updateEnqueueAction();
    toast("当前没有可下载的清晰度", {
      tone: "info",
      message: isDesktop
        ? "当前视频没有可下载的清晰度，请尝试重新解析或换一个视频。"
        : "当前账号状态没有可下载的清晰度；可在设置中切换演示账号状态，或换一个支持的视频。",
    });
    return;
  }

  const selection = currentSelection();
  const video = parseState.video;
  const selectedPages = [...parseExtras.pageSelection].sort((a, b) => a - b);
  const pages = video.pages || [];
  // 合集勾选优先：勾了合集条目就只下这些独立 BV，不再叠加当前视频的分 P。
  const seasonPicks = seasonEpisodes().filter((episode) =>
    parseExtras.seasonSelection.has(episode.bvid),
  );
  // 勾了多集就逐个入队；没勾 or 单 P 时保持原有单任务行为（pageIndex 不传）。
  const pageList =
    selectedPages.length > 0
      ? selectedPages
          .map((index) => pages.find((page) => page.index === index))
          .filter(Boolean)
      : [null];
  const targets = seasonPicks.length
    ? seasonPicks.map((episode) => ({ source: seasonEpisodeSource(video, episode), page: null }))
    : pageList.map((page) => ({ source: video, page }));
  const shared = {
    danmakuTypes: [...selection.danmakuTypes],
    subtitles: [...selection.subtitles],
  };
  // 两端都填才生效：只填一端后端会以 invalid_section 拒绝，不如前端直接不发。
  const sectionRange =
    parseExtras.sectionStart && parseExtras.sectionEnd
      ? { sectionStart: parseExtras.sectionStart, sectionEnd: parseExtras.sectionEnd }
      : {};
  const audioIds = parseExtras.audioTrackIds.length
    ? { audioTrackIds: [...parseExtras.audioTrackIds] }
    : {};
  const results = [];
  // 逐条 await 会让大批量入队期间界面完全不动；按批并发并在批间让出，兼顾速度与进度反馈。
  setEnqueueProgress({ done: 0, total: targets.length });
  for (let index = 0; index < targets.length; index += ENQUEUE_BATCH_SIZE) {
    const batch = targets.slice(index, index + ENQUEUE_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(({ source, page }) => {
        const options = {
          ...(page ? { pageIndex: page.index, pageTitle: page.title || "" } : {}),
          ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
          ...sectionRange,
          ...audioIds,
        };
        return store.addTask(source, parseState.quality, shared, { taskOptions: options });
      }),
    );
    results.push(...batchResults);
    setEnqueueProgress({ done: results.length, total: targets.length });
    updateEnqueueAction();
    // 让浏览器重绘一次，进度文案才会更新。
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }
  const result = results[0] || { ok: false };
  if (!result.ok) {
    updateEnqueueAction();
    if (result.reason === "unavailable" || result.reason === "format_unavailable") {
      toast("清晰度不可用", {
        tone: "info",
        message: result.message || "该清晰度不在视频支持范围内，请重新解析后再试。",
      });
      return;
    }
    if (result.reason === "duplicate") {
      toast("这个任务已经在队列中", {
        tone: "info",
        message: "相同视频与清晰度已在队列中；如需更改清晰度，请先从队列移除后重新添加。",
        action: { label: "查看队列", onClick: () => navigate("queue") },
      });
      return;
    }
    if (result.reason === "in_flight") {
      toast("正在加入队列", {
        tone: "info",
        message: result.message || "请稍候，不要重复点击。",
        duration: 1800,
      });
      return;
    }
    toast("无法加入下载队列", {
      tone: "error",
      message: result.message || "请稍后重试。",
    });
    return;
  }

  updateEnqueueAction();
  updateSidebar();
  renderHomeActivity();

  if (targets.length > 1) {
    const succeeded = results.filter((item) => item.ok).length;
    const failed = results.length - succeeded;
    toast(succeeded ? "已批量加入下载队列" : "批量入队失败", {
      tone: failed ? "warning" : "success",
      message: failed
        ? `成功 ${succeeded} 个，失败 ${failed} 个：${results.find((item) => !item.ok)?.message || "请查看队列"}`
        : `已加入 ${succeeded} 个任务，各自单独排队。`,
      action: { label: "查看队列", onClick: () => navigate("queue") },
    });
    return;
  }

  const extraParts = [];
  if (result.task.danmakuTypes?.length) {
    extraParts.push(`弹幕 ${result.task.danmakuTypes.length} 类 · ${formatCount(result.task.danmakuCount)} 条`);
  }
  if (result.task.subtitles?.length) {
    extraParts.push(`字幕 ${result.task.subtitles.length} 项`);
  }

  toast("已加入下载队列", {
    tone: "success",
    message: [result.task.title, result.task.qualityLabel, ...extraParts].filter(Boolean).join(" · "),
    action: { label: "查看队列", onClick: () => navigate("queue") },
  });
}

export function selectedQualityLabel() {
  const video = parseState.video;
  if (!video) return "";
  const quality = (video.qualityOptions || []).find(
    (item) => (item.formatId || item.id) === parseState.quality,
  );
  return quality?.label || "";
}

export function enqueueExtrasCurrent() {
  if (!parseState.video) return;
  void enqueueExtrasCurrentAsync();
}

export async function enqueueExtrasCurrentAsync() {
  if (!parseState.video || extrasPending) return;
  const selection = currentSelection();
  if (!selection.danmakuTypes.length && !selection.subtitles.length) {
    toast("请先选择弹幕或字幕", {
      tone: "info",
      message: "勾选至少一种弹幕类型或字幕语言后再单独下载。",
    });
    updateEnqueueAction();
    return;
  }

  setExtrasPending(true);
  updateEnqueueAction();
  try {
    const result = await store.addExtrasTask(
      parseState.video,
      { ...selection, danmakuCount: selectedDanmakuTotal() },
      { qualityLabel: selectedQualityLabel() },
    );
    if (!result.ok) {
      if (result.reason === "duplicate") {
        toast("附加内容已在队列中", {
          tone: "info",
          message: "该视频的弹幕/字幕任务尚未结束；请先移除后再试。",
          action: { label: "查看队列", onClick: () => navigate("queue") },
        });
      } else if (result.reason === "in_flight") {
        toast("正在加入队列", {
          tone: "info",
          message: result.message || "请稍候，不要重复点击。",
          duration: 1800,
        });
      } else {
        toast("无法加入弹幕/字幕下载", {
          tone: "error",
          message: result.message || "请稍后重试。",
        });
      }
      return;
    }

    updateSidebar();
    renderHomeActivity();

    const extraParts = [];
    if (result.task.danmakuTypes?.length) {
      extraParts.push(`弹幕 ${result.task.danmakuTypes.length} 类 · ${formatCount(result.task.danmakuCount)} 条`);
    }
    if (result.task.subtitles?.length) {
      extraParts.push(`字幕 ${result.task.subtitles.length} 项`);
    }

    toast("已加入弹幕/字幕下载", {
      tone: "success",
      message: [result.task.title, ...extraParts].filter(Boolean).join(" · "),
      action: { label: "查看队列", onClick: () => navigate("queue") },
    });
  } finally {
    setExtrasPending(false);
    updateEnqueueAction();
  }
}
