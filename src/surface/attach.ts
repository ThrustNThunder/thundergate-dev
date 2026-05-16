/**
 * SurfaceAttach — the IPC seam between native surfaces (ThunderTUI today,
 * future iOS-on-LAN or a desktop pane) and ThunderGate's running session.
 *
 * Principle 31: ThunderCommo and ThunderBrowser are native surfaces of
 * ThunderGate, not external integrations. The TUI is the same. All surfaces
 * share one runtime, one session model, one WorldState. This module is the
 * concrete wire that makes that true for non-channel surfaces — channels
 * route through their own protocol (ThunderCommo speaks federation_*);
 * the TUI and friends speak the surface protocol below.
 *
 * Topology — a WebSocket server on 127.0.0.1:8772 that:
 *
 *   • Sends an `attached` envelope on connect with the live sessionId,
 *     model, and the last N message turns pulled from SessionDB (so the
 *     TUI doesn't render a blank slate — it joins the conversation already
 *     in progress).
 *   • Accepts `send` envelopes carrying the user's text. For each one we
 *     persist the inbound, load the recent transcript, hit `callLLM` with
 *     the full history, persist the outbound, and return a single
 *     `message` envelope to the requesting socket only — NO channels.broadcast,
 *     because surface responses are meant for the surface they came from.
 *     Slack / ThunderCommo stay where they were.
 *
 * Failure-mode contract mirrors BrowserBridge:
 *   • Listener bind failure is logged but never throws — runtime startup
 *     must continue (the Ghost Jon 7-day clock takes priority).
 *   • In-flight inference errors return as `error` envelopes; the socket
 *     stays open so the user can retry.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import type { SessionDB } from '../session/database.js';
import type { ProvenanceLedger } from '../provenance/ledger.js';

export const DEFAULT_SURFACE_ATTACH_PORT = 8772;
export const HISTORY_TURNS_ON_ATTACH = 40;
/** Soft cap on how many turns we feed back into callLLM per request. */
export const HISTORY_TURNS_FOR_INFERENCE = 30;

/**
 * What the surface needs from the runtime. Kept narrow so the runtime can
 * inject a minimal context object rather than handing the surface a
 * back-reference to itself (which would re-introduce the cyclic
 * dependency we keep avoiding for `channels/*`).
 */
export interface SurfaceContext {
  db: SessionDB;
  provenance: ProvenanceLedger;
  /** Live session id from runtime.state — read each call so we follow checkpoint changes. */
  getSessionId(): string | null;
  /** Model name to stamp on responses so the TUI status line is honest. */
  getModel(): string;
  /**
   * Process one inbound through the runtime's full surface pipeline:
   * TTL gating, persistence, compaction, cache hint, inference,
   * outbound persistence. Hooks let the caller stream `session_reset`
   * and `thinking` to its WS client at the right moments without the
   * surface needing to know about TTL semantics.
   */
  processSurfaceMessage(
    text: string,
    hooks: {
      onReset?: (newSessionId: string) => void;
      onThinking?: () => void;
    }
  ): Promise<{ text: string; resetOccurred: boolean; newSessionId?: string }>;
  /** Force a session reset now — used by `thundergate context reset`. */
  resetSessionNow(): { newSessionId: string };
  /**
   * Snapshot for `thundergate context status`. Returns a JSON-safe summary
   * of the live session age, turn count, token estimate, and effective
   * context config so the CLI can render it without loading runtime state
   * out of band.
   */
  getContextSnapshot(): {
    sessionId: string | null;
    msSinceLastActivity: number;
    wouldResetOnNextInbound: boolean;
    sessionTurnCount: number;
    sessionTokensEstimate: number;
    cfg: {
      sessionTtl: '30m' | '1h' | '2h' | '4h' | 'unlimited';
      cacheRetention: 'short' | 'long' | 'extended';
      compaction: 'smart' | 'aggressive' | 'none';
      maxTokens: number;
      pruneOnReset: boolean;
    };
  };
}

export interface SurfaceAttachOptions {
  port?: number;
}

interface AttachedEnvelope {
  type: 'attached';
  sessionId: string | null;
  model: string;
  history: Array<{ id: string; sender: string; role: 'user' | 'assistant'; channel: string; text: string; timestamp: number }>;
  capturedAt: number;
}

interface ThinkingEnvelope { type: 'thinking'; agentId: string; }

interface MessageEnvelope {
  type: 'message';
  id: string;
  sender: string;
  agentId: string;
  channel: string;
  text: string;
  timestamp: number;
  model: string;
}

