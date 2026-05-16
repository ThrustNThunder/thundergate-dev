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
  /** Run inference with the supplied conversation history. */
  callLLM(messages: Array<{ role: string; content: string }>): Promise<string>;
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

type ServerEnvelope = AttachedEnvelope | ThinkingEnvelope | MessageEnvelope | ErrorEnvelope;

interface ClientSendEnvelope {
  type: 'send';
  text: string;
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
    let msg: Partial<ClientSendEnvelope>;
    try { msg = JSON.parse(raw); } catch {
      safeSend(ws, { type: 'error', code: 'INVALID_JSON', message: 'unparseable envelope' });
      return;
    }
    if (msg?.type !== 'send' || typeof msg.text !== 'string') return;
    const text = msg.text.trim();
    if (!text) return;
    const correlationId = msg.correlationId;
    const sessionId = this.ctx.getSessionId();
    if (!sessionId) {
      safeSend(ws, { type: 'error', code: 'NO_SESSION', message: 'runtime has no active session', correlationId });
      return;
    }

    try {
      this.ctx.db.ensureSession(sessionId);
      this.ctx.db.storeMessage({
        sessionId,
        channel: SURFACE_CHANNEL_ID,
        role: 'user',
        content: text
      });
    } catch (err) {
      safeSend(ws, {
        type: 'error',
        code: 'PERSIST_INBOUND_FAILED',
        message: (err as Error).message,
        correlationId
      });
      // Still attempt the LLM call — losing the recall row is worse than
      // missing the audit row from the surface attach's perspective.
    }

    // Signal "Jon's reading" before the round-trip so the TUI can show the
    // same indicator users see on Slack. We don't bother streaming partial
    // tokens — `callLLM` is non-streaming and adding it would force this
    // surface to know about provider-specific deltas.
    safeSend(ws, { type: 'thinking', agentId: 'jon' });

    // Build the history for this turn. We pull from SessionDB (the unified
    // recall seam) so any other native surface that's also been chatting
    // shows up here. Already-stored inbound is included via getRecent, so
    // we don't append it twice.
    const turns = this.loadHistory(HISTORY_TURNS_FOR_INFERENCE);
    const llmMessages = turns.map((t) => ({ role: t.role, content: t.text }));

    let replyText: string;
    try {
      replyText = await this.ctx.callLLM(llmMessages);
    } catch (err) {
      safeSend(ws, {
        type: 'error',
        code: 'INFERENCE_FAILED',
        message: (err as Error).message,
        correlationId
      });
      return;
    }
    if (!replyText) {
      safeSend(ws, {
        type: 'error',
        code: 'EMPTY_RESPONSE',
        message: 'inference returned empty text',
        correlationId
      });
      return;
    }

    try {
      this.ctx.db.storeMessage({
        sessionId,
        channel: SURFACE_CHANNEL_ID,
        role: 'assistant',
        content: replyText
      });
    } catch (err) {
      // Audit row failed but the user is still owed the reply.
      this.ctx.provenance.append({
        actor: 'surface-attach',
        action: 'persist_outbound_failed',
        target: 'session-db',
        reason: (err as Error).message
      });
    }

    const reply: MessageEnvelope = {
      type: 'message',
      id: randomUUID(),
      sender: 'Jon',
      agentId: 'jon',
      channel: SURFACE_CHANNEL_ID,
      text: replyText,
      timestamp: Date.now(),
      model: this.ctx.getModel()
    };
    safeSend(ws, reply);
  }

  /**
   * Pull the last N turns of the unified conversation. SessionDB.getRecent
   * returns DESC; the TUI wants ASC (oldest first) so it can scroll into
   * the newest turn. We map row.role → 'user' | 'assistant' so the wire
   * shape matches what the LLM call expects.
   */
  private loadHistory(limit: number): AttachedEnvelope['history'] {
    const rows = this.ctx.db.getRecentMessages(limit);
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
