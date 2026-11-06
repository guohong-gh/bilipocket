// @ts-check
// 账号：扫码登录、会话状态、档位推导。

import { $, toast } from "../ui.js";
import { store } from "../runtime.js";
import { isDesktop } from "../bridge.js";
import * as desktop from "../tauri.js";
import { AUTO_QUALITY } from "../catalog.js";
import { parseState } from "./parse-store.js";
import { renderResult } from "./result-view.js";
import { updateSidebar } from "./chrome.js";
import { resolveDesktopQuality, startDesktopParse } from "./download-parse.js";
import { currentRoute } from "./router.js";
import { availableSubtitleIds, currentSelection } from "./selection.js";
import { renderSettings } from "./settings-view.js";
import { desktopBridge } from "../bridge.js";
import { availableDanmakuTypes, isQualityAllowedForTier } from "../catalog.js";

export function stopAuthPolling() {
  window.clearInterval(authPollTimer);
  authPollTimer = null;
}

export function stopAuthCountdown() {
  window.clearInterval(authCountdownTimer);
  authCountdownTimer = null;
  const node = $("#auth-countdown");
  if (node) node.textContent = "";
}

export function startAuthCountdown(expiresAt) {
  stopAuthCountdown();
  const node = $("#auth-countdown");
  if (!node) return;
  const deadline = Number(expiresAt) || Date.now() + 180_000;
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (remaining <= 0) {
      stopAuthCountdown();
      stopAuthPolling();
      const status = $("#auth-status");
      if (status) status.textContent = "二维码已过期，请取消后重试";
      const login = $("#auth-login");
      if (login) login.disabled = false;
      return;
    }
    const minutes = Math.floor(remaining / 60);
    const seconds = String(remaining % 60).padStart(2, "0");
    node.textContent = `二维码将在 ${minutes}:${seconds} 后过期`;
  };
  tick();
  authCountdownTimer = window.setInterval(tick, 1000);
}

export function hideAuthPanel() {
  stopAuthPolling();
  stopAuthCountdown();
  const panel = $("#auth-panel");
  if (panel) panel.hidden = true;
  const button = $("#auth-login");
  if (button) button.disabled = false;
}

export function desktopAccountTier() {
  const auth = store.authInfo;
  if (!auth?.loggedIn) return "guest";
  return auth.account?.vip ? "vip" : "member";
}

export function realQualityAllowed(qualityId, tier) {
  if (qualityId === AUTO_QUALITY) return true;
  if (qualityId === "audio" || ["480P", "360P", "240P"].includes(qualityId)) return true;
  if (tier === "guest") return false;
  if (["720P", "720P60", "1080P"].includes(qualityId)) return true;
  return tier === "vip";
}

export function preferredQualityAllowed(qualityId) {
  return isDesktop
    ? realQualityAllowed(qualityId, desktopAccountTier())
    : isQualityAllowedForTier(qualityId, store.getState().settings.accountTier);
}

export function ensureDesktopPreferredQuality() {
  const preferred = store.getState().settings.preferredQuality;
  if (!preferredQualityAllowed(preferred)) {
    store.updateSettings({ preferredQuality: AUTO_QUALITY });
  }
}

export function renderAuth(auth) {
  if (!isDesktop) return;
  const loggedIn = Boolean(auth?.loggedIn);
  const account = auth?.account;
  const row = $("#auth-row");
  if (row) row.hidden = false;
  const name = $("#auth-account");
  if (name) name.textContent = loggedIn ? `${account?.name || "已登录"}${account?.vip ? " · 大会员" : ""}` : "未登录";
  const hint = $("#auth-hint");
  if (hint) {
    hint.textContent = loggedIn
      ? "登录状态只用于访问该账号本身已有权限的清晰度与字幕；不会绕过会员或付费限制"
      : "未登录；登录后可访问你账号本身已有权限的清晰度与字幕";
  }
  const login = $("#auth-login");
  if (login) login.hidden = loggedIn;
  const logout = $("#auth-logout");
  if (logout) logout.hidden = !loggedIn;
  if (loggedIn) hideAuthPanel();
  if (currentRoute === "settings") renderSettings();
}

export async function refreshAuthStatus() {
  const previous = store.authInfo;
  try {
    const auth = await store.desktopBridge.authStatus();
    store.setAuth(auth);
    renderAuth(auth);
    if (previous?.loggedIn && !auth?.loggedIn) {
      toast("登录已过期", {
        tone: "info",
        message: "请重新扫码登录；解析结果会按未登录权限重新校验。",
        duration: 5200,
      });
      ensureDesktopPreferredQuality();
      await refreshAfterAuthChange();
    } else if (
      auth &&
      (previous?.loggedIn !== auth.loggedIn ||
        previous?.account?.vip !== auth.account?.vip)
    ) {
      ensureDesktopPreferredQuality();
      await refreshAfterAuthChange();
    }
    return auth;
  } catch (error) {
    console.warn("[BiliPocket] 无法读取登录状态", error);
    return null;
  }
}

