// Local AA fixture portal (TB-0-11).
//
// Plain Node HTTP — no Express dependency to keep the scaffold lean. Express
// can be added later if we need middleware; for static + a couple of routes
// this is enough.
//
// Routes:
//   /                       login
//   /dashboard              AA dashboard with Travel nav
//   /travel-planner         Travel Planner empty state
//   /results                Search results (3 fake flight options)
//   /confirm                Confirm trip page (precision-click target)
//   /confirmed              Confirmed reservation page
//   /password-expired       Password expiry interstitial
//   /captcha                CAPTCHA blocked page
//   /timeout                Session timeout modal
//   /health                 200 ok JSON

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = path.join(__dirname, 'pages');
const PORT = Number(process.env.PORT || 7860);

const routes = {
  '/':                  'login.html',
  '/dashboard':         'dashboard.html',
  '/travel-planner':    'travel-planner.html',
  '/results':           'results.html',
  '/confirm':           'confirm.html',
  '/confirmed':         'confirmed.html',
  '/password-expired':  'password-expired.html',
  '/captcha':           'captcha.html',
  '/timeout':           'timeout.html',
};

function ts() { return new Date().toISOString(); }
function log(...args) { console.log(`[${ts()}]`, ...args); }

async function tryStatic(urlPath) {
  // Shared assets sit directly in pages/; URLs may come in as
  // /pages/_shared.css (when authored as if pages/ were a public dir) or
  // /_shared.css. Resolve both forms, defensively stripping any `..`.
  const safe = urlPath.replace(/\.\.+/g, '').replace(/^\/+pages\//, '/');
  const candidate = path.join(PAGES_DIR, safe);
  try {
    const s = await stat(candidate);
    if (s.isFile()) return candidate;
  } catch (_) { /* fallthrough */ }
  return null;
}

const server = createServer(async (req, res) => {
  log(req.method, req.url);
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    return;
  }
  const url = req.url.split('?')[0];
  const file = routes[url];
  if (file) {
    try {
      const body = await readFile(path.join(PAGES_DIR, file), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
      return;
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('fixture-site error: ' + (e && e.message ? e.message : String(e)));
      return;
    }
  }
  const staticPath = await tryStatic(url);
  if (staticPath) {
    const body = await readFile(staticPath);
    const ext = path.extname(staticPath).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found: ' + url);
});

server.listen(PORT, () => {
  console.log(`ThunderBrowser fixture site listening on http://localhost:${PORT}`);
});
