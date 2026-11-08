import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = process.cwd();
const binariesDir = join(root, "src-tauri", "binaries");
const manifestPath = join(binariesDir, "ENGINE_MANIFEST.json");
const defaultBaseUrl =
  "https://github.com/guohong-gh/bilipocket/releases/download/engines-2026.10";

const baseUrl = (process.env.BILIPOCKET_ENGINES_URL || defaultBaseUrl).replace(/\/+$/, "");

async function sha256(filePath) {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

try {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  let downloaded = 0;

  for (const engine of manifest.engines || []) {
    const target = join(binariesDir, engine.file);
    const existing = await sha256(target).catch(() => null);

    if (existing === engine.sha256) {
      console.log(`PRESENT ${engine.name} ${engine.version} (${engine.file})`);
      continue;
    }

    const url = `${baseUrl}/${engine.file}`;
    console.log(`FETCH   ${engine.name} ${engine.version}`);
    console.log(`        ${url}`);

    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`${engine.file}: download failed with HTTP ${response.status} from ${url}`);
    }

    await mkdir(binariesDir, { recursive: true });
    const tempPath = `${target}.download`;
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath));

    const actual = await sha256(tempPath);
    if (actual !== engine.sha256) {
      await rm(tempPath, { force: true });
      throw new Error(
        `${engine.file}: SHA-256 mismatch\n  expected ${engine.sha256}\n  actual   ${actual}`,
      );
    }

    await rename(tempPath, target);
    downloaded += 1;
    console.log(`OK      ${engine.file} (${(await stat(target)).size} bytes)`);
  }

  console.log(
    downloaded === 0
      ? "Engines already provisioned and hash-verified."
      : `Provisioned ${downloaded} engine file(s) and verified SHA-256.`,
  );
} catch (error) {
  console.error(`Engine provisioning failed: ${error.message}`);
  process.exit(1);
}