export async function refreshAfterAuthChange() {
  if (!parseState.video?.__real) return;
  const previousQuality = parseState.quality;
  const qualitySource = parseState.qualitySource;
  const previousSelection = currentSelection();
  ensureDesktopPreferredQuality();
  const value = parseState.video.sourceUrl || parseState.input;
  if (value) await startDesktopParse(value);
  if (parseState.status !== "result" || !parseState.video) return;

  const availableDanmaku = new Set(
    availableDanmakuTypes(parseState.video.danmakuTypeCounts).map((type) => type.id),
  );
  const availableSubtitles = new Set(availableSubtitleIds(parseState.video));
  parseState.selection = {
    danmakuTypes: (previousSelection.danmakuTypes || []).filter((id) => availableDanmaku.has(id)),
    subtitles: (previousSelection.subtitles || []).filter((id) => availableSubtitles.has(id)),
  };

  if (qualitySource === "manual" && previousQuality) {
    const options = parseState.video.qualityOptions || [];
    const preserved = options.find(
      (quality) => quality.formatId === previousQuality && quality.accessible !== false,
    );
    const nextQuality = preserved
      ? previousQuality
      : resolveDesktopQuality(parseState.video, previousQuality);
    parseState.quality = nextQuality;
    parseState.qualitySource = "manual";
    if (!preserved && nextQuality) {
      const label = options.find((quality) => quality.formatId === nextQuality)?.label || nextQuality;
      toast("清晰度已按当前账号调整", {
        tone: "info",
        message: `原清晰度当前不可用，已改用 ${label}。`,
      });
    }
  } else if (qualitySource === "preference") {
    parseState.qualitySource = "preference";
  }
  renderResult();
  renderSettings();
  updateSidebar();
}

export async function startAuthLogin() {
  if (!isDesktop) return;
  const login = $("#auth-login");
  if (login) login.disabled = true;
  try {
    const start = await store.desktopBridge.authQrStart();
    const panel = $("#auth-panel");
    if (panel) panel.hidden = false;
    const qr = $("#auth-qr");
    if (qr) qr.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(start.qrSvg)}`;
    const status = $("#auth-status");
    if (status) status.textContent = "请使用哔哩哔哩 App 扫码";
    startAuthCountdown(start.expiresAt);
    stopAuthPolling();
    authPollTimer = window.setInterval(async () => {
      const statusNode = $("#auth-status");
      try {
        const result = await store.desktopBridge.authQrPoll(start.qrcodeKey);
        if (result.status === "success") {
          stopAuthPolling();
          stopAuthCountdown();
          const auth = await store.desktopBridge.authStatus();
          store.setAuth(auth);
          renderAuth(auth);
          toast("已登录 Bilibili", {
            tone: "success",
            message: auth.account?.vip ? `${auth.account.name} · 大会员` : auth.account?.name || "账号已连接",
          });
          await refreshAfterAuthChange();
          return;
        }
        if (result.status === "expired" || result.status === "error") {
          stopAuthPolling();
          stopAuthCountdown();
          if (statusNode) statusNode.textContent = result.message || "二维码已过期，请取消后重试";
          if (login) login.disabled = false;
          return;
        }
        if (statusNode) statusNode.textContent = result.message || "等待扫码";
      } catch (error) {
        stopAuthPolling();
        if (statusNode) statusNode.textContent = error?.message || "登录轮询失败";
        if (login) login.disabled = false;
      }
    }, 1600);
  } catch (error) {
    if (login) login.disabled = false;
    toast("无法开始扫码登录", { tone: "error", message: error?.message || String(error) });
  }
}

export async function logoutAuth() {
  try {
    const auth = await store.desktopBridge.authLogout();
    store.setAuth(auth);
    ensureDesktopPreferredQuality();
    renderAuth(auth);
    toast("已退出 Bilibili 账号", { tone: "info" });
    await refreshAfterAuthChange();
  } catch (error) {
    toast("退出登录失败", { tone: "error", message: error?.message || String(error) });
  }
}

export let authPollTimer = null;
export let authCountdownTimer = null;
let firstRunLoginRequested = false;

export function setFirstRunLoginRequested(next) {
  firstRunLoginRequested = next;
}

/** 首登引导只消费一次：读取并复位。 */
export function consumeFirstRunLoginRequest() {
  const pending = firstRunLoginRequested;
  firstRunLoginRequested = false;
  return pending;
}
