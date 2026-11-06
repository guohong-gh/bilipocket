import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../../src/styles/tokens.css", import.meta.url), "utf8");

test("tokens.css exposes the current neutral palette", () => {
  assert.match(css, /--paper:\s*#fafafa/);
  assert.match(css, /--accent:\s*#e60023/);
  assert.match(css, /--radius-xs:\s*8px/);
});

test("legacy v0.5 tokens and duplicate dark theme block are removed", () => {
  for (const name of [
    "--space-1",
    "--space-8",
    "--ease-out",
    "--weight-strong",
    "--surface-3",
    "--brand-2",
    "--green-rgb",
  ]) {
    assert.ok(!css.includes(`${name}:`), `${name} should be removed`);
  }
  assert.equal((css.match(/\[data-theme="dark"\]/g) || []).length, 1);
});