interface ErrorEnvelope { type: 'error'; code: string; message: string; correlationId?: string; }

type ServerEnvelope =
  | AttachedEnvelope
  | ThinkingEnvelope
  | MessageEnvelope
  | ErrorEnvelope
  | SessionResetEnvelope
  | ResetDoneEnvelope;

interface ClientSendEnvelope {
  type: 'send';
  text: string;
  correlationId?: string;
}

interface ClientResetEnvelope {
  type: 'reset';
  correlationId?: string;
}

interface SessionResetEnvelope {
  type: 'session_reset';
  oldSessionId: string | null;
  newSessionId: string;
  reason: 'manual' | 'ttl_expired';
}

interface ResetDoneEnvelope {
  type: 'reset_done';
  newSessionId: string;
  correlationId?: string;
}

/**
 * The TUI doesn't know how the runtime persists messages. From the surface's
 * point of view there's one channel id — `surface:tui` — and SessionDB's
 * `channel` column is what filters native surface turns from ThunderCommo
 * federation turns when an operator queries history. Channel ids are the
 * surface tag, not a routing key (we don't broadcast either way).
 */
const SURFACE_CHANNEL_ID = 'surface:tui';

export class SurfaceAttach {
  private wss: WebSocketServer | null = null;
  private port: number;
  private ctx: SurfaceContext;
  private clients = new Set<WebSocket>();

  constructor(ctx: SurfaceContext, opts: SurfaceAttachOptions = {}) {
    this.ctx = ctx;
    this.port = opts.port ?? DEFAULT_SURFACE_ATTACH_PORT;
  }

  async start(): Promise<void> {
    if (this.wss) return;
    return new Promise<void>((resolve) => {
      let server: WebSocketServer;
      try {
        server = new WebSocketServer({ host: '127.0.0.1', port: this.port });
      } catch (err) {
        // EADDRINUSE / EACCES land here as throws on some Node versions —
        // log and continue; the runtime treats this surface as optional.
        this.ctx.provenance.append({
          actor: 'surface-attach',
          action: 'listener_bind_failed',
          target: 'surface-attach',
          reason: (err as Error).message,
          data: { port: this.port }
        });
        resolve();
        return;
      }
      server.on('listening', () => {
        this.ctx.provenance.append({
          actor: 'surface-attach',
          action: 'listener_started',
          target: 'surface-attach',
          data: { port: this.port }
        });
        resolve();
      });
      server.on('error', (err) => {
        // EADDRINUSE on most Node versions arrives as an emitted error
        // rather than a constructor throw. Same contract: log, don't crash.
        this.ctx.provenance.append({
          actor: 'surface-attach',
          action: 'listener_error',
          target: 'surface-attach',
          reason: err.message,
          data: { port: this.port }
        });
        resolve();
      });
      server.on('connection', (ws) => this.onConnection(ws));
      this.wss = server;
    });
  }

