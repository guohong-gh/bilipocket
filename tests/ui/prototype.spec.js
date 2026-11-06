import { test, expect } from "@playwright/test";

const SAMPLE_BVID = "BV1xx411c7mD";

async function resetApp(page) {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/dev/");
  await expect(page.locator("#parse-form")).toBeVisible();
}

async function clearQueue(page) {
  await page.locator('.sidebar [data-route="queue"]').click();
  const clear = page.locator("#clear-queue");
  if (await clear.isDisabled()) return;
  await clear.click();
  await page.locator("[data-modal-confirm]").click();
  await expect(page.locator("#queue-content .empty-state")).toBeVisible();
}

async function parseSample(page) {
  await page.locator('.sidebar [data-route="download"]').click();
  await page.locator("#url-input").fill(SAMPLE_BVID);
  await page.locator("#parse-form").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#stage-result .result-title")).toBeVisible();
  return (await page.locator(".result-title").innerText()).trim();
}

test("解析示例视频并按游客权限展示清晰度", async ({ page }) => {
  await resetApp(page);
  await parseSample(page);

  await expect(page.locator(".quality-option")).toHaveCount(7);
  await expect(page.locator(".quality-option.is-locked")).toHaveCount(3);
  await expect(page.locator('.quality-option[data-quality="720P"]')).toHaveClass(/is-active/);
  await expect(page.locator(".quality-option.is-active .q-recommend")).toHaveText("推荐");
  await expect(page.locator("#enqueue-btn")).toBeEnabled();
});

test("加入队列后可取消并重新下载", async ({ page }) => {
  await resetApp(page);
  await clearQueue(page);
  const title = await parseSample(page);

  await page.locator("#enqueue-btn").click();
  await page.locator('.sidebar [data-route="queue"]').click();
  await expect(page.locator("#queue-content .task")).toHaveCount(1);
  const task = page.locator(".task", { hasText: title }).first();
  await expect(task).toBeVisible();
  await expect(task.locator(".status-badge")).toContainText("下载中");
  await expect(page.locator('.task-group[data-group="active"]')).toHaveCount(1);

  await task.locator('[data-action="cancel"]').click();
  await expect(page.locator("#modal-title")).toContainText("取消这个下载任务");
  await expect(page.locator("#modal-check")).not.toBeChecked();
  await page.locator("[data-modal-confirm]").click();
  await expect(task.locator(".status-badge")).toContainText("已取消");
  await expect(task.locator('[data-action="retry"]')).toBeVisible();
  await expect(page.locator('.task-group[data-group="terminated"] .task')).toHaveCount(1);

  await task.locator('[data-action="retry"]').click();
  await expect(task.locator(".status-badge")).toContainText(/等待中|下载中/);
  await expect(page.locator('.task-group[data-group="active"] .task')).toHaveCount(1);
});

test("快速双击只加入一个任务", async ({ page }) => {
  await resetApp(page);
  await clearQueue(page);
  await parseSample(page);
  await page.locator("#enqueue-btn").dblclick();
  await page.locator('.sidebar [data-route="queue"]').click();
  await expect(page.locator("#queue-content .task")).toHaveCount(1);
});

test("可以只下载弹幕和字幕", async ({ page }) => {
  await resetApp(page);
  await clearQueue(page);
  await parseSample(page);
  await expect(page.locator("#enqueue-extras-btn")).toBeEnabled();

  await page.locator("#enqueue-extras-btn").click();
  // 不能用「按钮变禁用」证明去重：mock 的附加任务约 250ms 就完成，
  // 而 duplicate 判定会跳过已完成任务，按钮随即恢复可用，断言存在竞态。
  // 改为断言可观察结果——队列里恰好出现一个附加内容任务。
  await page.locator('.sidebar [data-route="queue"]').click();
  await expect(page.locator("#queue-content .task")).toHaveCount(1);
  const task = page.locator("#queue-content .task").first();
  await expect(task).toContainText("附加内容");
  await expect(task).toContainText("附加文件");
  await expect(task).toContainText("弹幕");
  await expect(task).toContainText("字幕");
});

