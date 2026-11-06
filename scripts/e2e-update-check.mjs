import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stage = (message) => console.log(`[desktop-update] ${message}`);

function fail(message) {
  throw new Error(message);
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  fail(`dev server did not become ready: ${url}`);
}

async function main() {
  const debugExe = join(root, "src-tauri", "target", "debug", "bilipocket.exe");
  if (!existsSync(debugExe)) fail(`missing desktop update prerequisite: ${debugExe}`);
  try {
    const response = await fetch("http://127.0.0.1:1420");
    if (response.ok) fail("port 1420 is already in use; stop the preview server first.");
  } catch (error) {
    if (String(error).includes("already in use")) throw error;
  }

  const profile = await mkdtemp(join(tmpdir(), "bilipocket-update-e2e-"));
  const dataDir = join(profile, "data");
  await mkdir(dataDir, { recursive: true });
  const manifest = JSON.stringify({
    version: "9.9.9",
    notes: "update e2e",
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": {
        signature: "dummy-signature",
        url: "https://example.com/BiliPocket_9.9.9_x64-setup.exe",
      },
    },
  });
  const updateServer = http.createServer((request, response) => {
    if (request.url?.startsWith("/latest.json")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(manifest);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => updateServer.listen(9470, "127.0.0.1", resolve));

  const server = spawn(process.execPath, [join(root, "scripts", "serve.mjs")], {
    cwd: root,
    stdio: "ignore",
  });
  const app = spawn(debugExe, [], {
    cwd: join(root, "src-tauri"),
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9471",
      BILIPOCKET_DATA_DIR: dataDir,
      BILIPOCKET_UPDATE_ENDPOINT: "http://127.0.0.1:9470/latest.json",
    },
    stdio: "ignore",
  });
  let ws;
  try {
    await waitForHttp("http://127.0.0.1:1420", 20_000);
    stage("preview server ready");
    let target = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const list = await (await fetch("http://127.0.0.1:9471/json/list")).json();
        target = list.find((item) => item.type === "page");
        if (target) break;
      } catch {}
      await delay(100);
    }
    if (!target) fail("WebView2 CDP target was not found");
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
      }
    };
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const callId = ++id;
        pending.set(callId, { resolve, reject });
        ws.send(JSON.stringify({ id: callId, method, params }));
      });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails) fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const waitFor = async (expression, timeoutMs = 15_000, label = expression) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await evaluate(expression);
        if (value) return value;
        await delay(150);
      }
      fail(`timed out waiting for ${label}`);
    };
    await send("Runtime.enable");
    await waitFor("!!document.querySelector('#parse-form')", 20_000, "app shell");
    await waitFor("document.documentElement.dataset.runtime === 'desktop'", 20_000, "desktop runtime");
    await delay(800);
    if ((await evaluate("document.querySelector('#modal-title')?.textContent || ''")).includes("使用前确认")) {
      await evaluate("document.querySelector('[data-modal-confirm]')?.click()");
      await waitFor(
        "document.querySelector('#modal-title')?.textContent?.includes('准备开始') || false",
        10_000,
        "first-run setup",
      );
      await evaluate("document.querySelector('[data-modal-cancel]')?.click()");
    }
    await delay(300);
    if ((await evaluate("document.querySelector('#modal-title')?.textContent || ''")).includes("现在登录")) {
      await evaluate("document.querySelector('[data-modal-cancel]')?.click()");
      await waitFor("!document.querySelector('#modal-title')", 10_000, "optional login closed");
    }
    stage("app ready; opening settings");
    await evaluate("document.querySelector('[data-route=\"settings\"]')?.click()");
    await waitFor(
      "document.querySelector('#update-state')?.textContent === '已配置'",
      10_000,
      "configured update state",
    );
    const status = await evaluate("window.__TAURI__.core.invoke('update_status')");
    if (!status.configured) fail("update endpoint was not detected");
    const check = await evaluate("window.__TAURI__.core.invoke('update_check')");
    if (!check.available || check.version !== "9.9.9") fail(`unexpected update check: ${JSON.stringify(check)}`);
    stage("opening update dialog");
    await evaluate("document.querySelector('#check-updates')?.click()");
    await waitFor(
      "document.querySelector('#modal-title')?.textContent?.includes('发现新版本 v9.9.9') || false",
      15_000,
      "update available dialog",
    );
    await evaluate("document.querySelector('[data-modal-cancel]')?.click()");
    await waitFor("!document.querySelector('#modal-title')", 10_000, "update dialog closed");
    stage("desktop update check passed");
    console.log(JSON.stringify({ status, check }, null, 2));
  } finally {
    try {
      if (ws) {
        ws.send(JSON.stringify({
          id: 999999,
          method: "Runtime.evaluate",
          params: { expression: "window.__TAURI__ && window.__TAURI__.core.invoke('close_window')" },
        }));
        await delay(700);
      }
    } catch {}
    for (const child of [app, server]) {
      if (child.pid) {
        try {
          spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } catch {}
      }
    }
    updateServer.close();
    await delay(500);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    if (ws) ws.close();
  }
}

const watchdog = setTimeout(() => {
  console.error("[desktop-update] watchdog timeout");
  process.exit(2);
}, 90_000);
watchdog.unref();

main()
  .catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(watchdog);
    setTimeout(() => process.exit(process.exitCode || 0), 1000).unref();
  });
