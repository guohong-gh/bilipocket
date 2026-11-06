import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = process.cwd();
const devServerUrl = "http://127.0.0.1:1420";
const cdpPort = 9463;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stage = (message) => console.log(`[desktop-extras-e2e] ${message}`);

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
  const danmakuFixture = join(root, "tests", "fixtures", "danmaku.xml");
  for (const path of [debugExe, fakeEngine, ffmpeg, danmakuFixture]) {
    if (!existsSync(path)) {
      fail(`missing desktop extras E2E prerequisite: ${path}. Run cargo build and cargo build --example fake_ytdlp.`);
    }
  }

  try {
    const response = await fetch(devServerUrl);
    if (response.ok) fail("port 1420 is already in use; stop the preview server before running desktop E2E.");
  } catch (error) {
    if (String(error).includes("already in use")) throw error;
  }

  const profile = await mkdtemp(join(tmpdir(), "bilipocket-extras-e2e-"));
  const dataDir = join(profile, "data");
  const downloads = join(profile, "downloads");
  await mkdir(dataDir, { recursive: true });
  await mkdir(downloads, { recursive: true });

  stage("starting preview server");
  const server = spawn(process.execPath, [join(root, "scripts", "serve.mjs")], {
    cwd: root,
    stdio: "ignore",
  });
  stage("starting debug app");
  const app = spawn(debugExe, [], {
    cwd: join(root, "src-tauri"),
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
      BILIPOCKET_DATA_DIR: dataDir,
      BILIPOCKET_YTDLP: fakeEngine,
      BILIPOCKET_FFMPEG: ffmpeg,
      BILIPOCKET_DANMAKU_FIXTURE: danmakuFixture,
      FAKE_YTDLP_STEP_MS: "120",
    },
    stdio: "ignore",
  });

  let ws;
  try {
    await waitForHttp(devServerUrl, 20_000);
    stage("preview server ready");
    let target = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
        target = list.find((item) => item.type === "page");
        if (target) break;
      } catch {}
      await delay(100);
    }
    if (!target) fail("WebView2 CDP target was not found");
    stage("WebView2 target found");

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    let id = 0;
    const pending = new Map();
    const consoleErrors = [];
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
        consoleErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        consoleErrors.push(message.params.args.map((arg) => arg.value || arg.description).join(" "));
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
      if (result.exceptionDetails) {
        fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      }
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
    await waitFor("!!document.querySelector('#parse-form')", 20_000, "app shell");
    await waitFor("document.documentElement.dataset.runtime === 'desktop'", 20_000, "desktop runtime");
    stage("app shell ready");

    await delay(800);
    const firstTitle = await evaluate("document.querySelector('#modal-title')?.textContent || ''");
    if (firstTitle.includes("使用前确认")) {
      await evaluate("document.querySelector('[data-modal-confirm]')?.click()");
      await waitFor(
        "document.querySelector('#modal-title')?.textContent?.includes('准备开始') || false",
        10_000,
        "first-run setup",
      );
      await evaluate("document.querySelector('[data-modal-cancel]')?.click()");
    } else if (firstTitle.includes("准备开始")) {
      await evaluate("document.querySelector('[data-modal-cancel]')?.click()");
    }
    await delay(300);
    if ((await evaluate("document.querySelector('#modal-title')?.textContent || ''")).includes("现在登录")) {
      await evaluate("document.querySelector('[data-modal-cancel]')?.click()");
      await waitFor("!document.querySelector('#modal-title')", 10_000, "optional login dialog closed");
    }
    stage("first-run flow complete");

    const settings = await evaluate("window.__TAURI__.core.invoke('get_settings')");
    settings.downloadDir = downloads;
    settings.maxConcurrent = 2;
    settings.notifyOnComplete = false;
    await evaluate(`window.__TAURI__.core.invoke('update_settings', { settings: ${JSON.stringify(settings)} })`);

    const parseVideo = async () => {
      await evaluate("document.querySelector('[data-route=\"download\"]')?.click()");
      await evaluate(`(() => {
        const input = document.querySelector('#url-input');
        input.value = 'https://www.bilibili.com/video/BV1xx411c7mD';
        document.querySelector('#parse-form').requestSubmit();
      })()`);
      await waitFor(
        `(() => {
          const stage = document.querySelector('#stage-result');
          const title = stage?.querySelector('.result-title')?.textContent || '';
          return !!stage && !stage.hidden && title.includes('端到端测试视频');
        })()`,
        30_000,
        "desktop parse result",
      );
    };

    stage("parsing fake video for extras-only download");
    await parseVideo();
    await waitFor(
      "(() => { const stage = document.querySelector('#stage-result'); return !!stage && !stage.hidden && !!document.querySelector('#enqueue-extras-btn') && !document.querySelector('#enqueue-extras-btn').disabled; })()",
      10_000,
      "extras-only action enabled",
    );
    await evaluate("document.querySelector('#enqueue-extras-btn')?.click()");
    await waitFor(
      "window.__TAURI__.core.invoke('list_tasks').then((rows) => rows.some((task) => task.kind === 'extras' && task.status === 'completed'))",
      30_000,
      "extras-only completion",
    );

    const extrasTask = (await evaluate("window.__TAURI__.core.invoke('list_tasks')")).find(
      (task) => task.kind === "extras",
    );
    if (!extrasTask) fail("extras-only task is missing from the database");
    const folder = join(downloads, "端到端测试视频");
    if (extrasTask.outputPath !== folder) {
      fail(`extras-only output path is not the per-video folder: ${extrasTask.outputPath}`);
    }
    const subtitlePath = join(folder, "端到端测试视频 [1080P].zh-Hans.srt");
    const danmakuPath = join(folder, "端到端测试视频 [1080P].danmaku.xml");
    if (!existsSync(subtitlePath)) fail("extras-only subtitle file is missing");
    if (!existsSync(danmakuPath)) fail("extras-only danmaku file is missing");
    if (existsSync(join(folder, "端到端测试视频 [1080P].mp4"))) {
      fail("extras-only download unexpectedly wrote a video file");
    }

    const extrasHistory = (await evaluate("window.__TAURI__.core.invoke('list_history')")).find(
      (entry) => entry.kind === "extras",
    );
    if (!extrasHistory) fail("extras-only history entry is missing");
    if (extrasHistory.outputPath !== folder) fail("extras history output path is not the folder");
    await evaluate("document.querySelector('[data-route=\"history\"]')?.click()");
    await waitFor(
      "[...document.querySelectorAll('.history-row')].some((row) => row.innerText.includes('附加内容') && row.innerText.includes('重下附加内容'))",
      10_000,
      "extras history row",
    );

    stage("enqueueing the video into the same folder");
    await parseVideo();
    await waitFor(
      "(() => { const stage = document.querySelector('#stage-result'); return !!stage && !stage.hidden && !!document.querySelector('#enqueue-btn') && !document.querySelector('#enqueue-btn').disabled; })()",
      10_000,
      "video action enabled",
    );
    await evaluate("document.querySelector('#enqueue-btn')?.click()");
    await waitFor(
      "window.__TAURI__.core.invoke('list_tasks').then((rows) => rows.some((task) => task.kind !== 'extras' && task.status === 'completed'))",
      30_000,
      "video completion",
    );

    const videoTask = (await evaluate("window.__TAURI__.core.invoke('list_tasks')")).find(
      (task) => task.kind !== "extras" && task.status === "completed",
    );
    if (!videoTask?.outputPath || dirname(videoTask.outputPath) !== folder) {
      fail(`video output is not in the extras folder: ${videoTask?.outputPath}`);
    }
    if (!(await stat(videoTask.outputPath).catch(() => null))?.size) {
      fail("video output file is missing or empty");
    }
    if (!existsSync(subtitlePath) || !existsSync(danmakuPath)) {
      fail("video download did not keep the extras sidecars in the same folder");
    }

    stage("removing the extras history entry without touching the video");
    await evaluate("document.querySelector('[data-route=\"history\"]')?.click()");
    await waitFor(
      "[...document.querySelectorAll('.history-row')].some((row) => row.innerText.includes('附加内容'))",
      10_000,
      "extras history row for deletion",
    );
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.history-row')].find((item) => item.innerText.includes('附加内容'));
      row?.querySelector('[data-action="remove-history"]')?.click();
    })()`);
    await waitFor(
      "document.querySelector('#modal-title')?.textContent?.includes('移除这条历史记录') || false",
      10_000,
      "extras history delete dialog",
    );
    await evaluate("(() => { const box = document.querySelector('#modal-check'); if (box) box.checked = true; })()");
    await evaluate("document.querySelector('[data-modal-confirm]')?.click()");
    await waitFor(
      "window.__TAURI__.core.invoke('list_history').then((rows) => rows.length === 1)",
      10_000,
      "extras history deletion",
    );
    if (!existsSync(videoTask.outputPath)) fail("deleting the extras entry removed the video file");
    if (existsSync(subtitlePath) || existsSync(danmakuPath)) {
      fail("deleting the extras entry did not remove the sidecars");
    }

    if (consoleErrors.length) fail(`console errors: ${consoleErrors.join(" | ")}`);
    stage("extras-only and shared-folder flow passed");
    console.log(
      JSON.stringify(
        {
          folder,
          extrasTask: extrasTask.id,
          videoTask: videoTask.id,
          historyEntries: (await evaluate("window.__TAURI__.core.invoke('list_history')")).length,
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      if (ws) {
        ws.send(JSON.stringify({
          id: 999999,
          method: "Runtime.evaluate",
          params: { expression: "window.__TAURI__ && window.__TAURI__.core.invoke('close_window')" },
        }));
        await delay(800);
      }
    } catch {}
    try {
      app.kill();
    } catch {}
    try {
      server.kill();
    } catch {}
    await delay(500);
    for (const pid of [app.pid, server.pid]) {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    await delay(300);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
