// CDP-driven browser capability test harness.
// Drives the currently running Chromium via DevTools on 127.0.0.1:9222.
// Records: final URL after navigate, document title, body text length,
// redirect chain (from Network.responseReceived), load duration, any
// page errors, and a snippet of body text.
//
// Bridge path (port 8770) is blocked by an unrelated process owning the
// port, so this exercises pure browser capability — not the BrowserBridge.

import { WebSocket } from 'ws';

const DEBUG_PORT = 9222;
const TARGETS = JSON.parse(process.argv[2] || '[]');
const NAV_TIMEOUT_MS = 20000;
const SETTLE_MS = 1500;

async function listTabs() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`);
  return await res.json();
}

function openCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const eventListeners = [];
    sock.on('open', () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            sock.send(JSON.stringify({ id, method, params }));
          });
        },
        on(handler) { eventListeners.push(handler); },
        close() { try { sock.close(); } catch {} },
      });
    });
    sock.on('error', reject);
    sock.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result);
        return;
      }
      if (msg.method) eventListeners.forEach((h) => h(msg));
    });
  });
}

async function navigateAndProbe(url) {
  const tabs = await listTabs();
  const page = tabs.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no_page_tab');
  const cdp = await openCdp(page.webSocketDebuggerUrl);

  const redirects = [];
  const consoleErrors = [];
  const pageErrors = [];
  let mainFrameId = null;
  let finalStatus = null;

  cdp.on((msg) => {
    if (msg.method === 'Network.responseReceived') {
      const p = msg.params;
      if (p.type === 'Document' && p.frameId && mainFrameId === null) {
        mainFrameId = p.frameId;
      }
      if (p.frameId === mainFrameId && p.type === 'Document') {
        finalStatus = p.response.status;
        redirects.push({ url: p.response.url, status: p.response.status });
      }
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push((msg.params.args || []).map((a) => a.value || a.description).join(' '));
    }
  });

  await cdp.send('Network.enable');
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const t0 = Date.now();
  let navResult = null;
  let navError = null;
  try {
    navResult = await Promise.race([
      cdp.send('Page.navigate', { url }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('navigate_timeout')), NAV_TIMEOUT_MS)),
    ]);
  } catch (e) {
    navError = e.message;
  }

  // Wait for load event or timeout
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const t = setTimeout(finish, NAV_TIMEOUT_MS);
    cdp.on((msg) => {
      if (msg.method === 'Page.loadEventFired') {
        clearTimeout(t);
        setTimeout(finish, SETTLE_MS);
      }
    });
  });

  let title = null, bodyTextLen = 0, snippet = null, finalUrl = null;
  try {
    const titleRes = await cdp.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    title = titleRes.result?.value;
    const urlRes = await cdp.send('Runtime.evaluate', {
      expression: 'window.location.href',
      returnByValue: true,
    });
    finalUrl = urlRes.result?.value;
    const bodyRes = await cdp.send('Runtime.evaluate', {
      expression: '(document.body && document.body.innerText) ? document.body.innerText : ""',
      returnByValue: true,
    });
    const txt = bodyRes.result?.value || '';
    bodyTextLen = txt.length;
    snippet = txt.slice(0, 240).replace(/\s+/g, ' ').trim();
  } catch (e) {
    pageErrors.push(`probe_failed:${e.message}`);
  }

  const durationMs = Date.now() - t0;
  cdp.close();
  return {
    requestedUrl: url,
    finalUrl,
    title,
    bodyTextLen,
    snippet,
    redirects,
    finalHttpStatus: finalStatus,
    durationMs,
    navError,
    pageErrors: pageErrors.slice(0, 5),
    consoleErrors: consoleErrors.slice(0, 5),
  };
}

(async () => {
  const results = [];
  for (const t of TARGETS) {
    try {
      const r = await navigateAndProbe(t.url);
      results.push({ name: t.name, ...r });
    } catch (e) {
      results.push({ name: t.name, requestedUrl: t.url, fatal: e.message });
    }
  }
  console.log(JSON.stringify(results, null, 2));
})();
