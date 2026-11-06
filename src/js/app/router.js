// @ts-check
// 路由：hash 解析、页面切换、导航。视图渲染函数暂时从 app.js 借（最后一批收回）。

import { $, $$ } from "../ui.js";
import { isDemo } from "../runtime.js";
import { content, quickForm } from "./dom.js";
import { renderSettings } from "./settings-view.js";
import { updateSidebar } from "./chrome.js";
import { closeExtrasDrawer } from "./selection.js";
import { renderQueue } from "./queue-view.js";
import { renderHistory } from "./history-view.js";
import { renderHomeActivity, renderRecent } from "./home-view.js";
import { updateEnqueueAction } from "./action-bar.js";
export const PAGE_META = {
  download: {
    title: "下载",
    subtitle: "把单条视频加入本地队列",
  },
  queue: {
    title: "下载队列",
    subtitle: "进行中、已完成与失败任务",
  },
  history: {
    title: "历史记录",
    subtitle: isDemo ? "最近完成的模拟任务，保存在本机" : "最近完成的下载任务，保存在本机",
  },
  settings: {
    title: "设置",
    subtitle: "下载偏好、账号与本地存储",
  },
  about: {
    title: "关于与合规",
    subtitle: "了解 BiliPocket 的使用边界",
  },
};

export let currentRoute = "download";
export let lastRenderedRoute = null;
export let focusAfterRoute = null;

export function getRoute() {
  const raw = window.location.hash.replace(/^#\/?/, "");
  return PAGE_META[raw] ? raw : "download";
}

export function navigate(route, { focus = null } = {}) {
  if (!PAGE_META[route]) route = "download";

  if (getRoute() === route) {
    if (focus) $(focus)?.focus({ preventScroll: true });
    return;
  }

  focusAfterRoute = focus;

  if (window.location.hash === `#/${route}`) {
    renderRoute();
  } else {
    window.location.hash = `#/${route}`;
  }
}

export function renderRoute() {
  closeExtrasDrawer({ restoreFocus: false });
  currentRoute = getRoute();
  const routeChanged = lastRenderedRoute !== null && lastRenderedRoute !== currentRoute;
  lastRenderedRoute = currentRoute;

  $$(".page").forEach((page) => {
    const active = page.dataset.page === currentRoute;
    page.hidden = !active;
    page.classList.toggle("is-active", active);
  });

  $$(".nav-item").forEach((item) => {
    const active = item.dataset.route === currentRoute;
    item.classList.toggle("is-active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });

  const meta = PAGE_META[currentRoute];
  $("#page-title").textContent = meta.title;
  $("#page-subtitle").textContent = meta.subtitle;
  document.body.dataset.currentRoute = currentRoute;
  quickForm.hidden = currentRoute === "download";

  if (content) content.scrollTop = 0;

  if (currentRoute === "queue") renderQueue();
  if (currentRoute === "history") renderHistory();
  if (currentRoute === "settings") renderSettings();
  if (currentRoute === "download") {
    renderRecent();
    renderHomeActivity();
    updateEnqueueAction();
  }

  updateSidebar();

  if (routeChanged) {
    if (focusAfterRoute) {
      $(focusAfterRoute)?.focus({ preventScroll: true });
    } else {
      $("#page-title")?.focus({ preventScroll: true });
    }
  }
  focusAfterRoute = null;
}


window.addEventListener("hashchange", renderRoute);

document.addEventListener("click", (event) => {
  const routeTarget = event.target instanceof Element ? event.target.closest("[data-route]") : null;
  if (!routeTarget) return;
  event.preventDefault();
  navigate(/** @type {HTMLElement} */ (routeTarget).dataset.route);
});

if (!window.location.hash) {
  window.history.replaceState(null, "", "#/download");
}
