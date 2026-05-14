// ThunderBrowser background service worker.
// Owns the WSS connection to ThunderGate, the action dispatcher, and the audit
// flush loop. MV3 SWs die after ~30s idle, so all durable state lives in
// chrome.storage and IndexedDB, and the heartbeat is driven by chrome.alarms.

import { alarms, runtime, storage, tabs } from "../shared/platform.js";
import { envelope, validateEnvelope, SUBPROTOCOL } from "../shared/protocol.js";
import { WssClient } from "./wss-client.js";
import { Dispatcher } from "./dispatcher.js";
import { Audit } from "./audit.js";

const HEARTBEAT_ALARM = "tb_heartbeat";
const HEARTBEAT_PERIOD_MIN = 0.5; // 30s — alarms minimum on Safari, comfortable on Chrome.

// Single-instance globals. SW restarts re-run the module — these become fresh
// references and the wss client reconnects from persisted state.
const audit = new Audit();
const dispatcher = new Dispatcher({ audit });
const wss = new WssClient({
  endpointKey: "tb_wss_endpoint",
  audit,
  onCommand: (msg) => dispatcher.handleCommand(msg, wss),
});

runtime.onInstalled.addListener(async () => {
  console.log("[ThunderBrowser] installed", new Date().toISOString());
  await ensureAlarms();
  await audit.init();
  await wss.connect().catch((e) => console.warn("[ThunderBrowser] initial connect failed", e));
});

runtime.onStartup.addListener(async () => {
  await ensureAlarms();
  await audit.init();
  await wss.connect().catch((e) => console.warn("[ThunderBrowser] startup connect failed", e));
});

alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return;
  try {
    await wss.heartbeat();
    await audit.flush(wss);
  } catch (e) {
    console.warn("[ThunderBrowser] heartbeat failed", e);
  }
});

// Inbound messages from content scripts (events, action results).
runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender.tab) return false;
  const verr = validateEnvelope(msg);
  if (verr) {
    sendResponse({ type: "error", body: { code: "BAD_ENVELOPE", message: verr, retriable: false } });
    return true;
  }
  dispatcher.handleContentMessage(msg, sender.tab, wss).then((reply) => {
    if (reply) sendResponse(reply);
  });
  return true; // keep channel open for async response
});

// Popup / options messaging.
runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.tab) return false; // already handled
  if (msg?.kind === "status") {
    sendResponse({
      kind: "status",
      connected: wss.isOpen(),
      endpoint: wss.endpoint,
      paused: wss.paused,
      queueDepth: wss.queueDepth(),
      auditPending: audit.pendingCount(),
    });
    return true;
  }
  if (msg?.kind === "set_endpoint") {
    wss.setEndpoint(msg.endpoint).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.kind === "pause") {
    wss.setPaused(true).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.kind === "resume") {
    wss.setPaused(false).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.kind === "reconnect") {
    wss.reconnect().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

async function ensureAlarms() {
  const existing = await alarms.get(HEARTBEAT_ALARM);
  if (!existing) {
    await alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_PERIOD_MIN });
  }
}

// Tab navigation surfaces — emit upstream so Jon's loop can observe redirects
// it didn't initiate (interstitials, password expiry, session timeouts).
if (typeof chrome !== "undefined" && chrome.webNavigation) {
  chrome.webNavigation.onCommitted.addListener(async (details) => {
    if (details.frameId !== 0) return;
    await wss.sendEvent("tab_navigated", { tab_id: details.tabId, url: details.url, transition: details.transitionType });
  });
}

// Boot path also runs on bare module load (cold start by event).
(async () => {
  await ensureAlarms();
  await audit.init();
  if (!wss.isOpen()) {
    await wss.connect().catch((e) => console.warn("[ThunderBrowser] cold connect failed", e));
  }
})();
