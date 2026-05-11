// ThunderBrowser background service worker.
//
// Stitches:
//   TB-0-1 (SW boot + popup ping)
//   TB-0-3 (platform shim — no direct `chrome.*` calls)
//   TB-0-4 (alarm-driven heartbeat)
//   TB-0-5 (WSS client against the mock TG endpoint)
//   TB-0-6 (status replies carry runId/scopeLabel for the popup)
//   TB-0-8 (pairing state IPC — options page reads/writes via tb.pairing.*)
//
// All chrome.* surfaces are routed through `lib/platform.js` per TB-0-3.

import { runtime, alarms, tabs } from '../lib/platform.js';
import { get as dbGet, put as dbPut } from '../lib/storage.js';

console.log('ThunderBrowser SW started');

const SW_BOOT_TS = Date.now();

// ── Live run/scope state (TB-0-6) ──────────────────────────────────────────
// Tracked in-memory from inbound WSS events. Survives across reconnects but
// not across SW eviction; that's fine for the popup display — the next event
// from the mock TG / real bridge will refresh it.
let currentRunId = null;
let currentScopeLabel = null;

function setRun(runId, scopeLabel) {
  currentRunId = runId || null;
  currentScopeLabel = scopeLabel || null;
}

function clearRun() {
  currentRunId = null;
  currentScopeLabel = null;
}

// ── TB-0-4 — alarm-driven heartbeat ────────────────────────────────────────
//
// 0.4 minutes ≈ 25 seconds. `chrome.alarms` is the only timer that survives
// SW eviction; `setInterval`/`setTimeout > 30s` would die with the worker.
const HEARTBEAT_ALARM = 'tb.keepalive';
const HEARTBEAT_PERIOD_MIN = 0.4;

function ensureHeartbeatAlarm() {
  alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_PERIOD_MIN });
}

alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return;
  console.log('ThunderBrowser SW heartbeat', {
    ts: Date.now(),
    uptime_ms: Date.now() - SW_BOOT_TS,
  });
  if (wssClient.isConnected()) {
    console.log('WSS: connected');
  } else {
    console.log('WSS: not connected');
    wssClient.connect();
  }
});

export function getSwBootTs() {
  return SW_BOOT_TS;
}

// ── TB-0-5 — WSS client (mock endpoint) ────────────────────────────────────

const WSS_URL = 'ws://localhost:9876/browser';
const WSS_RECONNECT_MS = 5000;

const wssClient = (() => {
  let ws = null;
  let reconnectTimer = null;
  let connected = false;

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, WSS_RECONNECT_MS);
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    clearReconnectTimer();
    try {
      ws = new WebSocket(WSS_URL);
    } catch (e) {
      console.log('ThunderBrowser WSS construct error', e && e.message ? e.message : String(e));
      scheduleReconnect();
      return;
    }
    ws.addEventListener('open', () => {
      connected = true;
      console.log('ThunderBrowser WSS connected');
      try {
        ws.send(JSON.stringify({
          v: 1,
          id: 'ready-' + Date.now(),
          ts: Date.now(),
          type: 'ready',
          body: { ua: 'thunderbrowser-dev', bundle_hash: 'dev0' },
        }));
      } catch (_) { /* harmless if send fails before open settled */ }
    });
    ws.addEventListener('close', (ev) => {
      connected = false;
      clearRun();
      console.log('ThunderBrowser WSS disconnected', {
        code: ev.code,
        reason: ev.reason || null,
      });
      scheduleReconnect();
    });
    ws.addEventListener('error', (ev) => {
      console.log('ThunderBrowser WSS error', {
        readyState: ws ? ws.readyState : null,
        type: ev && ev.type ? ev.type : 'error',
      });
    });
    ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : '[binary]';
      console.log('ThunderBrowser WSS message: ' + raw);
      handleInbound(raw);
    });
  }

  function isConnected() {
    return connected && ws !== null && ws.readyState === WebSocket.OPEN;
  }

  function send(obj) {
    if (!isConnected()) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (_) {
      return false;
    }
  }

  return { connect, isConnected, send };
})();

function handleInbound(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }
  if (!msg || typeof msg !== 'object') return;

  // Pairing confirmation from the mock TG (TB-0-8).
  maybeAcceptPairedEvent(msg);

  // Surface run/scope context to the popup (TB-0-6).
  if (msg.type === 'hello') return;
  if (msg.type === 'scope') {
    setRun(msg.body && msg.body.runId, msg.body && msg.body.label);
    return;
  }
  if (msg.type === 'command') {
    if (msg.body && msg.body.runId) {
      setRun(msg.body.runId, msg.body.label || currentScopeLabel);
    }
    // Ack first so the bridge can decrement its in-flight counter even if
    // the actual execution takes seconds (a slow navigation can sit here
    // for a full page-load timeout).
    wssClient.send({
      v: 1,
      id: 'ack-' + msg.id,
      ts: Date.now(),
      type: 'ack',
      ref: msg.id,
      body: { ok: true },
    });
    void executeCommand(msg);
    return;
  }
  if (msg.type === 'run_end') {
    clearRun();
    return;
  }
}

