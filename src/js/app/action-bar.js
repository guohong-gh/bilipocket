// @ts-check
// 主操作按钮的状态机：是否可下载、是否已在队列、批量进度文案。

import { icon } from "../ui.js";
import { $ } from "../ui.js";
import { store } from "../runtime.js";
import { enqueueProgress, enqueuePending, extrasPending, parseExtras, parseState } from "./parse-store.js";
import { selectedExtraIds } from "./selection.js";

export function updateEnqueueAction() {
  const button = $("#enqueue-btn");
  const extrasButton = $("#enqueue-extras-btn");
  const video = parseState.video;

  if (button) {
    if (enqueuePending) {
      button.disabled = true;
      const { done, total } = enqueueProgress;
      const progressLabel = total > 1 ? `正在加入 ${done}/${total}…` : "正在加入队列…";
      button.title = progressLabel;
      button.innerHTML = `${icon("refresh")}<span>${progressLabel}</span>`;
    } else {
      const hasQuality = Boolean(video && parseState.quality);
      const seasonCount = parseExtras.seasonSelection.size;
      const duplicate = hasQuality ? store.findDuplicate(video.bvid, parseState.quality, "video") : null;

      if (!hasQuality) {
        button.disabled = true;
        button.title = "当前账号状态没有可下载的清晰度。";
        button.innerHTML = `${icon("alert")}<span>暂无可下载清晰度</span>`;
      } else if (seasonCount > 0) {
        // 合集模式按勾选逐个入队，与「当前视频是否已在队列」无关。
        button.disabled = false;
        button.title = `按当前清晰度逐个下载已勾选的 ${seasonCount} 个合集条目。`;
        button.innerHTML = `${icon("download")}<span>下载已选 ${seasonCount} 个</span>`;
      } else {
        button.disabled = Boolean(duplicate);
        button.title = duplicate
          ? "同一视频与清晰度已在队列中；如需更改弹幕/字幕，请先从队列移除后重新添加。"
          : "";
        button.innerHTML = duplicate
          ? `${icon("check")}<span>已在队列中</span>`
          : `${icon("download")}<span>加入下载队列</span>`;
      }
    }
  }

  if (!extrasButton) return;
  const hasSelection =
    Boolean(video) &&
    (selectedExtraIds("danmaku").length > 0 || selectedExtraIds("subtitles").length > 0);
  const duplicate = video ? store.findDuplicate(video.bvid, "", "extras") : null;
  if (extrasPending) {
    extrasButton.disabled = true;
    extrasButton.title = "正在加入队列…";
    extrasButton.innerHTML = `${icon("refresh")}<span>正在加入…</span>`;
  } else if (!hasSelection) {
    extrasButton.disabled = true;
    extrasButton.title = "请先选择要下载的弹幕类型或字幕语言。";
    extrasButton.innerHTML = `${icon("download")}<span>仅下载弹幕/字幕</span>`;
  } else if (duplicate) {
    extrasButton.disabled = true;
    extrasButton.title = "附加内容已在队列中；请先从队列移除后重新添加。";
    extrasButton.innerHTML = `${icon("check")}<span>附加内容已在队列</span>`;
  } else {
    extrasButton.disabled = false;
    extrasButton.title = "不下载视频，只保存所选弹幕/字幕。";
    extrasButton.innerHTML = `${icon("download")}<span>仅下载弹幕/字幕</span>`;
  }
}
