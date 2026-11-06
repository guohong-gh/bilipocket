// @ts-check
// 页面级 DOM 引用：只在这里查询一次。
// `type="module"` 是延迟执行的，模块加载时文档已解析完毕，不存在取不到节点的问题。

import { $ } from "../ui.js";

export const content = $("#content");
export const urlInput = $("#url-input");
export const urlField = $("#url-field");
export const parseForm = $("#parse-form");
export const parseButton = $("#parse-btn");
export const stageResult = $("#stage-result");
export const quickForm = $("#quick-parse-form");
export const quickInput = $("#quick-input");
export const drawerRoot = $("#drawer-root");
export const appShell = $(".app-shell");

export const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

// 抽屉节点在运行期创建。用可变容器持有，避免跨模块给导入绑定重新赋值。
export const drawer = { node: null };