wssClient.connect();

// ── TB-1-2 — action dispatcher (SW-side actions + content-script relay) ──
//
// The bridge sends `{type: 'command', body: {runId, action, args}}`. The SW
// either handles the action locally (`navigate`, `wait_for_load`) or
// forwards it to the target tab's content script via `tabs.sendMessage`
// (`read.*`, `click`, `fill`, `scroll_to`, `press_key`).
//
// Every result is returned to the bridge as a `cmd_result` envelope so the
// agent on the ThunderGate side can resolve the awaiting promise. Errors
// are encoded as `{ok: false, error, detail}` rather than thrown — the
// bridge layer's audit pipeline treats both shapes uniformly.

const SW_ACTIONS = new Set(['navigate', 'wait_for_load']);
const CS_ACTIONS = new Set([
  'read.query', 'read.text', 'read.url',
  'snapshot',
  'click', 'fill', 'scroll_to', 'press_key',
]);

async function executeCommand(msg) {
  const body = msg.body || {};
  const action = typeof body.action === 'string' ? body.action : null;
  const args = (body.args && typeof body.args === 'object') ? body.args : {};

  let result;
  try {
    if (!action) {
      result = { ok: false, error: 'missing_action' };
    } else if (SW_ACTIONS.has(action)) {
      result = await dispatchSwAction(action, args);
    } else if (CS_ACTIONS.has(action)) {
      result = await dispatchContentScriptAction(action, args, msg);
    } else {
      result = { ok: false, error: 'unknown_action', action };
    }
  } catch (e) {
    result = { ok: false, error: 'handler_threw', detail: e && e.message ? e.message : String(e) };
  }

  wssClient.send({
    v: 1,
    id: 'res-' + msg.id,
    ts: Date.now(),
    type: 'cmd_result',
    ref: msg.id,
    body: { action, runId: body.runId || null, ...result },
  });
}

async function dispatchSwAction(action, args) {
  if (action === 'navigate') return actNavigate(args);
  if (action === 'wait_for_load') return actWaitForLoad(args);
  return { ok: false, error: 'unknown_sw_action', action };
}

async function dispatchContentScriptAction(action, args, msg) {
  const tabId = await resolveTargetTabId(args);
  if (tabId == null) {
    return { ok: false, error: 'no_active_tab' };
  }
  try {
    const env = {
      v: 1,
      id: 'req-' + msg.id,
      ts: Date.now(),
      type: 'cmd_request',
      ref: msg.id,
      body: { action, args },
    };
    const result = await sendMessageToTab(tabId, env);
    if (!result) return { ok: false, error: 'tab_no_reply', tabId };
    if (result.type === 'cmd_result') {
      return { ok: true, tabId, ...(result.body || {}) };
    }
    if (result.type === 'error') {
      return {
        ok: false,
        tabId,
        error: (result.body && result.body.code) || 'cs_error',
        detail: result.body && result.body.detail,
      };
    }
    return { ok: false, tabId, error: 'unexpected_cs_reply', detail: result.type };
  } catch (e) {
    return { ok: false, error: 'cs_send_failed', detail: e && e.message ? e.message : String(e) };
  }
}

// ── TB-1-2 — navigate + wait_for_load ────────────────────────────────────
//
// Phase 1 dev posture: the manifest declares `<all_urls>` (per ACTIVE_TASKS
// — TB-1-13 replaces this with the manifest-immutable allowlist before any
// production cut). Until then the in-SW allowlist is a soft check that
// only blocks file:// and chrome:// schemes, which agents have no business
// driving in any deployment.

const DENY_SCHEMES = ['file:', 'chrome:', 'chrome-extension:', 'devtools:', 'view-source:'];

function isAllowedUrl(url) {
  let u;
  try { u = new URL(url); } catch (_) { return { ok: false, reason: 'malformed_url' }; }
  if (DENY_SCHEMES.includes(u.protocol)) {
    return { ok: false, reason: 'scheme_denied', scheme: u.protocol };
  }
  if (!/^https?:$/.test(u.protocol)) {
    return { ok: false, reason: 'scheme_unsupported', scheme: u.protocol };
  }
  return { ok: true };
}

