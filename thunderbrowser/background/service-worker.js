// ThunderBrowser service worker — the arm's nervous system.
//
// Holds a single WebSocket back to the BrowserBridge on ws://localhost:8771.
// On open: send `browser_ready` with the active tab's URL + portal state.
// On message: dispatch `command` envelopes to the right tab (via
// chrome.tabs / chrome.scripting / a content-script bounce) and reply with
// a `command_result` carrying the same correlation_id.
//
// Reconnect policy: every 5s if not OPEN. Service worker may be torn down
// by Chrome between events — we keep the socket attached to a top-level
// var; on the next event-driven wake-up we re-evaluate state and rebuild
// it. Belt-and-suspenders: a chrome.alarms tick keeps the SW periodically
// alive so disconnections recover even if no other event fires.

const BRIDGE_URL = 'ws://localhost:8771';
const RECONNECT_INTERVAL_MS = 5000;
const KEEPALIVE_ALARM = 'thunderbrowser-keepalive';
const COMMAND_TIMEOUT_MS = 4500; // < bridge default 5s so we always answer

let socket = null;
let reconnectTimer = null;
let activeTabId = null;

function log(...args) {
  console.log('[thunderbrowser]', ...args);
}

function safeSend(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    log('send failed', err?.message);
    return false;
  }
}

async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs && tabs[0]) return tabs[0];
  } catch { /* fall through */ }
  try {
    const tabs = await chrome.tabs.query({ active: true });
    if (tabs && tabs[0]) return tabs[0];
  } catch { /* fall through */ }
  try {
    const tabs = await chrome.tabs.query({});
    return tabs && tabs[0] ? tabs[0] : null;
  } catch {
    return null;
  }
}

async function currentUrlAndState() {
  const tab = await getActiveTab();
  if (tab) activeTabId = tab.id ?? activeTabId;
  return {
    url: tab?.url ?? '',
    state: null
  };
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  log('connecting to', BRIDGE_URL);
  let ws;
  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch (err) {
    log('construct failed', err?.message);
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.addEventListener('open', async () => {
    log('connected');
    const { url, state } = await currentUrlAndState();
    safeSend({ type: 'browser_ready', url, state });
  });

  ws.addEventListener('message', async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type !== 'command') return;
    const correlationId = msg.correlation_id;
    const action = msg.action;
    const args = msg.args || {};
    if (typeof correlationId !== 'string' || typeof action !== 'string') return;

    const started = Date.now();
    try {
      const data = await runCommand(action, args);
      safeSend({
        type: 'command_result',
        correlation_id: correlationId,
        success: true,
        data,
        latencyMs: Date.now() - started
      });
    } catch (err) {
      safeSend({
        type: 'command_result',
        correlation_id: correlationId,
        success: false,
        error: err?.message || String(err),
        latencyMs: Date.now() - started
      });
    }
  });

  ws.addEventListener('close', (ev) => {
    log('closed', ev.code, ev.reason);
    if (socket === ws) socket = null;
    scheduleReconnect();
  });

  ws.addEventListener('error', (ev) => {
    log('error', ev?.message || 'ws error');
    // close handler will fire and trigger reconnect
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_INTERVAL_MS);
}

// ── command dispatch ─────────────────────────────────────────────────────

async function runCommand(action, args) {
  switch (action) {
    case 'get_state':
      return await cmdGetState();
    case 'navigate':
      return await cmdNavigate(args);
    case 'click':
      return await cmdClick(args);
    case 'fill':
      return await cmdFill(args);
    default:
      throw new Error(`unknown_action:${action}`);
  }
}

async function cmdGetState() {
  const tab = await getActiveTab();
  if (!tab || tab.id == null) {
    return { url: '', portalState: null, capturedAt: Date.now() };
  }
  activeTabId = tab.id;
  const inPage = await tabRpc(tab.id, { op: 'getState' });
  return {
    url: tab.url ?? '',
    portalState: inPage?.portalState ?? null,
    domSnapshot: inPage?.snapshot,
    capturedAt: Date.now()
  };
}

