// 演示入口文案：按 id 覆盖，生产页面不再做字符串匹配替换。
const COPY = {
  "brand-tag": "演示",
  "local-card-copy": "不登录 · 不上传 · 不真实下载",
  "app-version": "v0.9.0 · 浏览器演示",
  "status-pill-label": "离线演示",
  "mode-badge-label": "模拟演示 · 不写入文件",
  "privacy-hint-label": "数据不出本机",
  "data-storage-hint": "队列、历史和设置存储在浏览器 localStorage 中。重置只恢复演示任务，不会影响你的真实文件。",
};

const TITLES = {
  ".status-pill": "所有解析、下载进度与通知均为本地模拟",
};

export function applyDemoCopy() {
  for (const [id, text] of Object.entries(COPY)) {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  }
  for (const [selector, text] of Object.entries(TITLES)) {
    const node = document.querySelector(selector);
    if (node) node.title = text;
  }
}
