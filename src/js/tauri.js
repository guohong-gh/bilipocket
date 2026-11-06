// @ts-check
const tauri = typeof window !== "undefined" ? window.__TAURI__ : undefined;
const tauriWindow = tauri?.window?.getCurrentWindow?.();

export const isTauri = Boolean(tauri?.core?.invoke);

async function invoke(command, args) {
  if (!isTauri) return null;
  try {
    return await tauri.core.invoke(command, args);
  } catch (error) {
    console.warn(`[BiliPocket] Tauri command "${command}" failed:`, error);
    return null;
  }
}

export function minimizeWindow() {
  return invoke("minimize_window");
}

export function toggleMaximize() {
  return invoke("toggle_maximize");
}

export async function isWindowMaximized() {
  if (!tauriWindow?.isMaximized) return null;
  try {
    return Boolean(await tauriWindow.isMaximized());
  } catch (error) {
    console.warn("[BiliPocket] Reading maximize state failed:", error);
    return null;
  }
}

export function onWindowResized(callback) {
  if (!tauriWindow?.onResized) return () => {};
  let unlisten = null;
  let disposed = false;

  tauriWindow
    .onResized(callback)
    .then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch((error) => console.warn("[BiliPocket] Window resize hook failed:", error));

  return () => {
    disposed = true;
    unlisten?.();
  };
}

export function closeWindow() {
  return invoke("close_window");
}

export function exportDiagnostics() {
  return invoke("export_diagnostics");
}

export function updateStatus() {
  return invoke("update_status");
}

export function checkUpdate() {
  return invoke("update_check");
}

export function installUpdate() {
  return invoke("update_install");
}

export function assetUrl(path) {
  if (!path || !isTauri) return "";
  const convert = tauri?.core?.convertFileSrc;
  return typeof convert === "function" ? convert(path) : "";
}

export function pickDirectory() {
  return invoke("pick_directory");
}

export function setMinimizeToTray(enabled) {
  return invoke("set_minimize_to_tray", { enabled: Boolean(enabled) });
}

export async function openDirectory(path) {
  if (!isTauri) return null;
  try {
    return Boolean(await tauri.core.invoke("open_directory", { path }));
  } catch (error) {
    console.warn("[BiliPocket] Open directory failed:", error);
    return null;
  }
}

export async function revealFile(path) {
  if (!isTauri) return null;
  try {
    return Boolean(await tauri.core.invoke("reveal_file", { path }));
  } catch (error) {
    console.warn("[BiliPocket] Reveal file failed:", error);
    return null;
  }
}

export async function sendNotification(title, body) {
  if (!isTauri) return false;
  try {
    await tauri.core.invoke("send_notification", { title, body });
    return true;
  } catch (error) {
    console.warn("[BiliPocket] System notification failed:", error);
    return false;
  }
}
