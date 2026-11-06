import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { scanPaths } from "./privacy.mjs";

const root = process.cwd();
const release = join(root, "src-tauri", "target", "release");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = packageJson.version || "0.0.0";
const bundleRoot = join(release, "bundle", "portable");
const folderName = `BiliPocket_${version}_x64_portable`;
const folder = join(bundleRoot, folderName);
const zipPath = join(bundleRoot, `${folderName}.zip`);

const required = [
  ["src-tauri/target/release/bilipocket.exe", join(release, "bilipocket.exe")],
  ["src-tauri/binaries/yt-dlp-x86_64-pc-windows-msvc.exe", join(root, "src-tauri", "binaries", "yt-dlp-x86_64-pc-windows-msvc.exe")],
  ["src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe", join(root, "src-tauri", "binaries", "ffmpeg-x86_64-pc-windows-msvc.exe")],
];

for (const [label, path] of required) {
  try {
    await stat(path);
  } catch {
    console.error(`缺少 ${label}，请先运行 npm run build（并准备 sidecar）。`);
    process.exit(1);
  }
}

const sidecarCheck = spawnSync(process.execPath, [join(root, "scripts", "verify-sidecars.mjs")], {
  stdio: "inherit",
});
if (sidecarCheck.status !== 0) {
  process.exit(sidecarCheck.status ?? 1);
}

await rm(bundleRoot, { recursive: true, force: true });
await mkdir(folder, { recursive: true });

await cp(join(release, "bilipocket.exe"), join(folder, "BiliPocket.exe"));
await cp(join(root, "src-tauri", "binaries", "yt-dlp-x86_64-pc-windows-msvc.exe"), join(folder, "yt-dlp.exe"));
await cp(join(root, "src-tauri", "binaries", "ffmpeg-x86_64-pc-windows-msvc.exe"), join(folder, "ffmpeg.exe"));
await cp(join(root, "LICENSES"), join(folder, "LICENSES"), { recursive: true });
await cp(join(root, "README.md"), join(folder, "README.md"));
await cp(join(root, "RELEASE.md"), join(folder, "RELEASE.md"));
await cp(join(root, "SECURITY.md"), join(folder, "SECURITY.md"));
await cp(
  join(root, "src-tauri", "binaries", "ENGINE_MANIFEST.json"),
  join(folder, "ENGINE_MANIFEST.json"),
);
await cp(join(root, "src-tauri", "update-source.txt"), join(folder, "update-source.txt"));
await writeFile(join(folder, "BiliPocket.portable"), "portable\n", "utf8");

const privacyFindings = scanPaths([folder], { env: process.env, root });
if (privacyFindings.length) {
  for (const finding of privacyFindings) {
    console.error(`FAIL ${finding.file}: ${finding.label}`);
  }
  console.error("Portable package contains local build environment data; refusing to create the zip.");
  process.exit(1);
}

const archive = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Compress-Archive -LiteralPath '${folder.replaceAll("'", "''")}' -DestinationPath '${zipPath.replaceAll("'", "''")}' -Force`,
  ],
  { stdio: "inherit" },
);

if (archive.status !== 0) {
  console.error("PowerShell Compress-Archive 失败；便携目录仍保留在 bundle/portable。");
  process.exit(archive.status ?? 1);
}

console.log(`便携版目录：${folder}`);
console.log(`便携版压缩包：${zipPath}`);
