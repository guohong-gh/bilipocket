import test from "node:test";
import assert from "node:assert/strict";

import {
  SEASON_PAGE_SIZE,
  filterSeasonEpisodes,
  paginateSeason,
  toggleVisibleSelection,
} from "../../src/js/catalog.js";

const episodes = [
  { bvid: "BV1a", title: "第一集：雨天的便利店" },
  { bvid: "BV1b", title: "第二集：霓虹与雨" },
  { bvid: "BV1c", title: "第三集：末班地铁" },
  { bvid: "BV1d", title: "Episode Four: Raining" },
  { bvid: "BV1e", title: "" },
  { bvid: "BV1f" },
];

test("filterSeasonEpisodes returns everything when the query is blank", () => {
  assert.equal(filterSeasonEpisodes(episodes, "").length, 6);
  assert.equal(filterSeasonEpisodes(episodes, "   ").length, 6);
  assert.equal(filterSeasonEpisodes(episodes, null).length, 6);
  assert.equal(filterSeasonEpisodes(episodes, undefined).length, 6);
});

test("filterSeasonEpisodes matches a Chinese substring in the title", () => {
  const hits = filterSeasonEpisodes(episodes, "便利店").map((item) => item.bvid);
  assert.deepEqual(hits, ["BV1a"]);
  assert.equal(filterSeasonEpisodes(episodes, "雨").length, 2);
});

test("filterSeasonEpisodes is case-insensitive and trims the query", () => {
  assert.deepEqual(
    filterSeasonEpisodes(episodes, "rain").map((item) => item.bvid),
    ["BV1d"],
  );
  assert.deepEqual(
    filterSeasonEpisodes(episodes, "  RAIN  ").map((item) => item.bvid),
    ["BV1d"],
  );
});

test("filterSeasonEpisodes tolerates missing titles and bad input", () => {
  assert.deepEqual(filterSeasonEpisodes(episodes, "地铁").map((item) => item.bvid), ["BV1c"]);
  assert.deepEqual(filterSeasonEpisodes(null, "雨"), []);
  assert.deepEqual(filterSeasonEpisodes(undefined, "雨"), []);
  assert.deepEqual(filterSeasonEpisodes(episodes, "不存在"), []);
});

test("toggleVisibleSelection selects every visible item from a partial selection", () => {
  const next = toggleVisibleSelection(new Set(["BV1a"]), ["BV1a", "BV1b"]);
  assert.deepEqual([...next].sort(), ["BV1a", "BV1b"]);
});

test("toggleVisibleSelection clears the visible items when they are all selected", () => {
  const next = toggleVisibleSelection(new Set(["BV1a", "BV1b", "BV1c"]), ["BV1a", "BV1b"]);
  // 只取消可见的两条，筛选范围外的 BV1c 必须保留。
  assert.deepEqual([...next], ["BV1c"]);
});

test("toggleVisibleSelection never touches items outside the visible set", () => {
  const next = toggleVisibleSelection(new Set(["BV1z"]), ["BV1a"]);
  assert.deepEqual([...next].sort(), ["BV1a", "BV1z"]);
});

test("toggleVisibleSelection is a no-op on an empty visible set", () => {
  const selected = new Set(["BV1a"]);
  const next = toggleVisibleSelection(selected, []);
  assert.deepEqual([...next], ["BV1a"]);
  assert.notEqual(next, selected, "应返回新 Set，不能把原对象返回给调用方当可变状态用");
});

test("toggleVisibleSelection does not mutate the incoming set", () => {
  const selected = new Set(["BV1a"]);
  toggleVisibleSelection(selected, ["BV1a", "BV1b"]);
  assert.deepEqual([...selected], ["BV1a"]);
});

test("toggleVisibleSelection ignores empty bvid entries", () => {
  const next = toggleVisibleSelection(new Set(), ["", null, undefined, "BV1a"]);
  assert.deepEqual([...next], ["BV1a"]);
});

// ---- 合集列表分页（只影响渲染，不影响筛选与全选）----

test("paginateSeason 首屏只切出上限条数", () => {
  const episodes = Array.from({ length: 250 }, (_, index) => ({ bvid: `BV${index}` }));
  const page = paginateSeason(episodes, 200);
  assert.equal(page.shown.length, 200);
  assert.equal(page.remaining, 50);
  assert.equal(page.limit, 200);
  assert.equal(page.nextLimit, 400);
});

test("paginateSeason 在条数不足时不产生剩余", () => {
  const page = paginateSeason([{ bvid: "a" }, { bvid: "b" }], 200);
  assert.equal(page.shown.length, 2);
  assert.equal(page.remaining, 0);
});

test("paginateSeason 对异常上限回落到默认值", () => {
  const episodes = Array.from({ length: 5 }, (_, index) => ({ bvid: `BV${index}` }));
  for (const bad of [0, -1, Number.NaN, null, undefined, "abc"]) {
    const page = paginateSeason(episodes, bad);
    assert.equal(page.limit, SEASON_PAGE_SIZE, `上限 ${bad} 应回落到默认值`);
    assert.equal(page.shown.length, 5);
  }
});

test("paginateSeason 对非数组输入返回空结果", () => {
  const page = paginateSeason(null, 200);
  assert.deepEqual(page.shown, []);
  assert.equal(page.remaining, 0);
});
