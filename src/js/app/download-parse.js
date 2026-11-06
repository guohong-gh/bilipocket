// @ts-check
// 解析流程：输入校验、发起解析、加载/错误态、探测结果转视图模型。

import { SEASON_PAGE_SIZE } from "../catalog.js";
import { $$, $, toast, } from "../ui.js";
import { isDesktop, assetUrl } from "../bridge.js";
import { demoLookup } from "../runtime.js";
import { formatDurationSeconds, formatPublishedDate } from "./format.js";
import { content, parseButton, stageResult, urlField, urlInput } from "./dom.js";
import { parseExtras, parseState, resetParseExtras, setParseState } from "./parse-store.js";
import { closeExtrasDrawer, defaultSelection } from "./selection.js";
import { renderResult } from "./result-view.js";
import { renderHomeActivity, renderRecent } from "./home-view.js";
import { desktopBridge } from "../bridge.js";
import { AUTO_QUALITY, resolvePreferredQuality } from "../catalog.js";
import { store } from "../runtime.js";
import { dismissToastKind, formatCount, icon } from "../ui.js";
import { demoSamples } from "../runtime.js";
import { parseForm, quickForm, quickInput } from "./dom.js";
import { navigate } from "./router.js";

export function setParsing(active) {
  if (!parseButton) return;
  parseButton.disabled = active;
  parseButton.classList.toggle("is-loading", active);
  const spinner = parseButton.querySelector(".btn-spinner");
  const bolt = parseButton.querySelector(".btn-icon");
  const label = parseButton.querySelector(".btn-label");
  if (spinner) spinner.hidden = !active;
  if (bolt) bolt.style.display = active ? "none" : "";
  if (label) label.textContent = active ? "解析中" : "解析视频";
}

export function showStage(stage) {
  ["idle", "loading", "result", "error"].forEach((name) => {
    const element = document.getElementById(`stage-${name}`);
    if (element) element.hidden = name !== stage;
  });
}

export function hideFieldError() {
  const error = $("#field-error");
  if (error) error.hidden = true;
  urlField?.classList.remove("is-error");
  urlInput?.removeAttribute("aria-invalid");
  urlInput?.setAttribute("aria-describedby", "parse-hint");
}

export function showFieldError(message) {
  const error = $("#field-error");
  const text = $("#field-error-text");
  if (text) text.textContent = message;
  if (error) error.hidden = false;
  urlField?.classList.add("is-error");
  urlInput?.setAttribute("aria-invalid", "true");
  urlInput?.setAttribute("aria-describedby", "parse-hint field-error");
}

export function markInputShake() {
  if (!urlField) return;
  urlField.classList.remove("shake");
  void urlField.offsetWidth;
  urlField.classList.add("shake");
  window.setTimeout(() => urlField.classList.remove("shake"), 380);
}

export function validateInput(raw) {
  const value = String(raw ?? "").trim();

  if (!value) {
    return { ok: false, message: "先粘贴一个视频链接或 BV 号。" };
  }
  if (value.length > 500) {
    return { ok: false, message: "输入内容过长，请确认链接是否完整。" };
  }

  const hasBv = BV_PATTERN.test(value);
  const hasAv = AV_PATTERN.test(value);
  const hasVideoUrl = BILI_VIDEO_URL_PATTERN.test(value) || B23_URL_PATTERN.test(value);
  const looksLikeBilibili = BILI_HOST_PATTERN.test(value);

  if (!hasBv && !hasAv && !hasVideoUrl) {
    return {
      ok: false,
      message: looksLikeBilibili
        ? "这个链接里没有可识别的视频 ID。仅支持单条视频页面、b23.tv 短链或 BV / av 号。"
        : "没有识别到有效的哔哩哔哩视频链接或 BV 号。",
    };
  }

  return {
    ok: true,
    video: demoLookup(value),
    simulatedFailure: SIMULATED_FAILURE_PATTERN.test(value),
  };
}

export function showErrorStage(message, { iconName = "alert", markInput = false } = {}) {
  const iconUse = $("#stage-error .error-icon use");
  if (iconUse) iconUse.setAttribute("href", `#i-${iconName}`);
  const reason = $("#error-reason");
  if (reason) reason.textContent = message;

  parseState.status = "error";
  parseState.error = message;
  parseState.quality = null;
  parseState.qualitySource = "auto";
  parseState.selection = { danmakuTypes: [], subtitles: [] };
  urlField?.classList.toggle("is-error", markInput);
  showStage("error");
}

