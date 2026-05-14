// Command dispatcher. Routes ThunderGate commands to the right surface:
// - Some commands resolve in the SW (navigate, get_tab, wait_for_load).
// - DOM-touching commands forward to the content script for the target tab.
//
// Phase 1 runs under a hardcoded dev scope (THUNDERBROWSER_PHASE01_TICKETS.md §2):
// localhost:7860 and *.aa.com are allowlisted. Any other origin returns
// NOT_ALLOWLISTED before the CS message is even sent.

import { tabs, scripting, webNavigation } from "../shared/platform.js";
import { envelope, uuid } from "../shared/protocol.js";

const ALLOWLIST = [
  /^https?:\/\/localhost:7860(\/|$)/,
  /^https?:\/\/([a-z0-9-]+\.)*aa\.com(\/|$)/i,
];

function originAllowed(url) {
  if (!url) return false;
  return ALLOWLIST.some((rx) => rx.test(url));
}

const CS_PING_TIMEOUT_MS = 500;
const CS_REINJECT_TIMEOUT_MS = 2000;

export class Dispatcher {
  constructor({ audit }) {
    this.audit = audit;
    this.contentReady = new Map(); // tabId -> lastPingMs
    this.lastStatusByTab = new Map(); // tabId -> { url, status_code }
  }

  async handleCommand(msg, wss) {
    const { action, ...params } = msg.body || {};
    if (!action) return { ok: false, error: "no action" };

    // Route by action category.
    const handler = HANDLERS[action];
    if (!handler) {
      const err = new Error(`unknown action: ${action}`);
      err.code = "UNKNOWN_ACTION";
      err.retriable = false;
      throw err;
    }
    return handler.call(this, params, msg, wss);
  }

  async handleContentMessage(msg, tab, wss) {
    // Content script emits events (state_detected, dom_mutation, error_detected).
    if (msg.type === "event") {
      const kind = msg.body?.kind;
      this.contentReady.set(tab.id, Date.now());
      if (kind === "state_detected" || kind === "dom_mutation" || kind === "error_detected" ||
          kind === "modal_appeared" || kind === "cs_ready") {
        await wss.sendEvent(kind, { ...msg.body, tab_id: tab.id });
      }
      return null;
    }
    return null;
  }

  // --- helpers ---

  async _ensureContentReady(tabId) {
    const lastSeen = this.contentReady.get(tabId);
    if (lastSeen && Date.now() - lastSeen < 30_000) return;
    try {
      await this._pingCs(tabId);
      this.contentReady.set(tabId, Date.now());
      return;
    } catch {
      // fall through to reinject
    }
    await scripting.executeScript({
      target: { tabId },
      files: ["src/content/content.js"],
      world: "ISOLATED",
    });
    await this._pingCs(tabId, CS_REINJECT_TIMEOUT_MS);
    this.contentReady.set(tabId, Date.now());
  }

  async _pingCs(tabId, timeout = CS_PING_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = uuid();
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error("cs_ping_timeout"));
      }, timeout);
      tabs.sendMessage(tabId, envelope({ type: "command", id, body: { action: "ping" } }), (resp) => {
        if (chrome.runtime.lastError) {
          // Ignore — likely no CS yet.
        }
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (resp && resp.ok) resolve();
        else reject(new Error(resp?.error || "no_response"));
      });
    });
  }

  async _sendToCs(tabId, body) {
    await this._ensureContentReady(tabId);
    return new Promise((resolve, reject) => {
      const id = uuid();
      tabs.sendMessage(tabId, envelope({ type: "command", id, body }), (resp) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message || "send_failed"));
        }
        if (!resp) return reject(new Error("no_response"));
        if (resp.type === "error") {
          const err = new Error(resp.body?.message || "cs_error");
          err.code = resp.body?.code;
          err.retriable = resp.body?.retriable !== false;
          return reject(err);
        }
        resolve(resp.body ?? {});
      });
    });
  }

  async _resolveTabUrl(tabId) {
    const t = await tabs.get(tabId);
    return t.url;
  }
}

// ---- handler table ----
// Each handler runs in the SW; DOM-touching ones forward to the CS.