async function actNavigate(args) {
  const url = typeof args.url === 'string' ? args.url : null;
  if (!url) return { ok: false, error: 'url_required' };

  const allow = isAllowedUrl(url);
  if (!allow.ok) return { ok: false, error: 'url_denied', detail: allow };

  const newTab = args.newTab === true;
  const timeoutMs = clampTimeout(args.timeoutMs, 30000);
  const t0 = Date.now();

  let tab;
  try {
    if (newTab) {
      tab = await tabs.create({ url, active: args.background !== true });
    } else {
      const active = await getActiveTab();
      if (!active) {
        tab = await tabs.create({ url, active: true });
      } else {
        tab = await tabs.update(active.id, { url });
      }
    }
  } catch (e) {
    return { ok: false, error: 'navigate_failed', detail: e && e.message ? e.message : String(e) };
  }

  const tabId = tab && tab.id;
  if (tabId == null) return { ok: false, error: 'tab_id_missing' };

  const loaded = await waitForTabComplete(tabId, timeoutMs);
  const elapsed = Date.now() - t0;
  if (!loaded.ok) {
    return { ok: false, error: loaded.error, detail: loaded.detail, tabId, loadDurationMs: elapsed };
  }
  return {
    ok: true,
    tabId,
    finalUrl: loaded.url,
    loadDurationMs: elapsed,
  };
}

async function actWaitForLoad(args) {
  const timeoutMs = clampTimeout(args.timeoutMs, 30000);
  let tabId = typeof args.tabId === 'number' ? args.tabId : null;
  if (tabId == null) {
    const active = await getActiveTab();
    if (!active) return { ok: false, error: 'no_active_tab' };
    tabId = active.id;
  }
  const t0 = Date.now();
  const loaded = await waitForTabComplete(tabId, timeoutMs);
  const elapsed = Date.now() - t0;
  if (!loaded.ok) {
    return { ok: false, error: loaded.error, detail: loaded.detail, tabId, waitDurationMs: elapsed };
  }
  return { ok: true, tabId, finalUrl: loaded.url, waitDurationMs: elapsed };
}

function clampTimeout(v, fallback) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return fallback;
  // Cap at 2 minutes — anything longer is almost always a hung site we
  // want to surface as a timeout rather than waiting for indefinitely.
  return Math.min(Math.floor(v), 120000);
}

async function getActiveTab() {
  try {
    const list = await tabs.query({ active: true, currentWindow: true });
    return Array.isArray(list) && list[0] ? list[0] : null;
  } catch (_) {
    return null;
  }
}

async function resolveTargetTabId(args) {
  if (typeof args.tabId === 'number') return args.tabId;
  const active = await getActiveTab();
  return active ? active.id : null;
}

/**
 * Resolves when the tab reaches `complete` or the timeout fires.
 * Listens to `tabs.onUpdated` rather than waiting on a single event so
 * client-side redirects don't drop us before the actual landing page.
 */
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;

    const finish = (value) => {
      if (done) return;
      done = true;
      try { tabs.onUpdated.removeListener(listener); } catch (_) { /* ignore */ }
      try { tabs.onRemoved.removeListener(removedListener); } catch (_) { /* ignore */ }
      clearTimeout(timer);
      resolve(value);
    };

    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        finish({ ok: true, url: tab && tab.url ? tab.url : null });
      }
    };

    const removedListener = (removedTabId) => {
      if (removedTabId === tabId) finish({ ok: false, error: 'tab_closed' });
    };

    tabs.onUpdated.addListener(listener);
    tabs.onRemoved.addListener(removedListener);

    const timer = setTimeout(() => {
      // Re-check current state — the `complete` event may have fired
      // before we attached the listener (race on a same-host nav).
      tabs.get(tabId).then((tab) => {
        if (tab && tab.status === 'complete') {
          finish({ ok: true, url: tab.url || null });
        } else {
          finish({ ok: false, error: 'load_timeout', detail: { status: tab && tab.status } });
        }
      }).catch((e) => {
        finish({ ok: false, error: 'tab_gone', detail: e && e.message ? e.message : String(e) });
      });
    }, timeoutMs);
  });
}

function sendMessageToTab(tabId, env) {
  // platform.tabs.sendMessage returns a promise via the polyfill in Chrome
  // and natively in Safari. Wrap in our own try/catch so a closed port
  // surfaces as a typed error rather than an unhandled rejection.
  return new Promise((resolve, reject) => {
    try {
      const ret = tabs.sendMessage(tabId, env);
      if (ret && typeof ret.then === 'function') {
        ret.then(resolve).catch(reject);
      } else {
        resolve(ret);
      }
    } catch (e) {
      reject(e);
    }
  });
}

// ── SW lifecycle + popup/options IPC ───────────────────────────────────────

