import { test, expect } from "@playwright/test";

// 只有这条演示样本带合集（dev/demo-data.js 的 cafe），其它用例不受影响。
const SEASON_BVID = "BV1jz4y1k7Em";

async function resetApp(page) {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/dev/");
  await expect(page.locator("#parse-form")).toBeVisible();
}

async function parseSeasonVideo(page) {
  await page.locator('.sidebar [data-route="download"]').click();
  await page.locator("#url-input").fill(SEASON_BVID);
  await page.locator("#parse-form").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#stage-result .result-title")).toBeVisible();
}

test("合集条目默认全不选，可逐条勾选", async ({ page }) => {
  await resetApp(page);
  await parseSeasonVideo(page);

  await expect(page.locator("#season-list .season-check")).toHaveCount(6);
  await expect(page.locator("#season-count")).toHaveText("已选 0 / 共 6 个");
  await expect(page.locator('[data-action="season-toggle"]')).toHaveText("全选");
  // 方案 A：清晰度继承当前视频，必须把「个别条目会单独失败」提前说清楚。
  await expect(page.locator("#stage-result .adv-season .adv-head span")).toContainText(
    "按上方所选清晰度逐个入队",
  );
  await expect(page.locator("#stage-result .adv-season .adv-head span")).toContainText(
    "单独失败",
  );

  await page.locator('#season-list .season-check[data-bvid="BV1cafe00003"]').check();
  await expect(page.locator("#season-count")).toHaveText("已选 1 / 共 6 个");
  await expect(page.locator("#enqueue-btn")).toContainText("下载已选 1 个");
});

test("按标题搜索只保留匹配项，全选只作用于搜索结果", async ({ page }) => {
  await resetApp(page);
  await parseSeasonVideo(page);

  await page.locator("#season-search").fill("便利店");
  await expect(page.locator("#season-list .season-check")).toHaveCount(3);
  await expect(page.locator("#season-count")).toHaveText("已选 0 / 共 6 个 · 当前筛选出 3 个");

  // 全选只选中筛选出来的 3 条，不是整个合集
  await page.locator('[data-action="season-toggle"]').click();
  await expect(page.locator("#season-list .season-check:checked")).toHaveCount(3);
  await expect(page.locator("#season-count")).toHaveText("已选 3 / 共 6 个 · 当前筛选出 3 个");
  await expect(page.locator('[data-action="season-toggle"]')).toHaveText("取消全选");

  // 同一按钮再点一次 → 取消当前筛选的全选
  await page.locator('[data-action="season-toggle"]').click();
  await expect(page.locator("#season-list .season-check:checked")).toHaveCount(0);
  await expect(page.locator("#season-count")).toHaveText("已选 0 / 共 6 个 · 当前筛选出 3 个");
  await expect(page.locator('[data-action="season-toggle"]')).toHaveText("全选");
});

test("切换搜索词不会丢失已勾选条目", async ({ page }) => {
  await resetApp(page);
  await parseSeasonVideo(page);

  await page.locator("#season-search").fill("雨");
  await expect(page.locator("#season-list .season-check")).toHaveCount(2);
  await page.locator('[data-action="season-toggle"]').click();
  await expect(page.locator("#season-count")).toHaveText("已选 2 / 共 6 个 · 当前筛选出 2 个");

  // 换成另一个关键词：列表只剩 1 条且它没被勾选，但之前选的 2 条仍然记着
  await page.locator("#season-search").fill("地铁");
  await expect(page.locator("#season-list .season-check")).toHaveCount(1);
  await expect(page.locator("#season-list .season-check:checked")).toHaveCount(0);
  await expect(page.locator("#season-count")).toHaveText("已选 2 / 共 6 个 · 当前筛选出 1 个");

  // 清空搜索后，之前勾选的 2 条恢复成选中状态
  await page.locator("#season-search").fill("");
  await expect(page.locator("#season-list .season-check")).toHaveCount(6);
  await expect(page.locator("#season-list .season-check:checked")).toHaveCount(2);
});

test("搜索无匹配时给出空状态且不影响已选", async ({ page }) => {
  await resetApp(page);
  await parseSeasonVideo(page);

  await page.locator('#season-list .season-check[data-bvid="BV1cafe00001"]').check();
  await page.locator("#season-search").fill("不存在的关键词");
  await expect(page.locator("#season-list .adv-empty")).toBeVisible();
  await expect(page.locator("#season-list .season-check")).toHaveCount(0);
  await expect(page.locator("#season-count")).toHaveText("已选 1 / 共 6 个 · 当前筛选出 0 个");
  // 空列表下点全选是空操作，不能把已选的清掉
  await page.locator('[data-action="season-toggle"]').click();
  await expect(page.locator("#season-count")).toHaveText("已选 1 / 共 6 个 · 当前筛选出 0 个");
});

