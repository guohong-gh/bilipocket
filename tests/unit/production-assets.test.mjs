import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../../src/", import.meta.url));

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = walk(src);
const textFiles = files.filter((path) => /\.(js|html|css|d\.ts)$/.test(path));
const combined = textFiles.map((path) => readFileSync(path, "utf8")).join("\n");

test("production sources contain no demo store or sample data", () => {
  assert.ok(!existsSync(join(src, "js", "store.js")));
  assert.ok(!existsSync(join(src, "js", "mock-data.js")));
  assert.ok(!combined.includes("SAMPLE_VIDEOS"));
  assert.ok(!combined.includes("getSampleByInput"));
  assert.ok(!combined.includes("mock-data.js"));
});

test("production sources do not reference demo covers", () => {
  assert.ok(!existsSync(join(src, "assets", "covers")));
  assert.ok(!combined.includes("assets/covers/"));
  assert.ok(existsSync(join(src, "assets", "cover-placeholder.svg")));
});
