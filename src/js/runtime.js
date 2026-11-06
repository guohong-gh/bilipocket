// @ts-check
// 运行时入口：桌面走 Rust 投影，浏览器只有 /dev/ 演示入口会注入 store。
import { isDesktop } from "./bridge.js";

const demo =
  typeof globalThis !== "undefined" ? globalThis.__BILIPOCKET_DEMO__ : undefined;

export const isDemo = !isDesktop && Boolean(demo?.store);

export const demoSamples = Array.isArray(demo?.samples) ? demo.samples : [];

export const demoLookup =
  typeof demo?.lookup === "function" ? demo.lookup : () => null;

export const store = isDesktop
  ? (await import("./store-desktop.js")).desktopStore
  : demo?.store;