async function cmdNavigate(args) {
  const url = args?.url;
  if (typeof url !== 'string' || !url) throw new Error('navigate_missing_url');
  const tab = await getActiveTab();
  let tabId = tab?.id ?? activeTabId;
  if (tabId == null) {
    const created = await chrome.tabs.create({ url, active: true });
    activeTabId = created.id ?? null;
    return { url, tabId: created.id ?? null };
  }
  await chrome.tabs.update(tabId, { url, active: true });
  await waitForTabComplete(tabId, COMMAND_TIMEOUT_MS - 500);
  return { url, tabId };
}

async function cmdClick(args) {
  const selector = args?.selector;
  if (typeof selector !== 'string' || !selector) throw new Error('click_missing_selector');
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error('no_active_tab');
  const result = await tabRpc(tab.id, { op: 'click', selector });
  if (!result?.ok) throw new Error(result?.error || 'click_failed');
  return { selector };
}

async function cmdFill(args) {
  const selector = args?.selector;
  const value = args?.value;
  if (typeof selector !== 'string' || !selector) throw new Error('fill_missing_selector');
  if (typeof value !== 'string') throw new Error('fill_missing_value');
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error('no_active_tab');
  const result = await tabRpc(tab.id, { op: 'fill', selector, value });
  if (!result?.ok) throw new Error(result?.error || 'fill_failed');
  return { selector };
}

// ── tab RPC ──────────────────────────────────────────────────────────────
//
// Try a sendMessage to the content script first (cheap). If that fails
// because the page never had the content script injected (e.g. fresh tab,
// or chrome:// page where MV3 declared scripts don't run), fall back to
// chrome.scripting.executeScript with an inline function. This makes the
// extension forgiving across the variety of pages ThunderGate may drive.

async function tabRpc(tabId, payload) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, payload);
    if (reply !== undefined) return reply;
  } catch { /* fall through to executeScript */ }

  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: inlineDomOp,
      args: [payload]
    });
    return result;
  } catch (err) {
    return { ok: false, error: `tab_rpc_failed:${err?.message || err}` };
  }
}

function inlineDomOp(payload) {
  function selectOne(sel) {
    try { return document.querySelector(sel); } catch { return null; }
  }
  function snapshot() {
    return {
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      forms: Array.from(document.forms).map((f) => ({
        id: f.id || null,
        action: f.action || null,
        fields: Array.from(f.elements)
          .filter((el) => el.name)
          .map((el) => ({ name: el.name, type: el.type || el.tagName.toLowerCase() }))
      })),
      links: Array.from(document.links).slice(0, 20).map((a) => ({ href: a.href, text: (a.textContent || '').trim().slice(0, 80) }))
    };
  }
  switch (payload?.op) {
    case 'getState':
      return {
        ok: true,
        portalState: document.body?.dataset?.portalState ?? null,
        snapshot: snapshot()
      };
    case 'click': {
      const el = selectOne(payload.selector);
      if (!el) return { ok: false, error: 'element_not_found' };
      try { el.click(); } catch (e) { return { ok: false, error: e.message }; }
      return { ok: true };
    }
    case 'fill': {
      const el = selectOne(payload.selector);
      if (!el) return { ok: false, error: 'element_not_found' };
      try {
        if ('value' in el) {
          el.focus();
          el.value = payload.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.isContentEditable) {
          el.textContent = payload.value;
        } else {
          return { ok: false, error: 'element_not_fillable' };
        }
      } catch (e) {
        return { ok: false, error: e.message };
      }
      return { ok: true };
    }
    default:
      return { ok: false, error: 'unknown_op' };
  }
}

// ── tab lifecycle helpers ────────────────────────────────────────────────

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch { /* ignore */ }
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, Math.max(500, timeoutMs));
  });
}

// ── tab change → state_update ────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  activeTabId = tabId;
  try {
    const tab = await chrome.tabs.get(tabId);
    safeSend({ type: 'state_update', url: tab.url ?? '' });
  } catch { /* ignore */ }
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tabId !== activeTabId) return;
  if (typeof info.url === 'string') {
    safeSend({ type: 'state_update', url: info.url });
  } else if (info.status === 'complete' && tab?.url) {
    safeSend({ type: 'state_update', url: tab.url });
  }
});

// ── lifecycle wiring ─────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  log('installed');
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.25 });
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  log('startup');
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.25 });
  connect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) connect();
});

// First load of the SW (service workers run module top-level on wake).
try { chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.25 }); } catch { /* ignore */ }
connect();
