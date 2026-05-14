// ThunderGate Browser Bridge — production-shaped WSS server.
// Per design §1.1 / §2.2: terminates the thunderbrowser.v1 subprotocol, owns
// per-extension session state, enforces transport invariants, and exposes a
// small API for Jon's reasoning loop. This file is the source of truth for
// the bridge surface; the mock TG (../mock/tg-mock.mjs) shares the envelope
// helpers via ../extension/src/shared/protocol.js.
//
// Phase 1 ships the transport surface only:
//   - WSS endpoint /browser (subprotocol thunderbrowser.v1)
//   - Per-session command queue with ack/result tracking
//   - Audit ingest (logs to stdout; Phase 2 wires context.db)
//   - Heartbeat timeout (disconnect silent clients after 60s)
// JWT validation against a pinned device pubkey is stubbed (Phase 2 wires it).

import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

const PROTOCOL_VERSION = 1;
const SUBPROTOCOL = "thunderbrowser.v1";
const ACK_TIMEOUT_MS = 2_000;
const RESULT_TIMEOUT_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;

export class BrowserBridge {
  constructor({ port = 7862, logger = console } = {}) {
    this.port = port;
    this.logger = logger;
    this.sessions = new Map(); // ws -> SessionState
    this.wss = null;
  }

  start() {
    this.wss = new WebSocketServer({ port: this.port, handleProtocols: (protocols) => {
      if (protocols.has?.(SUBPROTOCOL) || protocols.includes?.(SUBPROTOCOL)) return SUBPROTOCOL;
      return false;
    }});
    this.wss.on("connection", (ws, req) => this._onConnection(ws, req));
    this.logger.log(`[bridge] listening on ws://localhost:${this.port}/browser`);
  }

  _onConnection(ws, req) {
    const session = {
      id: randomUUID(),
      ws,
      lastSeen: Date.now(),
      inflight: new Map(), // cmd id -> { resolve, reject, ts }
      eventListeners: new Set(),
    };
    this.sessions.set(ws, session);
    this.logger.log(`[bridge] session ${session.id} connected from ${req.socket.remoteAddress}`);

    // Server hello.
    this._send(ws, {
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      ts: Date.now(),
      type: "event",
      ref: null,
      scope: null,
      body: { kind: "hello", session_id: session.id, server_ts: Date.now() },
    });

    ws.on("message", (raw) => {
      session.lastSeen = Date.now();
      let msg;
      try { msg = JSON.parse(raw); } catch {
        this._send(ws, { v: PROTOCOL_VERSION, id: randomUUID(), ts: Date.now(),
          type: "error", ref: null, scope: null,
          body: { code: "BAD_JSON", message: "non-JSON", retriable: false } });
        return;
      }
      this._handleClientMessage(session, msg);
    });

    ws.on("close", () => {
      this.logger.log(`[bridge] session ${session.id} closed`);
      // Reject all inflight commands.
      for (const [, p] of session.inflight) p.reject(new Error("session_closed"));
      this.sessions.delete(ws);
    });

    ws.on("error", (e) => this.logger.warn(`[bridge] session ${session.id} error: ${e.message}`));

    // Heartbeat watchdog.
    const watchdog = setInterval(() => {
      if (Date.now() - session.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        this.logger.log(`[bridge] session ${session.id} silent — terminating`);
        try { ws.terminate(); } catch {}
        clearInterval(watchdog);
      }
    }, 5_000);
    ws.on("close", () => clearInterval(watchdog));
  }

  _handleClientMessage(session, msg) {
    if (msg.type === "ack") {
      // The CS already acked — nothing to do in Phase 1; Phase 2 marks the
      // dispatched timestamp.
      return;
    }
    if (msg.type === "result" || msg.type === "error") {
      const pending = session.inflight.get(msg.ref);
      if (pending) {
        session.inflight.delete(msg.ref);
        if (msg.type === "error") pending.reject(Object.assign(new Error(msg.body?.message || "error"), { code: msg.body?.code }));
        else pending.resolve(msg.body);
      } else {
        this.logger.warn(`[bridge] result for unknown ref ${msg.ref}`);
      }
      return;
    }
    if (msg.type === "event") {
      const kind = msg.body?.kind;
      if (kind === "audit") {
        this.logger.log(`[bridge] audit batch: ${msg.body.entries?.length ?? 0} entries, head=${msg.body.chain_head?.slice(0, 16)}`);
        // Phase 2: write to context.db action_audit table.
      } else if (kind === "ping") {
        // No reply required — just refresh lastSeen.
      } else {
        this.logger.log(`[bridge] event: ${kind} ${JSON.stringify(msg.body).slice(0, 200)}`);
      }
      for (const l of session.eventListeners) l(msg);
      return;
    }
    this.logger.warn(`[bridge] unhandled type ${msg.type}`);
  }

  _send(ws, msg) {
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify(msg));
  }

  // --- Public API for Jon's reasoning loop ----------------------------------

  listSessions() {
    return Array.from(this.sessions.values()).map((s) => ({
      session_id: s.id,
      last_seen_ms: Date.now() - s.lastSeen,
      inflight: s.inflight.size,
    }));
  }

  sendCommand({ session_id, scope_id = null, action, params = {}, ack_timeout = ACK_TIMEOUT_MS, result_timeout = RESULT_TIMEOUT_MS }) {
    const sessionEntry = Array.from(this.sessions.values()).find((s) => s.id === session_id) ||
                         Array.from(this.sessions.values())[0]; // first session if not specified
    if (!sessionEntry) return Promise.reject(new Error("no_session"));
    const id = randomUUID();
    const cmd = {
      v: PROTOCOL_VERSION, id, ts: Date.now(),
      type: "command", ref: null, scope: scope_id,
      body: { action, ...params },
    };
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (sessionEntry.inflight.has(id)) {
          sessionEntry.inflight.delete(id);
          reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" }));
        }
      }, result_timeout);
      sessionEntry.inflight.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        ts: Date.now(),
      });
    });
    this._send(sessionEntry.ws, cmd);
    return p;
  }

  onEvent(session_id, listener) {
    const sessionEntry = Array.from(this.sessions.values()).find((s) => s.id === session_id);
    if (!sessionEntry) throw new Error("no_session");
    sessionEntry.eventListeners.add(listener);
    return () => sessionEntry.eventListeners.delete(listener);
  }

  stop() {
    return new Promise((resolve) => this.wss.close(resolve));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.env.TB_BRIDGE_PORT || "7862", 10);
  const bridge = new BrowserBridge({ port });
  bridge.start();
  process.on("SIGINT", async () => { await bridge.stop(); process.exit(0); });
}
