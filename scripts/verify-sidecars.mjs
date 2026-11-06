import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const manifestPath = join(root, "src-tauri", "binaries", "ENGINE_MANIFEST.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
let failed = false;

for (const engine of manifest.engines || []) {
  const filePath = join(root, "src-tauri", "binaries", engine.file);
  try {
    const data = await readFile(filePath);
    const hash = createHash("sha256").update(data).digest("hex");
    const ok = hash === engine.sha256;
    console.log(`${ok ? "OK" : "MISMATCH"} ${engine.name} ${engine.version} (${engine.file})`);
    if (!ok) {
      console.error(`  expected ${engine.sha256}`);
      console.error(`  actual   ${hash}`);
      failed = true;
    }
  } catch (error) {
    console.error(`MISSING ${engine.file}: ${error.message}`);
    failed = true;
  }
}

if (failed) {
  console.error("Sidecar verification failed. Run the engine provisioning step before building.");
  process.exit(1);
}
