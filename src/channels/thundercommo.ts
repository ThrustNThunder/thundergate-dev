/**
 * ThunderCommo — native channel adapter
 *
 * Replaces bridge.mjs as a first-class core component. Speaks the same
 * wire protocol so iOS / web clients connect unchanged.
 *
 * Responsibilities:
 *   - WebSocket server (default port 8765) for local + LAN clients
 *   - Token-based federation_auth on connect
 *   - Inbound `federation_message` → unified context.jsonl + onInbound()
 *   - Outbound `message` / `stream_chunk` / `thinking` → all live clients
 *   - Optional federation: relay to relay.thunderai.us:8767 for JMAB
 *
 * Design notes:
 *   - ONE context file (principle #1). Inbound + outbound both append.
 *   - NO plugins (principle #3). This file is the channel.
 *   - Tokens come from config, never hard-coded.
 *   - Federation here means *connecting to* the relay, not running one.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import type {
  Channel,
  ChannelContext,
  ChannelStats,
  ContextEntry,
  OutboundDelivery
} from './index.js';

interface InboundMessage {
  type: 'federation_message';
  channel: string;           // 'tnt' | 'jmab' | 'direct:<id>'
  sender: string;
  senderType: 'human' | 'agent';
  text: string;
  timestamp: number;
  id: string;
  originPeer?: string;
}

interface AuthMessage {
  type: 'federation_auth';
  token: string;
  peerId: string;
  channels?: string[];
  // Optional multi-agent filter. When the client pins itself to a specific
  // agent at auth, broadcasts whose outbound `agentId` does not match are
  // suppressed. Omitted = legacy behavior (receive everything on the
  // subscribed channels).
  agentId?: string;
}

interface OutboundMessage {
  type: 'message';
  id: string;
  agentId?: string;
  sender: string;
  channel: string;
  text: string;
  timestamp: number;
  model?: string;
}

interface StreamingChunk {
  type: 'stream_chunk';
  id: string;
  agentId: string;
  channel: string;
  delta: string;
  timestamp: number;
}

interface ThinkingIndicator {
  type: 'thinking';
  agentId: string;
  channel: string;
}

type ServerMessage = OutboundMessage | StreamingChunk | ThinkingIndicator;

interface ClientState {
  ws: WebSocket;
  peerId: string;
  channels: Set<string>;
  authedAt: number;
  // When set, only outbound messages whose `agentId` matches are delivered
  // to this client. null/undefined preserves legacy fan-out.
  agentFilter: string | null;
}

export class ThunderCommoChannel implements Channel {
  readonly name = 'thundercommo';

  private ctx: ChannelContext;
  private wss: WebSocketServer | null = null;
  private relay: WebSocket | null = null;
  private clients = new Map<WebSocket, ClientState>();
  private seenIds = new Set<string>();           // dedup window
  private seenIdOrder: string[] = [];
  private static SEEN_LIMIT = 2048;
  private startedAt: number | null = null;
  private inboundCount = 0;
  private outboundCount = 0;
  private port: number;
  private relayUrl: string;
  private tokens: Record<string, string>;
  private relayReconnectTimer: NodeJS.Timeout | null = null;

  constructor(ctx: ChannelContext) {
    this.ctx = ctx;
    const tc = ctx.config.channels.thundercommo;
    this.port = tc.port ?? 8765;
    this.relayUrl = tc.relay_url ?? tc.relay ?? 'wss://relay.thunderai.us';
    this.tokens = tc.tokens ?? {};
  }

  async start(): Promise<void> {
    if (this.wss) return;

    this.ensureContextFile();

    await new Promise<void>((resolve, reject) => {
      const server = new WebSocketServer({ port: this.port }, () => {
        this.startedAt = Date.now();
        console.log(`  ✓ ThunderCommo listening on ws://0.0.0.0:${this.port}`);
        resolve();
      });
      server.on('error', (err) => {
        console.error('  ✗ ThunderCommo server error:', err);
        reject(err);
      });
      server.on('connection', (ws, req) => this.onConnection(ws, req?.socket?.remoteAddress));
      this.wss = server;
    });

    // Federation: best-effort relay connect. Failure here must NOT take
    // the channel down — local clients still work.
    this.connectRelay();
  }

  async stop(): Promise<void> {
    if (this.relayReconnectTimer) {
      clearTimeout(this.relayReconnectTimer);
      this.relayReconnectTimer = null;
    }
    if (this.relay) {
      try { this.relay.close(); } catch { /* ignore */ }
      this.relay = null;
    }
    if (this.wss) {
      for (const { ws } of this.clients.values()) {
        try { ws.close(); } catch { /* ignore */ }
      }
      this.clients.clear();
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = null;
    }
    this.startedAt = null;
  }

  isRunning(): boolean {
    return this.wss !== null;
  }

  getStats(): ChannelStats {
    return {
      name: this.name,
      running: this.isRunning(),
      connectedClients: this.clients.size,
      inboundCount: this.inboundCount,
      outboundCount: this.outboundCount,
      startedAt: this.startedAt
    };
  }

  /**
   * Runtime calls this when it produces a response. We turn the abstract
   * delivery into a wire-format `message` and broadcast to interested
   * clients (clients that subscribed to the same channel id).
   */
  deliver(message: OutboundDelivery): void {
    const wire: OutboundMessage = {
      type: 'message',
      id: message.id,
      agentId: message.agentId,
      sender: message.sender,
      channel: message.channel,
      text: message.text,
      timestamp: message.timestamp ?? Date.now(),
      model: message.model
    };
    this.broadcastToChannel(wire);
    this.appendContext({
      id: wire.id,
      timestamp: wire.timestamp,
      channel: `thundercommo:${wire.channel}`,
      direction: 'outbound',
      sender: wire.sender,
      senderType: 'agent',
      text: wire.text,
      agentId: wire.agentId,
      model: wire.model
    });
    this.outboundCount++;
  }

  /** Streaming token from runtime. Forwarded as-is, not persisted to context. */
  deliverChunk(chunk: StreamingChunk): void {
    this.broadcastToChannel(chunk);
  }

  /** Typing indicator. Forwarded as-is, not persisted. */
  deliverThinking(indicator: ThinkingIndicator): void {
    this.broadcastToChannel(indicator);
  }

  // ── Connection lifecycle ────────────────────────────────────────────────

  private onConnection(ws: WebSocket, remote?: string): void {
    const state: ClientState = {
      ws,
      peerId: '',
      channels: new Set(),
      authedAt: 0,
      agentFilter: null
    };
    this.clients.set(ws, state);
    console.log(`  ↔ ThunderCommo client connected from ${remote ?? 'unknown'}`);

    ws.on('message', (raw) => this.onClientMessage(ws, raw.toString()));
    ws.on('close', () => {
      this.clients.delete(ws);
      console.log(`  ✗ ThunderCommo client ${state.peerId || 'unauthed'} disconnected`);
    });
    ws.on('error', (err) => {
      console.warn(`  ⚠ ThunderCommo client error (${state.peerId || 'unauthed'}):`, err.message);
    });
  }

  private onClientMessage(ws: WebSocket, raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.sendError(ws, 'invalid_json');
      return;
    }

    const state = this.clients.get(ws);
    if (!state) return;

    if (msg.type === 'federation_auth') {
      this.handleAuth(ws, state, msg as AuthMessage);
      return;
    }

    // Everything else requires a successful auth.
    if (!state.authedAt) {
      this.sendError(ws, 'unauthorized');
      return;
    }

    if (msg.type === 'federation_message') {
      this.handleInbound(state, msg as InboundMessage);
      return;
    }

    // Unknown but authed — ignore quietly to stay forward-compatible.
  }

  private handleAuth(ws: WebSocket, state: ClientState, msg: AuthMessage): void {
    if (!msg.token || !msg.peerId) {
      this.sendError(ws, 'auth_missing_fields');
      ws.close();
      return;
    }

    const ok = Object.values(this.tokens).includes(msg.token);
    if (!ok) {
      console.warn(`  ⚠ ThunderCommo auth failed for peer ${msg.peerId}`);
      this.sendError(ws, 'auth_invalid_token');
      ws.close();
      return;
    }

    state.peerId = msg.peerId;
    state.authedAt = Date.now();
    state.agentFilter = typeof msg.agentId === 'string' && msg.agentId.length > 0
      ? msg.agentId
      : null;
    if (Array.isArray(msg.channels)) {
      for (const c of msg.channels) state.channels.add(c);
    } else {
      // Default subscriptions if client doesn't specify.
      state.channels.add('tnt');
      state.channels.add('jmab');
      state.channels.add(`direct:${msg.peerId}`);
    }

    ws.send(JSON.stringify({
      type: 'federation_auth_ack',
      peerId: msg.peerId,
      channels: [...state.channels],
      timestamp: Date.now()
    }));
    console.log(`  ✓ ThunderCommo auth ok: ${msg.peerId} channels=${[...state.channels].join(',')}`);
  }

  private handleInbound(state: ClientState, msg: InboundMessage): void {
    if (!msg.id || !msg.text || !msg.channel) {
      this.sendError(state.ws, 'message_missing_fields');
      return;
    }

    // Dedup by id — federation can echo.
    if (this.seenIds.has(msg.id)) return;
    this.markSeen(msg.id);

    const entry: ContextEntry = {
      id: msg.id,
      timestamp: msg.timestamp || Date.now(),
      channel: `thundercommo:${msg.channel}`,
      direction: 'inbound',
      sender: msg.sender,
      senderType: msg.senderType,
      text: msg.text,
      originPeer: msg.originPeer
    };

    this.appendContext(entry);
    this.inboundCount++;

    // Hand off to runtime. Runtime decides whether to respond, deep-mode,
    // ignore, etc. Channel is not the policy layer.
    Promise.resolve(this.ctx.onInbound(entry)).catch((err) => {
      console.error('  ✗ ThunderCommo inbound handler threw:', err);
    });
  }

  // ── Outbound broadcast ──────────────────────────────────────────────────

  private broadcastToChannel(msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    // Outbound messages carrying an `agentId` are agent-scoped: clients that
    // pinned themselves to a different agent at auth time get filtered out.
    // Clients with no agentFilter (legacy) receive the broadcast either way,
    // preserving backward compatibility.
    const msgAgentId = (msg as OutboundMessage).agentId ?? null;
    for (const state of this.clients.values()) {
      if (!state.authedAt) continue;
      if (!state.channels.has(msg.channel)) continue;
      if (state.ws.readyState !== WebSocket.OPEN) continue;
      if (msgAgentId && state.agentFilter && state.agentFilter !== msgAgentId) continue;
      try {
        state.ws.send(payload);
      } catch (err) {
        console.warn(`  ⚠ ThunderCommo send failed to ${state.peerId}:`, (err as Error).message);
      }
    }
    // Mirror to relay if connected — federation broadcast.
    if (this.relay && this.relay.readyState === WebSocket.OPEN) {
      try {
        this.relay.send(payload);
      } catch {
        /* relay is best-effort */
      }
    }
  }

  // ── Federation / relay ──────────────────────────────────────────────────

  private connectRelay(): void {
    if (!this.relayUrl) return;
    try {
      const url = this.relayUrl.replace(/\/$/, '') + (this.relayUrl.includes(':8767') ? '' : ':8767');
      const sock = new WebSocket(url);
      this.relay = sock;
      sock.on('open', () => {
        console.log(`  ✓ ThunderCommo federated to ${url}`);
        // Authenticate to relay using first available token.
        const token = Object.values(this.tokens)[0];
        if (token) {
          sock.send(JSON.stringify({
            type: 'federation_auth',
            token,
            peerId: 'thundergate',
            channels: ['tnt', 'jmab']
          }));
        }
      });
      sock.on('message', (raw) => {
        // Treat relay traffic as inbound — federation principle.
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'federation_message') {
            this.handleInbound(
              {
                ws: sock,
                peerId: 'relay',
                channels: new Set(['tnt', 'jmab']),
                authedAt: Date.now(),
                agentFilter: null
              },
              msg
            );
          }
        } catch {
          /* ignore */
        }
      });
      sock.on('close', () => {
        this.relay = null;
        // Backoff reconnect — keep federation resilient without spamming.
        this.relayReconnectTimer = setTimeout(() => this.connectRelay(), 30000);
      });
      sock.on('error', (err) => {
        console.warn(`  ⚠ ThunderCommo relay error: ${err.message}`);
      });
    } catch (err) {
      console.warn('  ⚠ ThunderCommo relay connect failed:', (err as Error).message);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private sendError(ws: WebSocket, code: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: 'error', code, timestamp: Date.now() }));
    } catch {
      /* ignore */
    }
  }

  private appendContext(entry: ContextEntry): void {
    try {
      this.ensureContextFile();
      appendFileSync(this.ctx.contextFile, JSON.stringify(entry) + '\n');
    } catch (err) {
      console.error('  ✗ context.jsonl append failed:', err);
    }
    // Mirror to session DB so search/recall works across channels.
    try {
      this.ctx.db.storeMessage({
        sessionId: 'current',
        agentId: this.ctx.agentId,
        channel: entry.channel,
        role: entry.direction === 'inbound' ? 'user' : 'assistant',
        content: entry.text,
        importance: 'normal'
      });
    } catch {
      /* DB may not be initialized yet at very first message — ignore */
    }
  }

  private ensureContextFile(): void {
    const dir = dirname(this.ctx.contextFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private markSeen(id: string): void {
    this.seenIds.add(id);
    this.seenIdOrder.push(id);
    if (this.seenIdOrder.length > ThunderCommoChannel.SEEN_LIMIT) {
      const drop = this.seenIdOrder.shift()!;
      this.seenIds.delete(drop);
    }
  }
}

/**
 * Helper to mint a unique outbound id.
 */
export function newMessageId(): string {
  return randomUUID();
}
