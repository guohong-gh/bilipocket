import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { scanPaths } from "./privacy.mjs";

const root = process.cwd();
const failures = [];
const warnings = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const packageJson = await readJson(join(root, "package.json"));
const tauriConfig = await readJson(join(root, "src-tauri", "tauri.conf.json"));
const cargoToml = await readFile(join(root, "src-tauri", "Cargo.toml"), "utf8");
const cargoLock = await readFile(join(root, "src-tauri", "Cargo.lock"), "utf8");
const version = packageJson.version;

check(tauriConfig.version === version, `tauri.conf.json version ${tauriConfig.version} != package ${version}`);
check(
  new RegExp(`^version = "${version.replaceAll(".", "\\.")}"`, "m").test(cargoToml),
  "Cargo.toml version does not match package.json",
);
check(
  new RegExp(`name = "bilipocket"\\nversion = "${version.replaceAll(".", "\\.")}"`).test(cargoLock),
  "Cargo.lock root package version does not match package.json",
);

const installer = join(
  root,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
  `BiliPocket_${version}_x64-setup.exe`,
);
const signature = `${installer}.sig`;
const portable = join(
  root,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "portable",
  `BiliPocket_${version}_x64_portable.zip`,
);
check(existsSync(installer), `missing installer: ${installer}`);
check(existsSync(signature), `missing updater signature: ${signature}`);
check(existsSync(portable), `missing portable zip: ${portable}`);
const portableFolder = portable.replace(/\.zip$/, "");
check(existsSync(join(portableFolder, "BiliPocket.portable")), "portable marker is missing");
const releaseExe = join(root, "src-tauri", "target", "release", "bilipocket.exe");
const privacyFindings = scanPaths(
  [releaseExe, installer, portableFolder].filter((path) => existsSync(path)),
  { env: process.env, root },
);
for (const finding of privacyFindings) {
  failures.push(`personal build data (${finding.label}) in ${relative(root, finding.file)}`);
}

const DEMO_MARKERS = ["模拟演示", "离线原型", "重置演示数据", "试试示例"];
for (const binary of [releaseExe, join(portableFolder, "BiliPocket.exe")]) {
  if (!existsSync(binary)) continue;
  const bytes = await readFile(binary);
  for (const marker of DEMO_MARKERS) {
    check(
      !bytes.includes(Buffer.from(marker, "utf8")),
      `demo copy (${marker}) is embedded in ${relative(root, binary)}`,
    );
  }
}
if (existsSync(portable)) {
  const command = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$zip = [IO.Compression.ZipFile]::OpenRead('${portable.replaceAll("'", "''")}')`,
    "$zip.Entries | ForEach-Object { $_.FullName }",
    "$zip.Dispose()",
  ].join("; ");
  const entries = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
  });
  check(entries.status === 0, "could not open the portable zip");
  const names = (entries.stdout || "").split(/\r?\n/).filter(Boolean);
  for (const name of names) {
    check(
      !/^[A-Za-z]:|^[\\/]|(^|[\\/])\.\.([\\/]|$)/.test(name),
      `portable zip contains an absolute or unsafe path: ${name}`,
    );
  }
  for (const required of [
    "BiliPocket.exe",
    "BiliPocket.portable",
    "yt-dlp.exe",
    "ffmpeg.exe",
    "LICENSES/THIRD_PARTY.md",
    "update-source.txt",
  ]) {
    check(
      names.some((name) => name.replaceAll("\\", "/").endsWith(required)),
      `portable zip is missing ${required}`,
    );
  }
}
if (existsSync(installer)) {
  check((await stat(installer)).size > 10_000_000, "installer is unexpectedly small");
}
const nsisScript = join(root, "src-tauri", "target", "release", "nsis", "x64", "installer.nsi");
if (existsSync(nsisScript)) {
  const script = await readFile(nsisScript, "utf8");
  check(
    script.includes("SendMessage $DeleteAppDataCheckbox 0x00F1 1 0"),
    "uninstaller app-data checkbox is not default-checked",
  );
  check(script.includes("nsis-hooks.nsh"), "uninstaller cleanup hooks are not included");
}
const hooksPath = join(root, "src-tauri", "nsis-hooks.nsh");
if (existsSync(hooksPath)) {
  const hooks = await readFile(hooksPath, "utf8");
  check(hooks.includes("cmdkey.exe"), "uninstaller does not remove the Windows credential");
  check(
    hooks.includes("bilibili-session.BiliPocket"),
    "uninstaller credential target is missing",
  );
  check(
    hooks.includes("com.bilipocket.desktop"),
    "uninstaller does not remove app data directories",
  );
  check(
    hooks.includes("$UpdateMode <> 1"),
    "uninstaller cleanup is not guarded against update mode",
  );
} else {
  check(false, "nsis-hooks.nsh is missing");
}
if (existsSync(portable)) {
  check((await stat(portable)).size > 10_000_000, "portable zip is unexpectedly small");
}
if (existsSync(signature)) {
  const raw = (await readFile(signature, "utf8")).trim();
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  check(decoded.includes(`version:${version}`), "updater signature is not bound to the package version");
}

const updateSource = join(root, "src-tauri", "update-source.txt");
const source = existsSync(updateSource) ? (await readFile(updateSource, "utf8")).trim() : "";
if (source) {
  check(/^https:\/\//i.test(source), "update-source.txt must use HTTPS in a release build");
} else {
  warnings.push("update-source.txt is empty; the shipped build will keep auto-update disabled");
}

const sidecarCheck = spawnSync(process.execPath, [join(root, "scripts", "verify-sidecars.mjs")], {
  stdio: "inherit",
});
check(sidecarCheck.status === 0, "sidecar hash verification failed");

for (const path of [
  join(root, "LICENSES", "THIRD_PARTY.md"),
  join(root, "LICENSES", "GPL-3.0.txt"),
]) {
  check(existsSync(path), `missing license notice: ${path}`);
}

const thumbprint = process.env.WINDOWS_CERTIFICATE_THUMBPRINT?.trim();
if (thumbprint) {
  const command = [
    `$items = @('${installer.replaceAll("'", "''")}', '${join(root, "src-tauri", "target", "release", "bilipocket.exe").replaceAll("'", "''")}')`,
    `foreach ($path in $items) {`,
    `  $signature = Get-AuthenticodeSignature -LiteralPath $path`,
    `  if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Thumbprint -ne '${thumbprint}') { Write-Error "missing expected signature on $path"; exit 1 }`,
    `}`,
  ].join("\n");
  const signatureCheck = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    stdio: "inherit",
  });
  check(signatureCheck.status === 0, "Authenticode signature verification failed");
} else {
  warnings.push("WINDOWS_CERTIFICATE_THUMBPRINT is not set; Authenticode signatures were not verified");
}

for (const warning of warnings) console.warn(`WARN ${warning}`);
if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log(`Release artifacts verified for v${version}.`);
console.log("Privacy check passed: no local account, machine, or project paths found.");
console.log(`Installer: ${installer}`);
console.log(`Portable:  ${portable}`);
