import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stage = (message) => console.log(`[desktop-priority] ${message}`);

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
  const fakeEngine = join(root, "src-tauri", "target", "debug", "examples", "fake_ytdlp.exe");
  const ffmpeg = join(root, "src-tauri", "binaries", "ffmpeg-x86_64-pc-windows-msvc.exe");
  for (const path of [debugExe, fakeEngine, ffmpeg]) {
    if (!existsSync(path)) fail(`missing desktop priority prerequisite: ${path}`);
  }
  try {
    const response = await fetch("http://127.0.0.1:1420");
    if (response.ok) fail("port 1420 is already in use; stop the preview server first.");
  } catch (error) {
    if (String(error).includes("already in use")) throw error;
  }

  const profile = await mkdtemp(join(tmpdir(), "bilipocket-priority-"));
  const dataDir = join(profile, "data");
  const downloads = join(profile, "downloads");
  await mkdir(dataDir, { recursive: true });
  await mkdir(downloads, { recursive: true });
  const server = spawn(process.execPath, [join(root, "scripts", "serve.mjs")], {
    cwd: root,
    stdio: "ignore",
  });
  const app = spawn(debugExe, [], {
    cwd: join(root, "src-tauri"),
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9473",
      BILIPOCKET_DATA_DIR: dataDir,
      BILIPOCKET_YTDLP: fakeEngine,
      BILIPOCKET_FFMPEG: ffmpeg,
      BILIPOCKET_DANMAKU_FIXTURE: join(root, "tests", "fixtures", "danmaku.xml"),
      FAKE_YTDLP_STEP_MS: "2000",
    },
    stdio: "ignore",
  });
  let ws;
  try {
    await waitForHttp("http://127.0.0.1:1420", 20_000);
    let target = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const list = await (await fetch("http://127.0.0.1:9473/json/list")).json();
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
    const settings = await evaluate("window.__TAURI__.core.invoke('get_settings')");
    settings.downloadDir = downloads;
    settings.maxConcurrent = 1;
    settings.notifyOnComplete = false;
    await evaluate(`window.__TAURI__.core.invoke('update_settings', { settings: ${JSON.stringify(settings)} })`);

    stage("enqueueing three tasks with concurrency 1");
    for (const [formatId, label, title] of [
      ["30080", "1080P", "Priority A"],
      ["30016", "360P", "Priority B"],
      ["30216", "仅音频", "Priority C"],
    ]) {
      const spec = {
        sourceUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
        bvid: "BV1xx411c7mD",
        formatId,
        qualityLabel: label,
        container: "mp4",
        title,
        uploader: "测试 UP",
        coverUrl: null,
        coverPath: null,
        durationSeconds: 42,
        sizeBytes: 5000,
        danmakuTypes: [],
        danmakuCount: 0,
        subtitleLangs: [],
      };
      await evaluate(`window.__TAURI__.core.invoke('enqueue_task', { spec: ${JSON.stringify(spec)} })`);
    }
    await evaluate("document.querySelector('[data-route=\"queue\"]')?.click()");
    await waitFor("document.querySelectorAll('.task').length === 3", 10_000, "three queue rows");
    await waitFor(
      `(() => {
        const rows = [...document.querySelectorAll('.task')];
        return rows.filter((row) => row.dataset.status === 'downloading').length === 1
          && rows.filter((row) => row.dataset.status === 'queued').length === 2;
      })()`,
      10_000,
      "one downloading and two queued",
    );

    stage("prioritizing task C");
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.task')].find((item) => item.innerText.includes('Priority C'));
      row?.querySelector('[data-action="prioritize"]')?.click();
    })()`);
    await delay(1000);
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.task')].find((item) => item.dataset.status === 'downloading');
      row?.querySelector('[data-action="pause"]')?.click();
    })()`);
    await delay(800);

    await waitFor(
      `window.__TAURI__.core.invoke('list_tasks').then((rows) => {
        const status = (formatId) => rows.find((task) => task.formatId === formatId)?.status;
        return status('30080') === 'paused'
          && status('30216') === 'downloading'
          && status('30016') === 'queued';
      })`,
      15_000,
      "priority task C started before B",
    );
    stage("queue priority passed");
    console.log(JSON.stringify({ statuses: { A: "paused", B: "queued", C: "downloading" } }, null, 2));
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
  console.error("[desktop-priority] watchdog timeout");
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
