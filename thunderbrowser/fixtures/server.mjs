// Fixture HTTP server. Mounts ./aa/* and ./pbs/* as the AA/PBS portal
// fakes the extension will exercise. Listens on :7860 by default.

import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const port = parseInt(process.env.TB_FIXTURE_PORT || "7860", 10);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function staticFile(filepath, res) {
  if (!existsSync(filepath) || !statSync(filepath).isFile()) return false;
  const body = readFileSync(filepath);
  res.writeHead(200, { "content-type": MIME[extname(filepath)] || "application/octet-stream" });
  res.end(body);
  return true;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const path = url.pathname;
  console.log(`${new Date().toISOString()} ${req.method} ${path}`);

  if (path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<h1>ThunderBrowser fixture server</h1><ul><li><a href='/aa/dashboard'>AA dashboard</a></li><li><a href='/aa/login'>AA login</a></li><li><a href='/aa/travel-planner'>AA travel planner</a></li><li><a href='/aa/travel-planner/results'>AA results</a></li><li><a href='/aa/travel-planner/confirm'>AA confirm</a></li><li><a href='/aa/timeout'>AA timeout</a></li><li><a href='/aa/password-expired'>AA password expired</a></li><li><a href='/aa/captcha'>AA captcha</a></li></ul>");
    return;
  }

  // Map /aa/<state> to fixtures/aa/<state>.html.
  if (path.startsWith("/aa/")) {
    const slug = path.slice(4).replace(/\/+$/, "");
    const candidates = [
      join(ROOT, "aa", slug + ".html"),
      join(ROOT, "aa", slug, "index.html"),
      join(ROOT, "aa", slug.replace(/\//g, "_") + ".html"),
    ];
    for (const c of candidates) {
      if (staticFile(c, res)) return;
    }
  }
  if (path.startsWith("/pbs/")) {
    const slug = path.slice(5).replace(/\/+$/, "");
    if (staticFile(join(ROOT, "pbs", slug + ".html"), res)) return;
  }
  if (path.startsWith("/static/")) {
    if (staticFile(join(ROOT, path), res)) return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(port, () => console.log(`[fixtures] listening on http://localhost:${port}`));
