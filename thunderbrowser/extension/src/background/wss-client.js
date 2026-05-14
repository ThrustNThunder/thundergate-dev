// WebSocket client for the background SW. Reconnects with exponential backoff,
// replays queued commands on resume, and exposes a simple send/heartbeat API.

import { storage } from "../shared/platform.js";
import { envelope, validateEnvelope, SUBPROTOCOL, uuid } from "../shared/protocol.js";

const DEFAULT_ENDPOINT = "ws://localhost:7861/browser";
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 30_000;

export class WssClient {
  constructor({ endpointKey, onCommand, audit }) {
    this.endpointKey = endpointKey;
    this.onCommand = onCommand;
    this.audit = audit;
    this.ws = null;
    this.endpoint = DEFAULT_ENDPOINT;
    this.paused = false;
    this.reconnectAttempts = 0;
    this.lastCommandIdAcked = null;
    this.pendingOutbox = []; // events that fired while disconnected
    this.connecting = null;
  }

  isOpen() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  queueDepth() {
    return this.pendingOutbox.length;
  }

  async loadState() {
    const { tb_endpoint, tb_paused, tb_last_acked } = await storage.local.get([
      "tb_endpoint",
      "tb_paused",
      "tb_last_acked",
    ]);
    if (tb_endpoint) this.endpoint = tb_endpoint;
    this.paused = !!tb_paused;
    this.lastCommandIdAcked = tb_last_acked ?? null;
  }

  async setEndpoint(endpoint) {
    this.endpoint = endpoint;
    await storage.local.set({ tb_endpoint: endpoint });
    if (this.ws) {
      try { this.ws.close(1000, "endpoint changed"); } catch {}
    }
    await this.connect();
  }

  async setPaused(p) {
    this.paused = !!p;
    await storage.local.set({ tb_paused: this.paused });
  }

  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      await this.loadState();
      if (this.isOpen()) return;
      try {
        const ws = new WebSocket(this.endpoint, SUBPROTOCOL);
        this.ws = ws;
        await new Promise((resolve, reject) => {
          ws.onopen = () => resolve();
          ws.onerror = (e) => reject(e);
          setTimeout(() => reject(new Error("ws_open_timeout")), 5000);
        });
        this.reconnectAttempts = 0;
        ws.onmessage = (ev) => this._onMessage(ev);
        ws.onclose = () => this._scheduleReconnect();
        ws.onerror = () => { /* logged via close */ };
        await this._sendReady();
        await this._flushOutbox();
      } catch (e) {
        this._scheduleReconnect();
        throw e;
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  async reconnect() {
    if (this.ws) {
      try { this.ws.close(1000, "manual reconnect"); } catch {}
    }
    this.ws = null;
    return this.connect();
  }

  _scheduleReconnect() {
    const attempt = this.reconnectAttempts++;
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * Math.pow(2, attempt));
    const delay = Math.floor(base * (0.5 + Math.random() * 0.5));
    setTimeout(() => {
      this.connect().catch(() => {});
    }, delay);
  }

  async _sendReady() {
    const ready = envelope({
      type: "event",
      body: {
        kind: "ready",
        ua: typeof navigator !== "undefined" ? navigator.userAgent : "sw",
        last_command_id_acked: this.lastCommandIdAcked,
        bundle: "thunderbrowser-dev/0.1.0",
        protocol: SUBPROTOCOL,
      },
    });
    this.ws.send(JSON.stringify(ready));
  }

  async _flushOutbox() {
    while (this.pendingOutbox.length && this.isOpen()) {
      const msg = this.pendingOutbox.shift();
      this.ws.send(JSON.stringify(msg));
    }
  }

  async _onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch {
      this._sendError(null, "BAD_JSON", "non-JSON payload");
      return;
    }
    const err = validateEnvelope(msg);
    if (err) {
      this._sendError(msg?.id ?? null, "BAD_ENVELOPE", err);
      return;
    }
    if (msg.type === "command") {
      if (this.paused) {
        this._sendError(msg.id, "PAUSED", "extension paused", false);
        return;
      }
      // Ack immediately, dispatch async.
      this.send(envelope({ type: "ack", ref: msg.id, body: { received_at: Date.now() } }));
      try {
        const result = await this.onCommand(msg);
        if (result) {
          this.send(envelope({ type: "result", ref: msg.id, body: result }));
        }
        this.lastCommandIdAcked = msg.id;
        await storage.local.set({ tb_last_acked: msg.id });
      } catch (e) {
        this._sendError(msg.id, e.code ?? "ACTION_ERROR", e.message ?? String(e), e.retriable !== false);
      }
    } else if (msg.type === "event") {
      // Server-side events (hello, scope updates, revoke).
      // Phase 1: just log; Phase 2 will wire scope handling.
      console.log("[ThunderBrowser] server event", msg.body?.kind ?? msg.body);
    }
  }

  send(msg) {
    if (this.isOpen()) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.pendingOutbox.push(msg);
      this.connect().catch(() => {});
    }
  }

  async sendEvent(kind, body) {
    this.send(envelope({ type: "event", body: { kind, ...body } }));
  }

  _sendError(ref, code, message, retriable = false) {
    this.send(envelope({ type: "error", ref, body: { code, message, retriable } }));
  }

  async heartbeat() {
    if (!this.isOpen()) {
      await this.connect().catch(() => {});
      return;
    }
    this.send(envelope({ type: "event", body: { kind: "ping", ts: Date.now() } }));
  }
}
