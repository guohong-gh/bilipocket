// @ts-check
// 解析会话的共享状态。
//
// 这些值被解析、结果页、入队、队列等多个视图读写，放在这里由所有人 import 同一份实例。
// 注意：跨模块不能给导入绑定重新赋值（ESM 语法层面禁止），所以整体替换一律走
// `setXxx()` / `resetXxx()`；对象内部属性仍然可以直接改（那只是属性写入）。

import { SEASON_PAGE_SIZE } from "../catalog.js";

export let parseState = {
  status: "idle",
  video: null,
  quality: null,
  qualitySource: "auto",
  selection: { danmakuTypes: [], subtitles: [] },
  error: null,
  input: "",
};

export function setParseState(next) {
  parseState = next;
}

// 一个 BV 下的分 P 勾选、片段区间、附加音轨；独立于 parseState 重置。
export function freshParseExtras() {
  return {
    pageSelection: new Set(),
    sectionStart: "",
    sectionEnd: "",
    audioTrackIds: [],
    // 合集勾选按 bvid 记录；搜索关键词只影响展示，不影响已勾选内容。
    seasonSelection: new Set(),
    seasonQuery: "",
    // 一次渲染多少条；搜索词变化时重置，避免沿用上一次的展开量。
    seasonLimit: SEASON_PAGE_SIZE,
  };
}

export let parseExtras = freshParseExtras();

export function setParseExtras(next) {
  parseExtras = next;
}

/** 重新解析时把分 P / 片段 / 音轨 / 合集的勾选全部清空。 */
export function resetParseExtras() {
  parseExtras = freshParseExtras();
}

export let enqueuePending = false;

export function setEnqueuePending(next) {
  enqueuePending = next;
}

// 批量入队进度：只在 total > 1 时展示，单条入队保持原文案。
export let enqueueProgress = { done: 0, total: 0 };

export function setEnqueueProgress(next) {
  enqueueProgress = next;
}

export let extrasPending = false;

export function setExtrasPending(next) {
  extrasPending = next;
}

/** 正在取消中的任务 id，避免重复点击。只增删元素，不整体替换。 */
export const cancellingTaskIds = new Set();
