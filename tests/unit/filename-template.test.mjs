import test from "node:test";
import assert from "node:assert/strict";

import { expandFilenameTemplate } from "../../src/js/catalog.js";

// 固定时间点，避免断言随运行日期漂移。
const date = new Date(2026, 10, 3, 14, 5, 9); // 2026-11-03 14:05:09 本地时间
const today = "2026-11-03";

// 字段与后端 TemplateVars 对齐：`up` 是 UP 主，`publishedAt` 是**秒**，`completedAt` 是毫秒。
const entry = {
  title: "测试视频",
  up: "UP 主",
  qualityLabel: "1080P",
  bvid: "BV1xx411c7mD",
  pageIndex: 2,
  pageTitle: "第二集",
  completedAt: date.getTime(),
  publishedAt: Math.floor(new Date(2024, 4, 6, 12, 0, 0).getTime() / 1000),
};

test("replaces the basic template variables", () => {
  const output = expandFilenameTemplate("{title}_{up}_{quality}_{bvid}", entry, today);
  assert.equal(output, "测试视频_UP 主_1080P_BV1xx411c7mD");
});

test("formats date with a custom pattern", () => {
  assert.equal(expandFilenameTemplate("{date:%Y%m%d}", entry, today), "20261103");
  assert.equal(expandFilenameTemplate("{date:%Y-%m-%d_%H%M}", entry, today), "2026-11-03_1405");
});

test("defaults to YYYY-MM-DD when no pattern is given", () => {
  assert.equal(expandFilenameTemplate("{date}", entry, today), "2026-11-03");
  assert.equal(expandFilenameTemplate("{pubdate}", entry, today), "2024-05-06");
});

test("keeps an unknown format specifier instead of crashing", () => {
  // 与 Rust 侧 render_template 的语义一致：未知格式符原样保留。
  assert.equal(expandFilenameTemplate("{date:%Q}", entry, today), "%Q");
});

test("treats publishedAt as seconds and falls back to the download date", () => {
  // 秒级时间戳必须归一化，否则会被算成 1970 年。
  assert.equal(expandFilenameTemplate("{pubdate:%Y%m%d}", entry, today), "20240506");
  const withoutPublish = { ...entry, publishedAt: null };
  assert.equal(
    expandFilenameTemplate("{pubdate:%Y%m%d}", withoutPublish, today),
    "20261103",
    "没有发布时间时应回退到完成时间",
  );
});

test("expands page variables for multi-part videos", () => {
  assert.equal(expandFilenameTemplate("{p}", entry, today), "2");
  assert.equal(expandFilenameTemplate("{p_title}", entry, today), "第二集");
  assert.equal(expandFilenameTemplate("P{p}-{p_title}", entry, today), "P2-第二集");
});

test("leaves unknown tokens untouched", () => {
  assert.equal(expandFilenameTemplate("{collection}", entry, today), "{collection}");
});

test("falls back to the same placeholder the backend uses", () => {
  // 后端 sanitize_filename_base("") 的结果是「未命名视频」，预览必须一致。
  assert.equal(expandFilenameTemplate("{title}", { ...entry, title: "" }, today), "未命名视频");
});

test("uses the supplied date string when no timestamps are available", () => {
  const bare = { title: "只有标题" };
  assert.equal(expandFilenameTemplate("{title}_{date}", bare, today), "只有标题_2026-11-03");
});
