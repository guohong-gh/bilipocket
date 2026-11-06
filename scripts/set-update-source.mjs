import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const raw = process.argv[2]?.trim();
if (!raw) {
  console.error("用法：npm run set:update-source -- https://example.com/latest.json");
  process.exit(1);
}
let url;
try {
  url = new URL(raw);
} catch {
  console.error("更新源不是有效 URL。");
  process.exit(1);
}
if (url.protocol !== "https:") {
  console.error("正式更新源必须使用 HTTPS。开发测试可改用 BILIPOCKET_UPDATE_ENDPOINT 环境变量。");
  process.exit(1);
}
await writeFile(join(process.cwd(), "src-tauri", "update-source.txt"), `${url.toString()}\n`, "utf8");
console.log(`已写入 src-tauri/update-source.txt：${url.toString()}`);
