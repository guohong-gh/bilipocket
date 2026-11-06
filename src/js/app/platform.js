// @ts-check
// 桌面平台能力：打开/选择目录、窗口按钮、通知。

import * as desktop from "../tauri.js";
import { $, toast } from "../ui.js";
import { store } from "../runtime.js";
import { isDesktop } from "../bridge.js";
import { isTauri, openDirectory } from "../tauri.js";

export async function openConfiguredDirectory() {
  const path = store.getState().settings.downloadDir;

  if (!desktop.isTauri) {
    toast("浏览器预览无法打开本地文件夹", {
      tone: "info",
      message: `当前目录：${path}`,
    });
    return;
  }

  const opened = await desktop.openDirectory(path);
  if (opened === false) {
    toast("目录还不存在", {
      tone: "info",
      message: isDesktop ? "下载时会尝试创建目录；也可以在设置中选择一个已存在的文件夹。" : "原型不会自动创建目录；可以在设置中选择一个已存在的文件夹。",
    });
    return;
  }

  if (opened === null) {
    toast("打开目录失败", {
      tone: "error",
      message: "请检查目录路径或系统文件管理器权限。",
    });
  }
}
