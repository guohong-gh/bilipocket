// @ts-check
// 主题：偏好解析、样式与图标同步、三态切换。

import { $, $$ } from "../ui.js";
import { store } from "../runtime.js";
import { mediaQuery } from "./dom.js";
import { content } from "./dom.js";
import { icon } from "../ui.js";
import { toast } from "../ui.js";

export function resolvedTheme(preference) {
  if (preference === "system") return mediaQuery.matches ? "dark" : "light";
  return preference === "light" ? "light" : "dark";
}

export function syncThemeUI(preference) {
  const normalized = THEME_ORDER.includes(preference) ? preference : "light";
  const resolved = resolvedTheme(normalized);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = normalized;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "dark" ? "#0b0c0e" : "#fafafa");

  const next = THEME_ORDER[(THEME_ORDER.indexOf(normalized) + 1) % THEME_ORDER.length];
  const button = $("#theme-toggle");
  $("#theme-toggle-icon use")?.setAttribute("href", THEME_ICONS[normalized]);
  if (button) {
    button.title = `主题：${THEME_LABELS[normalized]}（点击切换为${THEME_LABELS[next]}）`;
    button.setAttribute(
      "aria-label",
      `主题：${THEME_LABELS[normalized]}。点击切换为${THEME_LABELS[next]}。`,
    );
  }
}

export function applyTheme(preference, { persist = false } = {}) {
  document.documentElement.classList.add("theme-animating");
  syncThemeUI(preference);
  window.setTimeout(() => document.documentElement.classList.remove("theme-animating"), 320);

  if (persist) {
    store.updateSettings({ theme: preference });
  }
}

export const THEME_ORDER = ["light", "dark", "system"];
export const THEME_LABELS = { light: "浅色", dark: "深色", system: "跟随系统" };
export const THEME_ICONS = { light: "#i-sun", dark: "#i-moon", system: "#i-monitor" };


$("#theme-toggle")?.addEventListener("click", () => {
  const current = store.getState().settings.theme;
  const index = THEME_ORDER.includes(current) ? THEME_ORDER.indexOf(current) : 0;
  const next = THEME_ORDER[(index + 1) % THEME_ORDER.length];
  applyTheme(next, { persist: true });
  toast(`主题：${THEME_LABELS[next]}`, {
    tone: "info",
    message: next === "system" ? "将跟随 Windows 的外观设置。" : "主题偏好已保存。",
    duration: 1800,
  });
});

mediaQuery.addEventListener("change", () => {
  if (store.getState().settings.theme === "system") {
    syncThemeUI("system");
  }
});