  async stop(): Promise<void> {
    for (const c of this.clients) {
      try { c.close(1001, 'surface_attach_stopping'); } catch { /* ignore */ }
    }
    this.clients.clear();
    if (this.wss) {
      const wss = this.wss;
      this.wss = null;
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  }

  getStats(): { port: number; listening: boolean; connected: number } {
    return {
      port: this.port,
      listening: this.wss !== null,
      connected: this.clients.size
    };
  }

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    this.ctx.provenance.append({
      actor: 'surface-attach',
      action: 'client_connected',
      target: 'surface-attach',
      data: { connected: this.clients.size }
    });

    // First frame: hand the surface its sessionId + recent history so the
    // operator's TUI shows the conversation already in progress, not a
    // blank pane.
    const attached: AttachedEnvelope = {
      type: 'attached',
      sessionId: this.ctx.getSessionId(),
      model: this.ctx.getModel(),
      history: this.loadHistory(HISTORY_TURNS_ON_ATTACH),
      capturedAt: Date.now()
    };
    safeSend(ws, attached);

    ws.on('message', (raw) => { void this.onMessage(ws, raw.toString()); });
    ws.on('close', (code, reason) => {
      this.clients.delete(ws);
      this.ctx.provenance.append({
        actor: 'surface-attach',
        action: 'client_disconnected',
        target: 'surface-attach',
        reason: `code=${code} ${reason?.toString() ?? ''}`.trim(),
        data: { connected: this.clients.size }
      });
    });
    ws.on('error', () => { /* close handler will record the drop */ });
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw); } catch {
      safeSend(ws, { type: 'error', code: 'INVALID_JSON', message: 'unparseable envelope' });
      return;
    }
    if (msg?.type === 'reset') {
      const correlationId = typeof msg.correlationId === 'string' ? msg.correlationId : undefined;
      this.handleReset(ws, correlationId);
      return;
    }
    if (msg?.type === 'status_request') {
      safeSend(ws, {
        // Cast — the wire shape is intentionally outside the strict
        // ServerEnvelope union (operator-side diagnostic, not a chat
        // surface event), but goes through the same socket.
        ...({ type: 'status', snapshot: this.ctx.getContextSnapshot() } as unknown as ServerEnvelope)
      });
      return;
    }
    if (msg?.type !== 'send' || typeof msg.text !== 'string') return;
    const text = msg.text.trim();
    if (!text) return;
    const correlationId = typeof msg.correlationId === 'string' ? msg.correlationId : undefined;
    if (!this.ctx.getSessionId()) {
      safeSend(ws, { type: 'error', code: 'NO_SESSION', message: 'runtime has no active session', correlationId });
      return;
    }

    // The runtime's `processSurfaceMessage` owns the full pipeline now:
    // TTL gating, prune-on-reset, persistence, compaction, cache hint,
    // inference, outbound persistence. We only forward the `session_reset`
    // and `thinking` signals to this WS client at the moment they happen.
    try {
      const result = await this.ctx.processSurfaceMessage(text, {
        onReset: (newId) => {
          const env: SessionResetEnvelope = {
            type: 'session_reset',
            oldSessionId: null,
            newSessionId: newId,
            reason: 'ttl_expired'
          };
          safeSend(ws, env);
        },
        onThinking: () => safeSend(ws, { type: 'thinking', agentId: 'jon' })
      });
      if (!result.text) {
        safeSend(ws, {
          type: 'error',
          code: 'EMPTY_RESPONSE',
          message: 'inference returned empty text',
          correlationId
        });
        return;
      }
      const reply: MessageEnvelope = {
        type: 'message',
        id: randomUUID(),
        sender: 'Jon',
        agentId: 'jon',
        channel: SURFACE_CHANNEL_ID,
        text: result.text,
        timestamp: Date.now(),
        model: this.ctx.getModel()
      };
      safeSend(ws, reply);
    } catch (err) {
      safeSend(ws, {
        type: 'error',
        code: 'INFERENCE_FAILED',
        message: (err as Error).message,
        correlationId
      });
    }
  }

  private handleReset(ws: WebSocket, correlationId?: string): void {
    const oldSessionId = this.ctx.getSessionId();
    let newSessionId: string;
    try {
      ({ newSessionId } = this.ctx.resetSessionNow());
    } catch (err) {
      safeSend(ws, {
        type: 'error',
        code: 'RESET_FAILED',
        message: (err as Error).message,
        correlationId
      });
      return;
    }
    // Tell every connected surface — not just the requester — so a TUI
    // and a separate `thundergate context reset` invocation see the same
    // outcome at the same moment.
    const resetEnv: SessionResetEnvelope = {
      type: 'session_reset',
      oldSessionId,
      newSessionId,
      reason: 'manual'
    };
    for (const c of this.clients) safeSend(c, resetEnv);
    safeSend(ws, { type: 'reset_done', newSessionId, correlationId });
  }

  /**
   * Pull the last N turns of the current session's transcript. SessionDB
   * stores rows across every session the runtime has ever owned; we
   * filter by the live `sessionId` so a TTL reset cleanly drops history
   * from the attach view (the row is still in the DB, just not in scope).
   * Rows arrive DESC, we want ASC so the TUI can scroll into the newest
   * turn. Role maps to 'user' | 'assistant' for both wire + LLM shapes.
   */
  private loadHistory(limit: number): AttachedEnvelope['history'] {
    const sessionId = this.ctx.getSessionId();
    if (!sessionId) return [];
    const rows = this.ctx.db.getRecentMessagesForSession(sessionId, limit);
    return rows
      .slice()
      .reverse()
      .map((row) => ({
        id: String(row.id),
        sender: row.role === 'user' ? 'Michael' : 'Jon',
        role: row.role === 'user' ? ('user' as const) : ('assistant' as const),
        channel: row.channel,
        text: row.content,
        timestamp: typeof row.timestamp === 'number' ? row.timestamp * 1000 : Date.now()
      }));
  }
}

function safeSend(ws: WebSocket, env: ServerEnvelope): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(env)); } catch { /* ignore — close will fire */ }
}
