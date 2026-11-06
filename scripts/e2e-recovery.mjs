import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const devServerUrl = "http://127.0.0.1:1420";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stage = (message) => console.log(`[desktop-recovery] ${message}`);

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

async function connect(port) {
  let target = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((item) => item.type === "page");
      if (target) break;
    } catch {}
    await delay(100);
  }
  if (!target) fail(`WebView2 CDP target was not found on ${port}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
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
  const waitFor = async (expression, timeoutMs = 20_000, label = expression) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await evaluate(expression);
      if (value) return value;
      await delay(150);
    }
    fail(`timed out waiting for ${label}`);
  };
  await send("Runtime.enable");
  return { ws, evaluate, waitFor, errors };
}

async function handleFirstRun(evaluate, waitFor) {
  await waitFor("document.documentElement.dataset.runtime === 'desktop'", 20_000, "desktop runtime");
  await delay(800);
  const title = await evaluate("document.querySelector('#modal-title')?.textContent || ''");
  if (title.includes("使用前确认")) {
    await evaluate("document.querySelector('[data-modal-confirm]')?.click()");
    await waitFor(
      "document.querySelector('#modal-title')?.textContent?.includes('准备开始') || false",
      10_000,
      "first-run setup",
    );
    await evaluate("document.querySelector('[data-modal-cancel]')?.click()");
  } else if (title.includes("准备开始")) {
    await evaluate("document.querySelector('[data-modal-cancel]')?.click()");
  }
  await delay(300);
  if ((await evaluate("document.querySelector('#modal-title')?.textContent || ''")).includes("现在登录")) {
    await evaluate("document.querySelector('[data-modal-cancel]')?.click()");
    await waitFor("!document.querySelector('#modal-title')", 10_000, "optional login dialog closed");
  }
}

function killTree(pid) {
  if (!pid) return;
  try {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
}

async function main() {
  const debugExe = join(root, "src-tauri", "target", "debug", "bilipocket.exe");
  const fakeEngine = join(root, "src-tauri", "target", "debug", "examples", "fake_ytdlp.exe");
  const ffmpeg = join(root, "src-tauri", "binaries", "ffmpeg-x86_64-pc-windows-msvc.exe");
  for (const path of [debugExe, fakeEngine, ffmpeg]) {
    if (!existsSync(path)) fail(`missing desktop recovery prerequisite: ${path}`);
  }
  try {
    const response = await fetch(devServerUrl);
    if (response.ok) fail("port 1420 is already in use; stop the preview server first.");
  } catch (error) {
    if (String(error).includes("already in use")) throw error;
  }

  const profile = await mkdtemp(join(tmpdir(), "bilipocket-recovery-"));
  const dataDir = join(profile, "data");
  const downloads = join(profile, "downloads");
  await mkdir(dataDir, { recursive: true });
  await mkdir(downloads, { recursive: true });

  stage("starting preview server");
  const server = spawn(process.execPath, [join(root, "scripts", "serve.mjs")], {
    cwd: root,
    stdio: "ignore",
  });
  const apps = [];
  let connection = null;

  try {
    await waitForHttp(devServerUrl, 20_000);
    stage("first launch");
    const firstApp = spawn(debugExe, [], {
      cwd: join(root, "src-tauri"),
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9461",
        BILIPOCKET_DATA_DIR: dataDir,
        BILIPOCKET_YTDLP: fakeEngine,
        BILIPOCKET_FFMPEG: ffmpeg,
        BILIPOCKET_DANMAKU_FIXTURE: join(root, "tests", "fixtures", "danmaku.xml"),
        FAKE_YTDLP_STEP_MS: "1200",
      },
      stdio: "ignore",
    });
    apps.push(firstApp);
    connection = await connect(9461);
    await connection.waitFor("!!document.querySelector('#parse-form')", 20_000, "app shell");
    await handleFirstRun(connection.evaluate, connection.waitFor);

    const settings = await connection.evaluate("window.__TAURI__.core.invoke('get_settings')");
    settings.downloadDir = downloads;
    settings.maxConcurrent = 1;
    settings.notifyOnComplete = false;
    await connection.evaluate(`window.__TAURI__.core.invoke('update_settings', { settings: ${JSON.stringify(settings)} })`);

    await connection.evaluate(`(() => {
      const input = document.querySelector('#url-input');
      input.value = 'https://www.bilibili.com/video/BV1xx411c7mD';
      document.querySelector('#parse-form').requestSubmit();
    })()`);
    await connection.waitFor(
      "document.querySelector('#stage-result .result-title')?.textContent?.includes('端到端测试视频') || false",
      30_000,
      "parse result",
    );
    await connection.evaluate("document.querySelector('#enqueue-btn')?.click()");
    await delay(300);
    await connection.evaluate("document.querySelector('[data-route=\"queue\"]')?.click()");
    await connection.waitFor(
      `(() => document.querySelector('.task')?.dataset.status === 'downloading')()`,
      15_000,
      "downloading task",
    );
    stage("killing app during download");
    connection.ws.close();
    killTree(firstApp.pid);
    await delay(1500);

    stage("second launch after crash");
    const secondApp = spawn(debugExe, [], {
      cwd: join(root, "src-tauri"),
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9462",
        BILIPOCKET_DATA_DIR: dataDir,
        BILIPOCKET_YTDLP: fakeEngine,
        BILIPOCKET_FFMPEG: ffmpeg,
        BILIPOCKET_DANMAKU_FIXTURE: join(root, "tests", "fixtures", "danmaku.xml"),
        FAKE_YTDLP_STEP_MS: "600",
      },
      stdio: "ignore",
    });
    apps.push(secondApp);
    connection = await connect(9462);
    await connection.waitFor("!!document.querySelector('#parse-form')", 20_000, "second app shell");
    await handleFirstRun(connection.evaluate, connection.waitFor);

    const tasks = await connection.evaluate("window.__TAURI__.core.invoke('list_tasks')");
    if (tasks.length !== 1) fail(`expected one recovered task, got ${tasks.length}`);
    if (tasks[0].status !== "paused") fail(`expected recovered task paused, got ${tasks[0].status}`);
    if (tasks[0].errorCode !== "interrupted") fail(`expected interrupted error, got ${tasks[0].errorCode}`);
    stage("task recovered as paused/interrupted");

    await connection.evaluate("document.querySelector('[data-route=\"queue\"]')?.click()");
    await connection.waitFor("document.querySelector('.task [data-action=\"resume\"]') !== null", 10_000, "resume action");
    await connection.evaluate("document.querySelector('.task [data-action=\"resume\"]')?.click()");
    await connection.waitFor(
      `(() => document.querySelector('.task')?.dataset.status === 'completed')()`,
      30_000,
      "recovered task completion",
    );
    const history = await connection.evaluate("window.__TAURI__.core.invoke('list_history')");
    const entry = history.find((item) => item.title === "端到端测试视频");
    if (!entry) fail("recovered task did not appear in history");
    if (!entry.outputPath || !(await stat(entry.outputPath).catch(() => null))?.size) {
      fail("recovered task output file is missing or empty");
    }
    if (connection.errors.length) fail(`console errors: ${connection.errors.join(" | ")}`);

    console.log(JSON.stringify({
      recoveredStatus: tasks[0].status,
      recoveredError: tasks[0].errorCode,
      completed: true,
      historyEntries: history.length,
      output: entry.outputPath,
    }, null, 2));
    stage("crash recovery E2E passed");
  } finally {
    try {
      if (connection) {
        connection.ws.send(JSON.stringify({
          id: 999999,
          method: "Runtime.evaluate",
          params: { expression: "window.__TAURI__ && window.__TAURI__.core.invoke('close_window')" },
        }));
        await delay(700);
      }
    } catch {}
    for (const app of apps) killTree(app.pid);
    killTree(server.pid);
    await delay(500);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    if (connection) connection.ws.close();
  }
}

const watchdog = setTimeout(() => {
  console.error("[desktop-recovery] watchdog timeout");
  process.exit(2);
}, 120_000);
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
