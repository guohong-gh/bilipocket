import { spawnSync } from "node:child_process";
import { applyPrivateBuildEnv } from "./privacy.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const command = ["tauri", "build", ...args];
const env = applyPrivateBuildEnv(process.env, root);
console.log("[build] local account and project paths are remapped in compiled artifacts");

const result =
  process.platform === "win32"
    ? spawnSync("cmd.exe", ["/C", "npx", ...command], { cwd: root, stdio: "inherit", env })
    : spawnSync("npx", command, { cwd: root, stdio: "inherit", env });

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
