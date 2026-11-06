import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

import { fragments } from "../dev/demo-dom.js";

const root = resolve(process.cwd(), "src");
const devRoot = resolve(process.cwd(), "dev");
const port = Number(process.env.PORT || 1420);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const inside = (base, target) => target === base || target.startsWith(base + sep);

async function devShell() {
  const shell = await readFile(resolve(root, "index.html"), "utf8");
  const injected = Object.entries(fragments).reduce(
    (html, [name, fragment]) => html.replace(`<!-- ${name} -->`, fragment),
    shell,
  );
  return injected
    .replace("<head>", '<head>\n    <base href="/" />')
    .replace(
      '<script type="module" src="./js/app.js"></script>',
      '<script type="module" src="/dev/boot.js"></script>',
    );
}

const server = createServer(async (req, res) => {
  try {
    const requestPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);

    if (requestPath === "/dev" || requestPath === "/dev/") {
      res.writeHead(200, {
        "Content-Type": mime[".html"],
        "Cache-Control": "no-store",
      });
      res.end(await devShell());
      return;
    }

    const isDevAsset = requestPath.startsWith("/dev/");
    const base = isDevAsset ? devRoot : root;
    const relative = isDevAsset
      ? requestPath.replace(/^\/dev\/+/, "")
      : requestPath === "/"
        ? "index.html"
        : requestPath.replace(/^\/+/, "");
    const filePath = resolve(base, relative);

    if (!inside(base, filePath)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mime[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`\n  Port ${port} is already in use. Stop the other preview server and try again.\n`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`\n  BiliPocket desktop shell  →  http://localhost:${port}`);
  console.log(`  BiliPocket demo (mock)    →  http://localhost:${port}/dev/\n`);
});
