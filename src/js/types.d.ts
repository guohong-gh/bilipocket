interface TauriInvoke {
  invoke<T = any>(command: string, args?: Record<string, unknown>): Promise<T>;
  convertFileSrc(path: string): string;
}

interface TauriEvent {
  listen<T = unknown>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<() => void>;
}

interface TauriWindowHandle {
  isMaximized(): Promise<boolean>;
  onResized(handler: () => void): Promise<() => void>;
}

interface TauriWindowApi {
  getCurrentWindow(): TauriWindowHandle;
}

interface TauriGlobal {
  core: TauriInvoke;
  event: TauriEvent;
  window?: TauriWindowApi;
}

interface Window {
  __TAURI__?: TauriGlobal;
}
