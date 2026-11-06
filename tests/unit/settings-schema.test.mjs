import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SETTINGS,
  SETTINGS_KEYS,
  SETTINGS_SCHEMA,
  applySettingsPatch,
  hydrateSettings,
  legacySettingsPatch,
  toWireSettings,
} from "../../src/js/settings-schema.js";
import { AUTO_QUALITY } from "../../src/js/catalog.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const domainSource = readFileSync(`${repoRoot}src-tauri/src/domain.rs`, "utf8");

/** 从 Rust 源码里取 `pub struct Settings { ... }` 的字段名。 */
function rustSettingsFields() {
  const start = domainSource.indexOf("pub struct Settings {");
  assert.ok(start >= 0, "domain.rs 里应存在 Settings 结构体");
  const end = domainSource.indexOf("\n}", start);
  const block = domainSource.slice(start, end);
  return [...block.matchAll(/pub\s+(\w+)\s*:/g)].map((match) => match[1]);
}

const snakeToCamel = (value) => value.replace(/_([a-z])/g, (_, char) => char.toUpperCase());

test("schema 键集完整且两端 hydrate 都产出同一组键", () => {
  assert.equal(new Set(SETTINGS_KEYS).size, SETTINGS_KEYS.length, "schema 内不应有重复键");
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS), SETTINGS_KEYS);

  const demo = hydrateSettings({}, { surface: "demo" });
  const desktop = hydrateSettings({}, { surface: "desktop" });
  assert.deepEqual(Object.keys(demo), SETTINGS_KEYS);
  assert.deepEqual(Object.keys(desktop), SETTINGS_KEYS);
});

test("schema 与 Rust Settings 结构体字段一一对应", () => {
  const rustFields = rustSettingsFields().map(snakeToCamel);
  const schemaFields = SETTINGS_SCHEMA.filter((field) => field.rust).map((field) => field.key);

  const missingInSchema = rustFields.filter((name) => !schemaFields.includes(name));
  const missingInRust = schemaFields.filter((name) => !rustFields.includes(name));
  assert.deepEqual(missingInSchema, [], "Rust 有但 schema 缺的字段");
  assert.deepEqual(missingInRust, [], "schema 有但 Rust 缺的字段");
});

test("枚举取值都能在 Rust 侧找到对应字面量", () => {
  for (const field of SETTINGS_SCHEMA.filter((item) => item.kind === "enum")) {
    if (!field.rust) continue; // accountTier 是纯前端字段
    for (const value of field.values) {
      assert.ok(
        domainSource.includes(`"${value}"`),
        `枚举 ${field.key} 的取值 ${value} 在 domain.rs 中不存在，Rust 会静默回退`,
      );
    }
  }
});

test("demo 与 desktop 的归一结果只在三处合理差异上不同", () => {
  const malformed = [
    {},
    null,
    { theme: "", maxConcurrent: "abc", rateLimitKbps: -5 },
    { theme: "neon", coverNaming: "huge", subtitleFormat: "vtt" },
    { maxConcurrent: 999, retryMax: -3, fragmentRetries: 999 },
    { preferredQuality: "1080P", accountTier: "vip" },
    { downloadDir: "   ", filenameTemplate: "  " },
    { retryBaseSeconds: "2.7", notifyOnComplete: "false" },
  ];

  const differences = new Set(["downloadDir", "accountTier"]);
  for (const raw of malformed) {
    const demo = hydrateSettings(raw, { surface: "demo" });
    const desktop = hydrateSettings(raw, { surface: "desktop" });
    for (const key of SETTINGS_KEYS) {
      if (differences.has(key)) continue;
      assert.deepEqual(
        desktop[key],
        demo[key],
        `字段 ${key} 在两端归一结果不一致（输入 ${JSON.stringify(raw)}）`,
      );
    }
  }
});

test("desktop 端 accountTier 恒为 guest，且不进入请求体", () => {
  const desktop = hydrateSettings({ accountTier: "vip" }, { surface: "desktop" });
  assert.equal(desktop.accountTier, "guest");

  const wire = toWireSettings(desktop);
  assert.equal("accountTier" in wire, false, "accountTier 是纯前端字段，不能发给 Rust");
});