runtime.onInstalled.addListener((details) => {
  console.log('ThunderBrowser SW installed', { reason: details.reason, ts: SW_BOOT_TS });
  ensureHeartbeatAlarm();
});

runtime.onStartup.addListener(() => {
  console.log('ThunderBrowser SW onStartup');
  ensureHeartbeatAlarm();
  wssClient.connect();
});

ensureHeartbeatAlarm();

// ── TB-0-8 — pairing state in IndexedDB ────────────────────────────────────
//
// The options page posts a freshly-generated pairing code via tb.pairing.set,
// then polls tb.pairing.status until the SW sees a confirmation event from
// the mock TG (msg.type === 'paired'). In Phase 0 we accept the confirmation
// optimistically — TB-0-6 (real bridge) will add the device-key challenge.

async function getPairingRecord() {
  try {
    return await dbGet('pairing', 'current');
  } catch (_) {
    return undefined;
  }
}

async function setPairingPending({ pairingCode, extensionPairId, pubKeyFingerprint }) {
  const rec = {
    id: 'current',
    extensionPairId,
    pairingCode,
    pubKeyFingerprint,
    status: 'pending',
    started_at: Date.now(),
    paired_at: null,
    tg_kid_pubkeys: [],
    bundle_hash: 'dev0',
  };
  await dbPut('pairing', rec);
  return rec;
}

async function markPaired({ endpoint, tg_kid_pubkeys }) {
  const existing = (await getPairingRecord()) || { id: 'current' };
  const rec = {
    ...existing,
    id: 'current',
    status: 'paired',
    endpoint: endpoint || WSS_URL,
    tg_kid_pubkeys: Array.isArray(tg_kid_pubkeys) ? tg_kid_pubkeys : (existing.tg_kid_pubkeys || []),
    paired_at: Date.now(),
  };
  await dbPut('pairing', rec);
  return rec;
}

// Hook: the mock TG may emit a `paired` event after the options-page poll
// produces a pair-init handshake. Phase 0 accepts the first such event for
// the current pending pairing code.
function maybeAcceptPairedEvent(msg) {
  if (!msg || msg.type !== 'paired') return;
  void (async () => {
    const cur = await getPairingRecord();
    if (!cur || cur.status === 'paired') return;
    if (msg.body && msg.body.pairingCode && msg.body.pairingCode !== cur.pairingCode) return;
    await markPaired({
      endpoint: (msg.body && msg.body.endpoint) || WSS_URL,
      tg_kid_pubkeys: (msg.body && msg.body.tg_kid_pubkeys) || [],
    });
    console.log('ThunderBrowser paired via mock TG event');
  })();
}

runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'tb.ping') {
    sendResponse({
      type: 'tb.pong',
      sw_boot_ts: SW_BOOT_TS,
      now: Date.now(),
      connected: wssClient.isConnected(),
    });
    return false;
  }
  if (msg && msg.type === 'tb.status') {
    sendResponse({
      type: 'tb.status.reply',
      sw_boot_ts: SW_BOOT_TS,
      now: Date.now(),
      connected: wssClient.isConnected(),
      wss_url: WSS_URL,
      runId: currentRunId,
      scopeLabel: currentScopeLabel,
    });
    return false;
  }
  if (msg && msg.type === 'tb.pairing.set') {
    // Options page kicks off pairing — record the pending state.
    void (async () => {
      try {
        const rec = await setPairingPending({
          pairingCode: msg.pairingCode,
          extensionPairId: msg.extensionPairId,
          pubKeyFingerprint: msg.pubKeyFingerprint,
        });
        sendResponse({ type: 'tb.pairing.set.reply', ok: true, record: rec });
      } catch (e) {
        sendResponse({
          type: 'tb.pairing.set.reply',
          ok: false,
          error: e && e.message ? e.message : String(e),
        });
      }
    })();
    return true; // async response
  }
  if (msg && msg.type === 'tb.pairing.status') {
    void (async () => {
      const rec = await getPairingRecord();
      sendResponse({ type: 'tb.pairing.status.reply', record: rec || null });
    })();
    return true;
  }
  if (msg && msg.type === 'tb.pairing.simulate_confirm') {
    // Dev-only path: lets the options page simulate the confirmation step when
    // the mock TG isn't running. Phase 1 removes this in favour of the real
    // pair-init HTTPS call.
    void (async () => {
      try {
        const rec = await markPaired({ endpoint: WSS_URL, tg_kid_pubkeys: [] });
        sendResponse({ type: 'tb.pairing.simulate_confirm.reply', ok: true, record: rec });
      } catch (e) {
        sendResponse({
          type: 'tb.pairing.simulate_confirm.reply',
          ok: false,
          error: e && e.message ? e.message : String(e),
        });
      }
    })();
    return true;
  }
  return false;
});
