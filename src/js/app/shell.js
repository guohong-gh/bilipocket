// @ts-check
// 窗口按钮与键盘快捷键。

import * as desktop from "../tauri.js";
import { $ } from "../ui.js";
import { currentRoute, navigate } from "./router.js";
import { quickForm, quickInput, urlInput } from "./dom.js";
import { isTauri, isWindowMaximized } from "../tauri.js";
import { icon } from "../ui.js";
import { isDesktop } from "../bridge.js";
import { store } from "../runtime.js";
import { closeWindow, minimizeWindow, toggleMaximize } from "../tauri.js";
import { confirmModal, toast } from "../ui.js";
import { drawer } from "./dom.js";



export const maxButton = $("#win-max");
export const maxIcon = $("#win-max-icon");

export function setMaximizedUI(maximized) {
  if (!maxButton) return;
  maxButton.setAttribute("aria-label", maximized ? "还原窗口" : "最大化窗口");
  maxButton.title = maximized ? "还原" : "最大化";
  maxIcon?.setAttribute("href", maximized ? "#i-restore" : "#i-maximize");
}

export async function syncWindowMaximized() {
  if (!desktop.isTauri) return;
  const maximized = await desktop.isWindowMaximized();
  if (maximized !== null) setMaximizedUI(maximized);
}

export function focusParseShortcut() {
  if (currentRoute !== "download" && quickForm && !quickForm.hidden && quickForm.offsetParent !== null) {
    quickInput?.focus();
    return;
  }

  if (currentRoute === "download") {
    urlInput?.focus();
    return;
  }

  navigate("download", { focus: "#url-input" });
}


$("#win-min")?.addEventListener("click", async () => {
  if (!desktop.isTauri) {
    toast("浏览器预览不支持窗口控制", { tone: "info", duration: 2100 });
    return;
  }
  await desktop.minimizeWindow();
});

$("#win-max")?.addEventListener("click", async () => {
  if (!desktop.isTauri) {
    toast("浏览器预览不支持窗口控制", { tone: "info", duration: 2100 });
    return;
  }

  const maximized = await desktop.toggleMaximize();
  if (typeof maximized === "boolean") setMaximizedUI(maximized);
  else syncWindowMaximized();
});

$("#win-close")?.addEventListener("click", async () => {
  if (!desktop.isTauri) {
    toast("浏览器预览请直接关闭标签页", { tone: "info", duration: 2100 });
    return;
  }

  const active = store.getState().queue.filter((task) => task.status === "downloading").length;
  if (active > 0) {
    const confirmed = await confirmModal({
      title: isDesktop ? "仍有任务正在下载" : "仍有任务正在模拟下载",
      message: isDesktop ? `当前有 ${active} 个任务正在下载。退出后进度会保存在本机，下次打开可以继续。` : `当前有 ${active} 个任务在下载。退出后进度会保存在本机，下次打开可以继续。`,
      confirmText: "退出",
      iconName: "alert",
    });
    if (!confirmed) return;
  }

  await desktop.closeWindow();
});

document.addEventListener("keydown", (event) => {
  if (drawer.node) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    focusParseShortcut();
  }
});