test("patch 只改出现的键，并对越界值做钳制", () => {
  const base = hydrateSettings({}, { surface: "demo" });

  const untouched = applySettingsPatch(base, {}, { surface: "demo" });
  assert.deepEqual(untouched, base);

  const clamped = applySettingsPatch(
    base,
    { maxConcurrent: 99, rateLimitKbps: 102401, retryBaseSeconds: 1 },
    { surface: "demo" },
  );
  assert.equal(clamped.maxConcurrent, 5);
  assert.equal(clamped.rateLimitKbps, 102400);
  assert.equal(clamped.retryBaseSeconds, 3);

  const rounded = applySettingsPatch(base, { maxConcurrent: 2.7 }, { surface: "demo" });
  assert.equal(rounded.maxConcurrent, 3);

  // 空路径视为「不改」，空模板回落到默认值。
  const emptyPath = applySettingsPatch(base, { downloadDir: "  " }, { surface: "desktop" });
  assert.equal(emptyPath.downloadDir, base.downloadDir);
  const emptyTemplate = applySettingsPatch(base, { filenameTemplate: "  " }, { surface: "demo" });
  assert.equal(emptyTemplate.filenameTemplate, DEFAULT_SETTINGS.filenameTemplate);

  // 未知键不进入结果。
  const unknown = applySettingsPatch(base, { notASetting: 1 }, { surface: "demo" });
  assert.equal("notASetting" in unknown, false);
});

test("demo 端 patch 会按档位回落不兼容的清晰度", () => {
  const isAllowed = (quality, tier) => quality === "1080P" && tier !== "guest";
  const base = hydrateSettings({}, { surface: "demo", isQualityAllowed: isAllowed });

  const upgraded = applySettingsPatch(
    base,
    { accountTier: "vip", preferredQuality: "1080P" },
    { surface: "demo", isQualityAllowed: isAllowed },
  );
  assert.equal(upgraded.preferredQuality, "1080P");

  const downgraded = applySettingsPatch(
    upgraded,
    { accountTier: "guest" },
    { surface: "demo", isQualityAllowed: isAllowed },
  );
  assert.equal(downgraded.preferredQuality, AUTO_QUALITY, "降级后不兼容的档位应回落到 auto");
});

test("wire 请求体键集等于 Rust 字段，且数值都是整数", () => {
  const wire = toWireSettings(DEFAULT_SETTINGS);
  const rustFields = rustSettingsFields().map(snakeToCamel).sort();
  assert.deepEqual(Object.keys(wire).sort(), rustFields);

  for (const [key, value] of Object.entries(wire)) {
    const allowed = ["string", "number", "boolean"];
    assert.ok(allowed.includes(typeof value), `${key} 的类型 ${typeof value} 不合法`);
    if (typeof value === "number") {
      assert.ok(Number.isInteger(value), `${key} 必须是整数，否则 Rust 的 u32 反序列化会失败`);
    }
  }
});

test("旧版迁移只挑出 schema 标记的字段", () => {
  const patch = legacySettingsPatch({
    theme: "dark",
    downloadDir: "D:\\视频",
    maxConcurrent: "9",
    filenameTemplate: "{title}",
    rateLimitKbps: 1024,
    preferredQuality: "1080P",
    notifyOnComplete: false,
    minimizeToTray: true,
    retryMax: 9,
    saveNfo: true,
  });
  assert.deepEqual(Object.keys(patch).sort(), [
    "downloadDir",
    "filenameTemplate",
    "maxConcurrent",
    "minimizeToTray",
    "notifyOnComplete",
    "preferredQuality",
    "rateLimitKbps",
    "theme",
  ]);
});

test("jsconfig 的 include 覆盖 src/js 下所有模块", () => {
  // 白名单漏加不会报错，只会让类型检查静默跳过，所以单独守一条。
  const jsconfig = JSON.parse(readFileSync(`${repoRoot}jsconfig.json`, "utf8"));
  const included = new Set(jsconfig.include);
  const modules = readdirSync(`${repoRoot}src/js`)
    .filter((name) => name.endsWith(".js"))
    .map((name) => `src/js/${name}`);
  const missing = modules.filter((path) => !included.has(path));
  assert.deepEqual(missing, [], "以下模块未被类型检查覆盖");
});