export function startParse(rawValue = urlInput?.value) {
  window.clearTimeout(parseTimer);
  closeExtrasDrawer({ restoreFocus: false });
  dismissToastKind("parse");
  const value = String(rawValue ?? "").trim();
  const validation = validateInput(value);

  if (!validation.ok) {
    setParsing(false);
    showFieldError(validation.message);
    showErrorStage(validation.message, { iconName: "alert", markInput: true });
    markInputShake();
    urlInput?.focus();
    toast("链接格式不正确", { tone: "error", message: validation.message, kind: "parse" });
    return;
  }

  if (isDesktop) {
    void startDesktopParse(value);
    return;
  }

  const token = ++parseToken;
  hideFieldError();
  resetParseExtras();
  setParseState({
    status: "loading",
    video: null,
    quality: null,
    qualitySource: "auto",
    selection: { danmakuTypes: [], subtitles: [] },
    error: null,
    input: value,
  });
  setParsing(true);
  showStage("loading");

  parseTimer = window.setTimeout(() => {
    if (token !== parseToken) return;

    setParsing(false);

    if (validation.simulatedFailure) {
      const message = "模拟的网络请求超时。原型不会访问真实接口，可以重试或换一条链接。";
      showErrorStage(message, { iconName: "wifi-off", markInput: false });
      toast("模拟解析失败", {
        tone: "error",
        message: "链接中包含 fail / error 时会触发这个演示状态。",
        kind: "parse",
      });
      return;
    }

    const settings = store.getState().settings;
    const quality = resolvePreferredQuality(validation.video, settings.preferredQuality, settings.accountTier);
    const qualitySource = settings.preferredQuality === AUTO_QUALITY ? "auto" : "preference";

    setParseState({
      status: "result",
      video: validation.video,
      quality,
      qualitySource,
      selection: defaultSelection(validation.video),
      error: null,
      input: value,
    });

    renderResult();
    showStage("result");

    window.requestAnimationFrame(() => {
      const container = content?.getBoundingClientRect();
      const target = stageResult.querySelector(".result-actions") || stageResult;
      const targetBox = target.getBoundingClientRect();
      if (container && targetBox.bottom > container.bottom + 10) {
        target.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
  }, 1500);
}

export function resetParse({ focus = true, clearInput = true } = {}) {
  window.clearTimeout(parseTimer);
  closeExtrasDrawer({ restoreFocus: false });
  parseToken += 1;
  setParsing(false);
  setParseState({
    status: "idle",
    video: null,
    quality: null,
    qualitySource: "auto",
    selection: { danmakuTypes: [], subtitles: [] },
    error: null,
    input: "",
  });

  if (clearInput && urlInput) urlInput.value = "";
  hideFieldError();
  stageResult.innerHTML = "";
  $("#stage-error .error-icon use")?.setAttribute("href", "#i-alert");
  showStage("idle");
  renderRecent();
  renderHomeActivity();
  if (focus) urlInput?.focus();
}

export function videoFromProbe(probe) {
  const subtitleTracks = (probe.subtitles || []).map((track) => ({
    id: track.id,
    label: track.label || track.id,
    ext: track.ext || "srt",
    accessible: track.accessible !== false,
    reason: track.reason || "",
  }));
  const counts = probe.danmaku?.counts || {};
  const danmakuTypeCounts = {
    scroll: Number(counts.scroll) || 0,
    top: Number(counts.top) || 0,
    bottom: Number(counts.bottom) || 0,
    reverse: Number(counts.reverse) || 0,
    advanced: Number(counts.advanced) || 0,
  };
  return {
    __real: true,
    probe,
    sourceUrl: probe.sourceUrl,
    bvid: probe.bvid || "",
    title: probe.title || "未命名视频",
    up: probe.uploader || "未知 UP 主",
    avatarLetter: (probe.uploader || "未").slice(0, 1),
    views: probe.viewCount ? formatCount(probe.viewCount) : "—",
    danmaku: probe.danmaku?.count
      ? formatCount(probe.danmaku.count)
      : probe.apiDanmakuCount
        ? formatCount(probe.apiDanmakuCount)
        : "—",
    published: formatPublishedDate(probe.publishedAt),
    duration: formatDurationSeconds(probe.durationSeconds),
    durationSeconds: probe.durationSeconds,
    intro: String(probe.description || "").trim() || "该视频没有简介。",
    cover: assetUrl(probe.coverPath) || "./assets/cover-placeholder.svg",
    coverPath: probe.coverPath || null,
    coverUrl: probe.coverUrl || null,
    sizes: {},
    subtitles: subtitleTracks.filter((track) => track.accessible).map((track) => track.id),
    subtitleTracks,
    danmakuTypeCounts,
    qualityOptions: probe.qualities || [],
    recommendedQuality: probe.recommendedQuality || null,
    engineVersion: probe.engineVersion,
    warnings: probe.warnings || [],
    publishedAt: probe.publishedAt ?? null,
    pages: Array.isArray(probe.pages) ? probe.pages : [],
    audioTracks: Array.isArray(probe.audioTracks) ? probe.audioTracks : [],
    season: probe.season?.episodes?.length ? probe.season : null,
  };
}

export function resolveDesktopQuality(video, preferred) {
  const options = video.qualityOptions || [];
  const accessible = options.filter((quality) => quality.accessible !== false);
  if (!accessible.length) return null;
  if (preferred && preferred !== AUTO_QUALITY) {
    const match = accessible.find(
      (quality) => quality.formatId === preferred || quality.label === preferred,
    );
    if (match) return match.formatId;

    const targetIndex = options.findIndex(
      (quality) => quality.formatId === preferred || quality.label === preferred,
    );
    if (targetIndex >= 0) {
      /** @type {{ quality: any, distance: number, index: number } | null} */
      let best = null;
      options.forEach((quality, index) => {
        if (quality.accessible === false) return;
        const distance = Math.abs(index - targetIndex);
        if (
          !best ||
          distance < best.distance ||
          (distance === best.distance && index > best.index)
        ) {
          best = { quality, distance, index };
        }
      });
      if (best) return best.quality.formatId;
    }
  }
  const recommended = accessible.find((quality) => quality.formatId === video.recommendedQuality);
  return (recommended || accessible[0]).formatId;
}

export async function startDesktopParse(value) {
  const token = ++parseToken;
  window.clearTimeout(parseTimer);
  hideFieldError();
  resetParseExtras();
  setParseState({
    status: "loading",
    video: null,
    quality: null,
    qualitySource: "auto",
    selection: { danmakuTypes: [], subtitles: [] },
    error: null,
    input: value,
  });
  setParsing(true);
  showStage("loading");

  try {
    const probe = await store.desktopBridge.probeVideo(value);
    if (token !== parseToken) return;
    setParsing(false);
    const video = videoFromProbe(probe);
    const preferred = store.getState().settings.preferredQuality;
    const quality = resolveDesktopQuality(video, preferred);
    setParseState({
      status: "result",
      video,
      quality,
      qualitySource: preferred === AUTO_QUALITY ? "auto" : "preference",
      selection: defaultSelection(video),
      error: null,
      input: value,
    });
    renderResult();
    showStage("result");
    window.requestAnimationFrame(() => {
      const container = content?.getBoundingClientRect();
      const target = stageResult.querySelector(".result-actions") || stageResult;
      const targetBox = target.getBoundingClientRect();
      if (container && targetBox.bottom > container.bottom + 10) {
        target.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
  } catch (error) {
    if (token !== parseToken) return;
    setParsing(false);
    const code = error?.code || error?.payload?.code || "parse_failed";
    const message = error?.message || error?.payload?.message || String(error);
    const iconName = code === "timeout" || code === "network" ? "wifi-off" : "alert";
    showErrorStage(message, { iconName, markInput: true });
    markInputShake();
    toast("解析失败", { tone: "error", message, kind: "parse" });
  }
}


export const BV_PATTERN = /BV[1-9A-HJ-NP-Za-km-z]{10}/;
export const BILI_HOST_PATTERN = /^(?:https?:\/\/)?(?:[\w-]+\.)*(?:bilibili\.com|b23\.tv)(?:\/|$)/i;
export const BILI_VIDEO_URL_PATTERN =
  /^(?:https?:\/\/)?(?:[\w-]+\.)*bilibili\.com\/video\/(?:BV[1-9A-HJ-NP-Za-km-z]{10}|av\d{1,12})(?:[/?#]|$)/i;
export const B23_URL_PATTERN = /^(?:https?:\/\/)?b23\.tv\/[A-Za-z0-9]+(?:[/?#]|$)/i;
export const AV_PATTERN = /\bav\d{1,12}\b/i;
export const SIMULATED_FAILURE_PATTERN = /(?:fail|error|失败)/i;
export let parseTimer = null;
export let parseToken = 0;

parseForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  startParse();
});

urlInput?.addEventListener("input", () => {
  if (!urlField?.classList.contains("is-error")) return;
  hideFieldError();
});

$("#paste-btn")?.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      toast("剪贴板是空的", { tone: "info", duration: 2200 });
      return;
    }
    urlInput.value = text.trim();
    hideFieldError();
    urlInput.focus();
    toast("已从剪贴板粘贴", { tone: "success", duration: 1800 });
  } catch {
    toast("无法读取剪贴板", {
      tone: "error",
      message: "请点击输入框后使用 Ctrl+V 粘贴。",
    });
    urlInput?.focus();
  }
});

$$(".sample-chip").forEach((button) => {
  button.addEventListener("click", () => {
    const sample = demoSamples.find((item) => item.key === button.dataset.sample);
    if (!sample) return;
    const url = `https://www.bilibili.com/video/${sample.bvid}`;
    urlInput.value = url;
    startParse(url);
  });
});

$("#retry-parse")?.addEventListener("click", () => startParse(urlInput.value));
$("#reset-parse")?.addEventListener("click", () => resetParse({ focus: true, clearInput: true }));

quickForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = quickInput.value.trim();
  if (!value) {
    quickInput.focus();
    toast("先输入一个链接", { tone: "info", duration: 2000 });
    return;
  }
  quickInput.value = "";
  navigate("download");
  if (urlInput) urlInput.value = value;
  startParse(value);
});
