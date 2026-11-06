import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { scanPaths } from "./privacy.mjs";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = packageJson.version;
const release = join(root, "src-tauri", "target", "release");
const targets = [
  join(release, "bilipocket.exe"),
  join(release, "bundle", "nsis", `BiliPocket_${version}_x64-setup.exe`),
  join(release, "bundle", "portable", `BiliPocket_${version}_x64_portable`),
].filter((path) => existsSync(path));

if (!targets.length) {
  console.error("FAIL no release artifacts found to scan.");
  process.exit(1);
}

const findings = scanPaths(targets, { env: process.env, root });
for (const finding of findings) {
  console.error(`FAIL ${relative(root, finding.file)}: ${finding.label}`);
}
if (findings.length) {
  console.error("Privacy check failed; do not distribute these artifacts.");
  process.exit(1);
}
console.log(`Privacy check passed for v${version}: no local account, machine, or project paths found.`);