const HANDLERS = {
  async ping() {
    return { ok: true, ts: Date.now() };
  },

  async navigate({ url, tab_id, new_tab, wait_for = "load", timeout_ms = 15_000 }) {
    if (!originAllowed(url)) {
      const e = new Error(`origin not allowlisted: ${new URL(url).host}`);
      e.code = "NOT_ALLOWLISTED";
      e.retriable = false;
      throw e;
    }
    let tab;
    if (new_tab || !tab_id) {
      tab = await tabs.create({ url, active: true });
    } else {
      tab = await tabs.update(tab_id, { url });
    }
    await this._waitForLoad(tab.id, wait_for, timeout_ms);
    const fresh = await tabs.get(tab.id);
    return { tab_id: tab.id, final_url: fresh.url, status_code: this.lastStatusByTab.get(tab.id)?.status_code ?? null };
  },

  async wait_for_load({ tab_id, condition = "load", timeout_ms = 15_000 }) {
    const t0 = Date.now();
    await this._waitForLoad(tab_id, condition, timeout_ms);
    return { load_ms: Date.now() - t0 };
  },

  async _waitForLoad(tabId, condition, timeout) {
    // SW-side: wait for chrome.tabs.onUpdated status===complete.
    if (condition === "load") {
      const tab = await tabs.get(tabId);
      if (tab.status === "complete") return;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          tabs.onUpdated.removeListener(listener);
          reject(Object.assign(new Error("wait_for_load timeout"), { code: "TIMEOUT", retriable: true }));
        }, timeout);
        const listener = (id, info) => {
          if (id === tabId && info.status === "complete") {
            clearTimeout(timer);
            tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        tabs.onUpdated.addListener(listener);
      });
    }
    // For domcontentloaded / network_idle: delegate to CS.
    if (!tabId) throw Object.assign(new Error("missing tab_id"), { code: "BAD_PARAMS", retriable: false });
    return this._sendToCs(tabId, { action: "_wait_for_load", condition, timeout_ms: timeout });
  },

  async get_url({ tab_id }) {
    const t = await tabs.get(tab_id);
    return { url: t.url, title: t.title };
  },

  async snapshot_dom({ tab_id, mode = "structured" }) {
    const url = await this._resolveTabUrl(tab_id);
    if (!originAllowed(url)) {
      const e = new Error("origin not allowlisted"); e.code = "NOT_ALLOWLISTED"; e.retriable = false; throw e;
    }
    return this._sendToCs(tab_id, { action: "snapshot_dom", mode });
  },

  async query({ tab_id, selector, text, role, name, limit }) {
    return this._sendToCs(tab_id, { action: "query", selector, text, role, name, limit });
  },

  async get_text({ tab_id, ref }) {
    return this._sendToCs(tab_id, { action: "get_text", ref });
  },

  async click({ tab_id, ref, expect_navigation, precision, timeout_ms }) {
    const r = await this._sendToCs(tab_id, { action: "click", ref, expect_navigation, precision, timeout_ms });
    return r;
  },

  async fill({ tab_id, ref, value }) {
    return this._sendToCs(tab_id, { action: "fill", ref, value });
  },

  async select({ tab_id, ref, value, label, index }) {
    return this._sendToCs(tab_id, { action: "select", ref, value, label, index });
  },

  async check({ tab_id, ref, checked }) {
    return this._sendToCs(tab_id, { action: "check", ref, checked });
  },

  async scroll_to({ tab_id, ref, x, y }) {
    return this._sendToCs(tab_id, { action: "scroll_to", ref, x, y });
  },

  async detect_modal({ tab_id }) {
    return this._sendToCs(tab_id, { action: "detect_modal" });
  },

  async detect_error({ tab_id }) {
    return this._sendToCs(tab_id, { action: "detect_error" });
  },

  async detect_loading({ tab_id }) {
    return this._sendToCs(tab_id, { action: "detect_loading" });
  },

  async is_logged_in({ tab_id, domain }) {
    return this._sendToCs(tab_id, { action: "is_logged_in", domain });
  },

  async detect_state({ tab_id }) {
    return this._sendToCs(tab_id, { action: "detect_state" });
  },
};