test("设置页四卡片、紧凑控件与三态主题", async ({ page }) => {
  await resetApp(page);
  await page.locator('.sidebar [data-route="settings"]').click();
  await expect(page.locator(".settings-page .settings-card")).toHaveCount(4);
  await expect(page.locator("#theme-choices")).toHaveCount(0);
  await expect(page.locator("#concurrency-input")).toHaveValue("2");
  await expect(page.locator("#retry-max")).toHaveValue("3");
  await expect(page.locator("#retry-base")).toHaveValue("15");
  await expect(page.locator("#fragment-retries")).toHaveValue("5");
  await expect(page.locator("#preferred-quality .segmented-option")).toHaveCount(5);
  await expect(page.locator("#toggle-autostart")).toBeDisabled();
  await expect(page.locator("#data-dir-value")).toHaveText("浏览器预览 · localStorage");
  const width = await page.locator(".settings-page").evaluate((element) => element.getBoundingClientRect().width);
  expect(width).toBeLessThanOrEqual(720);

  await page.locator("#theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "dark");
  await page.locator("#theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "system");
  await page.locator("#theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "light");
});

test("关闭解析默认勾选后不预选弹幕和字幕", async ({ page }) => {
  await resetApp(page);
  await page.locator('.sidebar [data-route="settings"]').click();
  await page.locator("#toggle-default-danmaku").click();
  await page.locator("#toggle-default-subtitles").click();
  await expect(page.locator("#toggle-default-danmaku")).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("#toggle-default-subtitles")).toHaveAttribute("aria-checked", "false");
  await parseSample(page);
  await expect(page.locator("#enqueue-extras-btn")).toBeDisabled();
  await page.locator('[data-extras-open="danmaku"]').click();
  await expect(page.locator("#extras-drawer [data-danmaku-type]:checked")).toHaveCount(0);
  await expect(page.locator("#extras-drawer [data-subtitle-track]:checked")).toHaveCount(0);
  await page.locator("#extras-drawer [data-danmaku-type]").first().check({ force: true });
  await expect(page.locator("#enqueue-extras-btn")).toBeEnabled();
  await page.keyboard.press("Escape");
});

test("弹幕与字幕抽屉可打开并关闭", async ({ page }) => {
  await resetApp(page);
  await parseSample(page);

  await page.locator('[data-extras-open="danmaku"]').click();
  const drawer = page.locator("#extras-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "弹幕与字幕" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});

test("切换演示账号后清晰度与默认档同步更新", async ({ page }) => {
  await resetApp(page);
  await page.locator('.sidebar [data-route="settings"]').click();
  await page.locator('#account-tier [data-account-tier="member"]').click();
  await expect(page.locator('#account-tier [data-account-tier="member"]')).toHaveAttribute(
    "aria-checked",
    "true",
  );

  await parseSample(page);
  await expect(page.locator(".quality-option.is-locked")).toHaveCount(2);
  await expect(page.locator('.quality-option[data-quality="1080P"]')).not.toHaveClass(/is-locked/);
  await expect(page.locator('.quality-option[data-quality="1080P"]')).toHaveClass(/is-active/);

  await page.locator('.sidebar [data-route="settings"]').click();
  await expect(page.locator('#preferred-quality [data-quality="1080P"]')).toBeVisible();
  await expect(page.locator("#rate-limit")).toHaveValue("0");
  await page.locator("#rate-limit").fill("2048");
  await page.locator("#rate-limit").blur();
  await expect(page.locator("#rate-limit")).toHaveValue("2048");

  // 重试字段：超范围输入在失焦时被夹紧，0 是合法值不被回退成默认。
  await page.locator("#retry-max").fill("99");
  await page.locator("#retry-max").blur();
  await expect(page.locator("#retry-max")).toHaveValue("10");
  await page.locator("#retry-max").fill("0");
  await page.locator("#retry-max").blur();
  await expect(page.locator("#retry-max")).toHaveValue("0");
  await page.locator("#retry-base").fill("1");
  await page.locator("#retry-base").blur();
  await expect(page.locator("#retry-base")).toHaveValue("3");
});

test("生产页面不含演示 DOM 与演示文案", async ({ request }) => {
  const response = await request.get("/");
  expect(response.ok()).toBeTruthy();
  const html = await response.text();
  expect(html).not.toContain("account-tier");
  expect(html).not.toContain("sample-group");
  expect(html).not.toContain("reset-demo");
  expect(html).not.toContain("模拟演示");
  expect(html).not.toContain("离线原型");
  expect(html).toContain("真实解析 · 文件写入本机");
});

test("生产入口在浏览器中给出 /dev/ 提示", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toContainText("这是桌面版页面");
  await expect(page.locator("body")).toContainText("/dev/");
});

test("窄窗口各页面无横向溢出", async ({ page }) => {
  await resetApp(page);
  for (const size of [
    { width: 1040, height: 700 },
    { width: 900, height: 700 },
    { width: 640, height: 800 },
  ]) {
    await page.setViewportSize(size);
    for (const route of ["download", "settings", "queue", "history"]) {
      await page.locator(`.sidebar [data-route="${route}"]`).click();
      const widths = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(widths.scroll, `${route} at ${size.width}px`).toBeLessThanOrEqual(widths.client + 1);
    }
  }
});
