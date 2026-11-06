import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
const version = option("version") || packageJson.version;
const installerUrl = option("url");
const signaturePath = option("signature");
const notes = option("notes") || "";
const output = option("out") || join(
  process.cwd(),
  "src-tauri",
  "target",
  "release",
  "bundle",
  "updater",
  "latest.json",
);

if (!installerUrl || !signaturePath) {
  console.error("用法：npm run make:latest -- --url https://…/BiliPocket_x64-setup.exe --signature path/to/installer.sig [--version 0.8.1] [--notes \"…\"]");
  process.exit(1);
}
const url = new URL(installerUrl);
if (url.protocol !== "https:") {
  console.error("更新包 URL 必须使用 HTTPS。");
  process.exit(1);
}
const signature = (await readFile(signaturePath, "utf8")).trim();
if (!signature) {
  console.error("签名文件为空。");
  process.exit(1);
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: url.toString(),
    },
  },
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`已生成更新清单：${output}`);
console.log(`版本：${version}`);
console.log(`下载地址：${url.toString()}`);
