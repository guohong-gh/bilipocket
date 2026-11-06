import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stage = (message) => console.log(`[desktop-auth-qr] ${message}`);

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
  if (!existsSync(debugExe)) fail(`missing desktop auth prerequisite: ${debugExe}`);
  try {
    const response = await fetch("http://127.0.0.1:1420");
    if (response.ok) fail("port 1420 is already in use; stop the preview server first.");
  } catch (error) {
    if (String(error).includes("already in use")) throw error;
  }

  const profile = await mkdtemp(join(tmpdir(), "bilipocket-auth-e2e-"));
  const dataDir = join(profile, "data");
  await mkdir(dataDir, { recursive: true });
  const server = spawn(process.execPath, [join(root, "scripts", "serve.mjs")], {
    cwd: root,
    stdio: "ignore",
  });
  const app = spawn(debugExe, [], {
    cwd: join(root, "src-tauri"),
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9472",
      BILIPOCKET_DATA_DIR: dataDir,
    },
    stdio: "ignore",
  });
  let ws;
  try {
    await waitForHttp("http://127.0.0.1:1420", 20_000);
    let target = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const list = await (await fetch("http://127.0.0.1:9472/json/list")).json();
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
    const errors = [];
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        errors.push(message.params.args.map((arg) => arg.value || arg.description).join(" "));
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

    stage("opening settings and starting QR login");
    await evaluate("document.querySelector('[data-route=\"settings\"]')?.click()");
    await waitFor("document.querySelector('#auth-row')?.hidden === false", 10_000, "auth row");
    await evaluate("document.querySelector('#auth-login')?.click()");
    await waitFor("document.querySelector('#auth-panel')?.hidden === false", 15_000, "auth panel");
    const qr = await evaluate(`(() => ({
      src: document.querySelector('#auth-qr')?.getAttribute('src') || '',
      countdown: document.querySelector('#auth-countdown')?.textContent || '',
      status: document.querySelector('#auth-status')?.textContent || '',
    }))()`);
    if (!qr.src.startsWith("data:image/svg+xml")) fail("QR image was not rendered");
    if (!/二维码将在 \d+:\d{2} 后过期/.test(qr.countdown)) fail(`unexpected countdown: ${qr.countdown}`);
    await delay(1200);
    const countdownNext = await evaluate("document.querySelector('#auth-countdown')?.textContent || ''");
    if (!countdownNext || countdownNext === qr.countdown) fail("QR countdown did not advance");
    const shot = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(
      join(root, ".impeccable", "review", "v090", "auth-qr.png"),
      Buffer.from(shot.data, "base64"),
    );
    stage("QR rendered with countdown; cancelling");
    await evaluate("document.querySelector('#auth-cancel')?.click()");
    await waitFor("document.querySelector('#auth-panel')?.hidden === true", 10_000, "auth panel closed");
    const after = await evaluate(`(() => ({
      countdown: document.querySelector('#auth-countdown')?.textContent || '',
      loginDisabled: document.querySelector('#auth-login')?.disabled,
    }))()`);
    if (after.countdown !== "" || after.loginDisabled) fail("QR state was not reset after cancel");
    if (errors.length) fail(`console errors: ${errors.join(" | ")}`);
    stage("desktop QR login panel passed");
    console.log(JSON.stringify({ qr: { status: qr.status, countdown: qr.countdown }, cancelled: true }, null, 2));
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
    await delay(500);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    if (ws) ws.close();
  }
}

const watchdog = setTimeout(() => {
  console.error("[desktop-auth-qr] watchdog timeout");
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
