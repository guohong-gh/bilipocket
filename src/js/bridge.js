// @ts-check
export const isDesktop = Boolean(window.__TAURI__?.core?.invoke);

export function assetUrl(path) {
  if (!path) return "";
  if (!isDesktop) return "";
  const convert = window.__TAURI__?.core?.convertFileSrc;
  return typeof convert === "function" ? convert(path) : "";
}

const invoke = (command, args = {}) => {
  if (!isDesktop) return Promise.reject(new Error("desktop bridge unavailable"));
  return window.__TAURI__.core.invoke(command, args);
};

const listen = async (eventName, handler) => {
  if (!isDesktop) return () => {};
  const unlisten = await window.__TAURI__.event.listen(eventName, (event) => handler(event.payload));
  return typeof unlisten === "function" ? unlisten : () => {};
};

export const desktopBridge = {
  bootstrap: () => invoke("bootstrap"),
  engineInfo: () => invoke("engine_info"),
  refreshEngine: () => invoke("engine_refresh"),
  probeVideo: (url) => invoke("probe_video", { url }),
  enqueueTask: (spec) => invoke("enqueue_task", { spec }),
  listTasks: () => invoke("list_tasks"),
  listHistory: () => invoke("list_history"),
  pauseTask: (id) => invoke("pause_task", { id }),
  resumeTask: (id) => invoke("resume_task", { id }),
  prioritizeTask: (id) => invoke("prioritize_task", { id }),
  cancelTask: (id, deletePartial = false) => invoke("cancel_task", { id, deletePartial }),
  retryTask: (id) => invoke("retry_task", { id }),
  deleteTask: (id, deleteFile = false) => invoke("delete_task", { id, deleteFile }),
  clearCompleted: () => invoke("clear_completed"),
  clearTasks: () => invoke("clear_tasks"),
  deleteHistory: (id, deleteFile = false) => invoke("delete_history", { id, deleteFile }),
  clearHistory: () => invoke("clear_history"),
  getSettings: () => invoke("get_settings"),
  updateSettings: (settings) => invoke("update_settings", { settings }),
  setAutostart: (enabled) => invoke("set_autostart", { enabled }),
  authStatus: () => invoke("auth_status"),
  authQrStart: () => invoke("auth_qr_start"),
  authQrPoll: (qrcodeKey) => invoke("auth_qr_poll", { qrcodeKey }),
  authLogout: () => invoke("auth_logout"),
  exportDiagnostics: () => invoke("export_diagnostics"),
  updateStatus: () => invoke("update_status"),
  checkUpdate: () => invoke("update_check"),
  installUpdate: () => invoke("update_install"),
  listen,
};
