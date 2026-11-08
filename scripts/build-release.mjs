import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyPrivateBuildEnv, scanPaths } from "./privacy.mjs";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const releaseConfig = JSON.parse(
  await readFile(join(root, "src-tauri", "tauri.release.conf.json"), "utf8"),
);
const thumbprint = process.env.WINDOWS_CERTIFICATE_THUMBPRINT?.trim();
const updaterKey = process.env.TAURI_SIGNING_PRIVATE_KEY?.trim() || null;
const config = structuredClone(releaseConfig);

if (!updaterKey) {
  config.bundle = { ...(config.bundle || {}), createUpdaterArtifacts: false };
  console.log(
    "[release] TAURI_SIGNING_PRIVATE_KEY is not set; building an unsigned release without updater artifacts.",
  );
}

if (thumbprint) {
  const signScript = join(root, "scripts", "sign-windows.ps1");
  config.bundle = {
    ...(config.bundle || {}),
    windows: {
      ...(config.bundle?.windows || {}),
      signCommand: `powershell -NoProfile -ExecutionPolicy Bypass -File ${signScript} %1`,
    },
  };
  console.log("Windows Authenticode signing enabled for this build; pinned sidecars will be skipped.");
} else {
  console.log("WINDOWS_CERTIFICATE_THUMBPRINT is not set; building without Authenticode signing.");
}

const configPath = join(root, "src-tauri", "tauri.build.conf.json");
await mkdir(join(root, "src-tauri"), { recursive: true });
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

const args = ["tauri", "build", "--config", "src-tauri/tauri.build.conf.json"];
if (thumbprint) {
  // Tauri rewrites the executable after signing; skip that patch so the final exe keeps its signature.
  // BiliPocket ships NSIS only, so per-bundle-type updater tagging is not required.
  args.push("--no-binary-patching");
}
const buildEnv = applyPrivateBuildEnv(process.env, root);
console.log("[release] local account and project paths are remapped in compiled artifacts");
const result =
  process.platform === "win32"
    ? spawnSync("cmd.exe", ["/C", "npx", ...args], { cwd: root, stdio: "inherit", env: buildEnv })
    : spawnSync("npx", args, { cwd: root, stdio: "inherit", env: buildEnv });

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

function run(command, args, options = {}) {
  const child = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(`${command} exited with status ${child.status}`);
  }
}

function signFile(file) {
  console.log(`[release] Authenticode signing ${file}`);
  run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(root, "scripts", "sign-windows.ps1"),
    file,
  ]);
}

function findMakensis() {
  const candidates = [
    process.env.MAKENSIS_PATH,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "tauri", "NSIS", "Bin", "makensis.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "tauri", "NSIS", "makensis.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "NSIS", "Bin", "makensis.exe"),
    process.env.ProgramFiles && join(process.env.ProgramFiles, "NSIS", "makensis.exe"),
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "NSIS", "makensis.exe"),
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) || null;
}

const installerPath = join(
  root,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
  `BiliPocket_${packageJson.version}_x64-setup.exe`,
);
const appPath = join(root, "src-tauri", "target", "release", "bilipocket.exe");
const privacyFindings = scanPaths([appPath, installerPath], { env: process.env, root });
if (privacyFindings.length) {
  await rm(configPath, { force: true });
  for (const finding of privacyFindings) {
    console.error(`FAIL ${finding.file}: ${finding.label}`);
  }
  console.error("Release build contains local build environment data; refusing to sign or publish it.");
  process.exit(1);
}

async function patchNsisUninstallerDefault(scriptPath) {
  let source = await readFile(scriptPath, "utf8");
  if (!source.includes("Pop $DeleteAppDataCheckbox")) {
    console.warn("[release] could not find the app-data checkbox in installer.nsi");
    return;
  }
  if (source.includes("SendMessage $DeleteAppDataCheckbox 0x00F1")) return;
  source = source.replace(
    "Pop $DeleteAppDataCheckbox",
    "Pop $DeleteAppDataCheckbox\n  SendMessage $DeleteAppDataCheckbox 0x00F1 1 0",
  );
  await writeFile(scriptPath, source, "utf8");
  console.log("[release] uninstaller app-data checkbox defaults to on");
}

{
  const nsisDir = join(root, "src-tauri", "target", "release", "nsis", "x64");
  const nsisScript = join(nsisDir, "installer.nsi");
  const manualInstaller = join(nsisDir, "nsis-output.exe");
  const makensis = findMakensis();
  if (makensis) {
    for (const path of [appPath, nsisScript]) {
      await stat(path);
    }
    await patchNsisUninstallerDefault(nsisScript);

    // Tauri rewrites the executable during bundling. Sign after the build, then
    // rebuild NSIS so the final installer embeds the exact executable bytes.
    if (thumbprint) signFile(appPath);
    await rm(manualInstaller, { force: true });
    console.log("[release] rebuilding NSIS installer with uninstall cleanup");
    run(makensis, [nsisScript], { cwd: nsisDir });
    await stat(manualInstaller);
    await copyFile(manualInstaller, installerPath);
    if (thumbprint) signFile(installerPath);
    console.log(`[release] installer ready: ${installerPath}`);
  } else if (thumbprint) {
    throw new Error("makensis.exe was not found; set MAKENSIS_PATH.");
  } else {
    console.warn("[release] makensis.exe was not found; using the Tauri-generated installer.");
  }
}

await stat(installerPath);
const signaturePath = `${installerPath}.sig`;
await rm(signaturePath, { force: true });
if (updaterKey) {
  console.log("[release] signing updater manifest with app version");
  const keyPath =
    process.env.TAURI_SIGNING_PRIVATE_KEY_PATH ||
    (existsSync(updaterKey) ? updaterKey : null);
  const signerEnv = { ...process.env };
  if (keyPath) {
    signerEnv.TAURI_SIGNING_PRIVATE_KEY_PATH = keyPath;
    delete signerEnv.TAURI_SIGNING_PRIVATE_KEY;
  }
  run(process.execPath, [
    join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"),
    "signer",
    "sign",
    "--app-version",
    packageJson.version,
    installerPath,
  ], { env: signerEnv });
  await stat(signaturePath);
} else {
  console.log("[release] no signing key; skipped updater signature so the installer ships unsigned");
}
await rm(join(root, "src-tauri", "tauri.build.conf.json"), { force: true });