test("按勾选逐个入队，任务数与条目一一对应", async ({ page }) => {
  await resetApp(page);
  await page.locator('.sidebar [data-route="queue"]').click();
  const clear = page.locator("#clear-queue");
  if (!(await clear.isDisabled())) {
    await clear.click();
    await page.locator("[data-modal-confirm]").click();
  }
  await parseSeasonVideo(page);

  await page.locator("#season-search").fill("雨");
  await expect(page.locator("#season-list .season-check")).toHaveCount(2);
  await page.locator('[data-action="season-toggle"]').click();
  await expect(page.locator("#enqueue-btn")).toContainText("下载已选 2 个");

  await page.locator("#enqueue-btn").click();
  await page.locator('.sidebar [data-route="queue"]').click();
  await expect(page.locator("#queue-content .task")).toHaveCount(2);
  await expect(page.locator("#queue-content .task", { hasText: "第一集：雨天的便利店" })).toHaveCount(1);
  await expect(page.locator("#queue-content .task", { hasText: "第二集：霓虹与雨" })).toHaveCount(1);
  // 没勾的条目不能被下下来
  await expect(page.locator("#queue-content .task", { hasText: "末班地铁" })).toHaveCount(0);
});

test("分 P 与合集互斥：切到合集会清掉分 P 勾选，反之亦然", async ({ page }) => {
  await resetApp(page);
  await parseSeasonVideo(page);

  // 这条样本同时带分 P 与合集，两块都会渲染
  await expect(page.locator("#season-list .season-check")).toHaveCount(6);
  await expect(page.locator("#stage-result .page-check")).toHaveCount(2);

  // 先勾分 P
  await page.locator('#stage-result .page-check[data-page-index="1"]').check();
  await expect(page.locator('#stage-result .page-check[data-page-index="1"]')).toBeChecked();
  await expect(page.locator("#enqueue-btn")).toContainText("加入下载队列");

  // 再勾合集条目 → 分 P 被清掉，入队按钮改为按合集计数
  await page.locator('#season-list .season-check[data-bvid="BV1cafe00002"]').check();
  await expect(page.locator('#stage-result .page-check[data-page-index="1"]')).not.toBeChecked();
  await expect(page.locator("#season-count")).toHaveText("已选 1 / 共 6 个");
  await expect(page.locator("#enqueue-btn")).toContainText("下载已选 1 个");

  // 反过来：勾分 P 会把合集勾选清掉
  await page.locator('#stage-result .page-check[data-page-index="2"]').check();
  await expect(page.locator("#season-list .season-check:checked")).toHaveCount(0);
  await expect(page.locator("#season-count")).toHaveText("已选 0 / 共 6 个");
  await expect(page.locator("#enqueue-btn")).toContainText("加入下载队列");
});

test("合集超过 200 条时分批渲染，全选仍覆盖完整筛选结果", async ({ page }) => {
  await resetApp(page);
  await page.locator('.sidebar [data-route="download"]').click();
  await page.locator("#url-input").fill("BV1pAgE411v7");
  await page.locator("#parse-form").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#stage-result .result-title")).toBeVisible();

  // 首屏只渲染 200 条，其余靠「继续显示」追加。
  await expect(page.locator("#season-list .season-check")).toHaveCount(200);
  await expect(page.locator("#season-count")).toHaveText("已选 0 / 共 250 个 · 已显示前 200 条");
  const more = page.locator('[data-action="season-more"]');
  await expect(more).toHaveText("继续显示（还有 50 条）");

  // 关键边界：全选按完整筛选结果算，不能只选已渲染的 200 条。
  await page.locator('[data-action="season-toggle"]').click();
  await expect(page.locator("#season-count")).toHaveText("已选 250 / 共 250 个 · 已显示前 200 条");
  await expect(page.locator("#season-list .season-check:checked")).toHaveCount(200);

  // 展开后剩余条目出现，且已勾选状态保持。
  await more.click();
  await expect(page.locator("#season-list .season-check")).toHaveCount(250);
  await expect(page.locator("#season-list .season-check:checked")).toHaveCount(250);
  await expect(page.locator('[data-action="season-more"]')).toHaveCount(0);

  // 换搜索词回到首屏。
  await page.locator("#season-search").fill("第 25 集");
  await expect(page.locator("#season-count")).toContainText("已选 250 / 共 250 个");
});
