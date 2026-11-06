import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const root = process.cwd();
const autoRetry = process.argv.includes("--auto-retry");
const devServerUrl = "http://127.0.0.1:1420";
const cdpPort = 9460;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const stage = (message) => console.log(`[desktop-e2e] ${message}`);

async function main() {
  const debugExe = join(root, "src-tauri", "target", "debug", "bilipocket.exe");
  const fakeEngine = join(root, "src-tauri", "target", "debug", "examples", "fake_ytdlp.exe");
  const ffmpeg = join(root, "src-tauri", "binaries", "ffmpeg-x86_64-pc-windows-msvc.exe");
  const danmakuFixture = join(root, "tests", "fixtures", "danmaku.xml");
  for (const path of [debugExe, fakeEngine, ffmpeg, danmakuFixture]) {
    if (!existsSync(path)) {
      fail(`missing desktop E2E prerequisite: ${path}. Run cargo build and cargo build --example fake_ytdlp.`);
    }
  }

  try {
    const response = await fetch(devServerUrl);
    if (response.ok) fail("port 1420 is already in use; stop the preview server before running desktop E2E.");
  } catch (error) {
    if (String(error).includes("already in use")) throw error;
  }

  const profile = await mkdtemp(join(tmpdir(), "bilipocket-e2e-"));
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
      FAKE_YTDLP_STEP_MS: autoRetry ? "300" : "500",
      FAKE_YTDLP_FAIL_ONCE: autoRetry ? "1" : "0",
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
      stage("accepting first-run authorization");
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

    stage("checking desktop settings surface");
    await evaluate("document.querySelector('[data-route=\"settings\"]')?.click()");
    await waitFor("document.querySelector('.settings-page') !== null", 10_000, "settings page");
    const settingsInfo = await evaluate(`(() => ({
      cards: document.querySelectorAll('.settings-page .settings-card').length,
      dataDir: document.querySelector('#data-dir-value')?.textContent || '',
      autostartDisabled: document.querySelector('#toggle-autostart')?.disabled ?? true,
      accountTierAbsent: document.querySelector('#account-tier') === null,
      authRowVisible: document.querySelector('#auth-row')?.hidden === false,
      qualityTiers: document.querySelectorAll('#quality-availability .quality-tier').length,
      defaultDanmaku: document.querySelector('#toggle-default-danmaku')?.getAttribute('aria-checked'),
    }))()`);
    if (settingsInfo.cards !== 4) fail(`expected 4 settings cards, got ${settingsInfo.cards}`);
    if (!settingsInfo.dataDir) fail("desktop data directory is empty");
    if (settingsInfo.autostartDisabled) fail("autostart switch is disabled on desktop");
    if (!settingsInfo.accountTierAbsent) fail("demo account row is present on desktop");
    if (!settingsInfo.authRowVisible) fail("Bilibili account row is hidden on desktop");
    if (settingsInfo.qualityTiers !== 9) fail(`expected 9 quality tiers, got ${settingsInfo.qualityTiers}`);
    if (settingsInfo.defaultDanmaku !== "true") fail("default danmaku preference is not enabled");
    await evaluate("document.querySelector('[data-route=\"download\"]')?.click()");
    stage("configuring temporary download directory");
    const settings = await evaluate("window.__TAURI__.core.invoke('get_settings')");
    settings.downloadDir = downloads;
    settings.maxConcurrent = 2;
    settings.notifyOnComplete = false;
    await evaluate(`window.__TAURI__.core.invoke('update_settings', { settings: ${JSON.stringify(settings)} })`);

    stage("parsing fake video");
    await evaluate(`(() => {
      const input = document.querySelector('#url-input');
      input.value = 'https://www.bilibili.com/video/BV1xx411c7mD';
      document.querySelector('#parse-form').requestSubmit();
    })()`);
    await waitFor(
      "document.querySelector('#stage-result .result-title')?.textContent?.includes('端到端测试视频') || false",
      30_000,
      "desktop parse result",
    );
    stage("enqueueing task");
    await evaluate("document.querySelector('#enqueue-btn')?.click()");
    await delay(300);
    await evaluate("document.querySelector('[data-route=\"queue\"]')?.click()");
    await waitFor("document.querySelector('.task') !== null", 15_000, "queue task");
    const initialTasks = await evaluate("window.__TAURI__.core.invoke('list_tasks')");
    if (initialTasks.length !== 1) fail(`enqueue created ${initialTasks.length} tasks`);
    const initialRows = await evaluate("document.querySelectorAll('#queue-content .task').length");
    if (initialRows !== 1) fail(`enqueue rendered ${initialRows} rows`);
    const taskState = () =>
      evaluate(`(() => {
        const row = document.querySelector('.task');
        return row ? {
          status: row.dataset.status,
          badge: row.querySelector('.status-badge')?.innerText || '',
          metrics: row.querySelector('.task-metrics')?.innerText || '',
          actions: [...row.querySelectorAll('[data-action]')].map((node) => node.dataset.action),
        } : null;
      })()`);

    if (autoRetry) {
      stage("waiting for automatic retry scheduling");
      await waitFor(
        `(() => {
          const row = document.querySelector('.task');
          return row?.dataset.status === 'queued' && row.innerText.includes('自动重试');
        })()`,
        20_000,
        "automatic retry queued state",
      );
      stage("waiting for automatic retry completion");
      await waitFor(
        `(() => document.querySelector('.task')?.dataset.status === 'completed')()`,
        45_000,
        "automatic retry completion",
      );
    } else {
      stage("task visible; testing pause/cancel/retry");
      await waitFor(
        `(() => document.querySelector('.task')?.dataset.status === 'downloading')()`,
        15_000,
        "downloading state",
      );
      await evaluate("document.querySelector('.task [data-action=\"pause\"]')?.click()");
      await waitFor(
        `(() => document.querySelector('.task')?.dataset.status === 'paused')()`,
        10_000,
        "paused state",
      );
      const taskId = await evaluate("document.querySelector('.task')?.dataset.id || ''");
      if (!taskId) fail("task id is missing");
      await evaluate("document.querySelector('.task [data-action=\"cancel\"]')?.click()");
      await waitFor("document.querySelector('#modal-title')?.textContent?.includes('取消这个下载任务') || false");
      await evaluate("(() => { const box = document.querySelector('#modal-check'); if (box) box.checked = true; })()");
      await evaluate("document.querySelector('[data-modal-confirm]')?.click()");
      await waitFor(
        `(() => document.querySelector('.task')?.dataset.status === 'cancelled')()`,
        10_000,
        "cancelled state",
      );
      const cancelledTask = (await evaluate("window.__TAURI__.core.invoke('list_tasks')")).find(
        (task) => task.id === taskId,
      );
      if (!cancelledTask) fail("cancelled task disappeared from the database");
      if (cancelledTask.tempDir) fail("cancelled task still stores a temp directory");
      if (existsSync(join(dataDir, "parts", taskId))) fail("cancel did not delete partial files");
      await evaluate("document.querySelector('.task [data-action=\"retry\"]')?.click()");
      await waitFor(
        `(() => document.querySelector('.task')?.dataset.status === 'completed')()`,
        30_000,
        "completed state",
      );
    }
    const history = await evaluate("window.__TAURI__.core.invoke('list_history')");
    const entry = history.find((item) => item.title === "端到端测试视频");
    if (!entry) fail("completed task did not appear in history");
    if (!entry.outputPath || !(await stat(entry.outputPath).catch(() => null))?.size) {
      fail("completed output file is missing or empty");
    }
    const videoFolder = join(downloads, "端到端测试视频");
    if (dirname(entry.outputPath) !== videoFolder) {
      fail(`output file was not placed in the per-video folder: ${entry.outputPath}`);
    }
    if (!existsSync(join(videoFolder, "端到端测试视频 [1080P].zh-Hans.srt"))) {
      fail("selected subtitle sidecar was not written into the per-video folder");
    }
    const danmakuPath = join(videoFolder, "端到端测试视频 [1080P].danmaku.xml");
    if (!existsSync(danmakuPath)) fail("danmaku sidecar was not written into the per-video folder");

    if (!autoRetry) {
      stage("removing completed queue task with file deletion");
      await evaluate("document.querySelector('[data-route=\"queue\"]')?.click()");
      await waitFor(
        "document.querySelector('.task[data-status=\"completed\"] [data-action=\"delete\"]') !== null",
        10_000,
        "completed queue task",
      );
      await evaluate("document.querySelector('.task[data-status=\"completed\"] [data-action=\"delete\"]')?.click()");
      await waitFor("document.querySelector('#modal-title')?.textContent?.includes('从队列移除') || false");
      const queueDeleteCheckedByDefault = await evaluate("document.querySelector('#modal-check')?.checked");
      if (queueDeleteCheckedByDefault !== false) fail("queue file deletion checkbox should default to off");
      await evaluate("(() => { const box = document.querySelector('#modal-check'); if (box) box.checked = true; })()");
      await evaluate("document.querySelector('[data-modal-confirm]')?.click()");
      await waitFor(
        "window.__TAURI__.core.invoke('list_tasks').then((rows) => rows.length === 0)",
        10_000,
        "queue remove with file deletion",
      );
      if (existsSync(entry.outputPath)) fail("queue remove did not delete the downloaded file");
    }

    const engine = await evaluate("window.__TAURI__.core.invoke('engine_info')");
    if (!engine.available) fail("download engine is unavailable");
    if (consoleErrors.length) fail(`console errors: ${consoleErrors.join(" | ")}`);

    if (!autoRetry) {
      stage("checking missing-file detection and history re-add");
      await rm(entry.outputPath, { force: true });
      const refreshed = await evaluate("window.__TAURI__.core.invoke('list_history')");
      const gone = refreshed.find((item) => item.title === "端到端测试视频");
      if (!gone?.missingFile) fail("deleted history output was not marked missing");

      await evaluate("document.querySelector('[data-route=\"history\"]')?.click()");
      await waitFor("document.querySelector('.history-row') !== null", 10_000, "history row");
      await evaluate("document.querySelector('.history-row [data-action=\"re-add\"]')?.click()");
      await waitFor(
        "window.__TAURI__.core.invoke('list_tasks').then((rows) => rows.length === 1)",
        10_000,
        "history re-add task",
      );
      const readdedTasks = await evaluate("window.__TAURI__.core.invoke('list_tasks')");
      if (readdedTasks.length !== 1) fail(`history re-add created ${readdedTasks.length} tasks`);
      await evaluate("document.querySelector('[data-route=\"queue\"]')?.click()");
      await waitFor(
        "document.querySelectorAll('#queue-content .task').length === 1",
        10_000,
        "history re-add row",
      );
      stage("waiting for the re-added task to finish");
      await waitFor(
        "document.querySelector('.task')?.dataset.status === 'completed'",
        30_000,
        "re-added task completion",
      );

      const refreshedHistory = await evaluate("window.__TAURI__.core.invoke('list_history')");
      const completedEntry = refreshedHistory.find((item) => item.outputPath && !item.missingFile);
      if (!completedEntry) fail("re-added task did not create a completed history entry");
      await evaluate("document.querySelector('[data-route=\"history\"]')?.click()");
      await waitFor(
        `document.querySelector('.history-row[data-id="${completedEntry.id}"]') !== null`,
        10_000,
        "completed history row",
      );
      stage("removing history with file deletion");
      await evaluate(
        `document.querySelector('.history-row[data-id="${completedEntry.id}"] [data-action="remove-history"]')?.click()`,
      );
      await waitFor("document.querySelector('#modal-title')?.textContent?.includes('移除这条历史记录') || false");
      const historyDeleteCheckedByDefault = await evaluate("document.querySelector('#modal-check')?.checked");
      if (historyDeleteCheckedByDefault !== false) fail("history file deletion checkbox should default to off");
      await evaluate("(() => { const box = document.querySelector('#modal-check'); if (box) box.checked = true; })()");
      await evaluate("document.querySelector('[data-modal-confirm]')?.click()");
      await waitFor(
        "window.__TAURI__.core.invoke('list_history').then((rows) => rows.length === 1)",
        10_000,
        "history remove with file deletion",
      );
      if (existsSync(completedEntry.outputPath)) fail("history remove did not delete the downloaded file");
      stage("missing-file detection, history re-add and history file deletion passed");
    }

    stage("desktop E2E passed");

    console.log(JSON.stringify({
      engine: engine.ytDlpVersion,
      taskState: await taskState(),
      historyEntries: history.length,
      output: entry.outputPath,
      dataDir,
    }, null, 2));
  } finally {
    try {
      if (ws) {
        const closeId = 999999;
        ws.send(JSON.stringify({
          id: closeId,
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
          spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
        } catch {}
      }
    }
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    if (ws) ws.close();
  }
}

const watchdog = setTimeout(() => {
  console.error("[desktop-e2e] watchdog timeout");
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
