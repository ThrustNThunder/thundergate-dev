/**
 * ThunderGate Browser Bridge — TB-0-6
 *
 * Hosts a WebSocket endpoint at ws://0.0.0.0:<port>/browser that the
 * ThunderBrowser extension service worker connects to. Mirrors the
 * lifecycle and shape of ThunderCommoChannel so the runtime treats it
 * as a peer channel and the operator can use the same registry, doctor
 * checks, and stats surface.
 *
 * Wire protocol (Phase 0 envelope — every message):
 *   { v: 1, id, ts, type, ref?, body }
 *
 * Inbound from the extension:
 *   - "ready"       — first hello after WSS open. body: { ua, bundle_hash }
 *   - "pair_init"   — pairing handshake step 2 (Phase 1 will add the
 *                     challenge round-trip; Phase 0 accepts optimistically).
 *   - "ack"         — extension acknowledged a command we sent. ref = cmd id.
 *   - "cmd_result"  — TB-1-3+ action result returned from the content script.
 *   - "audit"       — TB-1-12 action-record chain entry, flushed in batches.
 *
 * Outbound to the extension:
 *   - "hello"       — server greeting; carries server bundle hash for the
 *                     extension to confirm version compatibility.
 *   - "paired"      — pairing accepted; carries endpoint + tg_kid_pubkeys.
 *   - "scope"       — scope JWT issued; body: { runId, label, jwt? }
 *   - "command"     — action to execute against a tab. body: { runId, action, args }
 *   - "run_end"     — clears the popup run/scope indicator.
 *
 * Phase 0 acceptance: extension can connect, the bridge logs the hello,
 * the bridge can mint a paired event when a pair_init arrives, and
 * commands placed onto the per-peer queue replay on reconnect.
 *
 * Phase 1 (TB-1-12, TB-1-13) wires audit ingestion + allowlist verification
 * onto the same `audit` and `cmd_result` paths — schema additions only.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { randomUUID } from 'crypto';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import type { Channel, ChannelContext, ChannelStats, OutboundDelivery } from './index.js';

const WIRE_VERSION = 1;
const BRIDGE_PATH = '/browser';

interface BridgeEnvelope {
  v: number;
  id: string;
  ts: number;
  type: string;
  ref?: string;
  body?: Record<string, unknown>;
}

interface PendingCommand {
  envelope: BridgeEnvelope;
  enqueued_at: number;
}

interface ExtensionClient {
  ws: WebSocket;
  remote: string;
  peerId: string | null;          // populated after pair_init
  pairingCode: string | null;     // current pending code, if any
  bundleHash: string | null;
  connectedAt: number;
  helloAt: number | null;
  pairedAt: number | null;
  queue: PendingCommand[];        // commands queued while disconnected
}

export interface BrowserBridgeStats extends ChannelStats {
  pairedPeers: number;
  pendingCommands: number;
  auditRecordsReceived: number;
}

/**
 * Configuration knobs that aren't (yet) part of the top-level Config
 * — the bridge runs on a different port than ThunderCommo and the
 * Phase 0 scaffold seeds them inline. Phase 1 promotes these into
 * `config.channels.browser` once the field is wired through.
 */
export interface BrowserBridgeOptions {
  port: number;
  auditFile: string;
  maxQueuePerClient: number;
  // Pairing codes from the options page are accepted optimistically in
  // Phase 0. Phase 1 will require the extension to present a JWT signed
  // by its device key (TB-0-7) and the bridge will verify against the
  // pinned pubkey list from the QR exchange (TB-0-8).
  acceptUnverifiedPairing: boolean;
}

const DEFAULT_OPTS: BrowserBridgeOptions = {
  port: 9876,
  auditFile: join(process.env.HOME || '', '.thundergate', 'browser-audit.jsonl'),
  maxQueuePerClient: 256,
  acceptUnverifiedPairing: true
};

export class BrowserBridgeChannel implements Channel {
  readonly name = 'browser';

  private ctx: ChannelContext;
  private opts: BrowserBridgeOptions;
  private wss: WebSocketServer | null = null;
  private clients = new Map<WebSocket, ExtensionClient>();
  // peerId → most recent client (for queue replay on reconnect)
  private byPeer = new Map<string, ExtensionClient>();
  private startedAt: number | null = null;
  private inboundCount = 0;
  private outboundCount = 0;
  private auditCount = 0;

  constructor(ctx: ChannelContext, opts: Partial<BrowserBridgeOptions> = {}) {
    this.ctx = ctx;
    this.opts = { ...DEFAULT_OPTS, ...opts };
  }

  // ── Channel lifecycle ───────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.wss) return;
    this.ensureAuditDir();

    await new Promise<void>((resolve, reject) => {
      const server = new WebSocketServer({
        port: this.opts.port,
        // Only accept WS upgrades on /browser. Other paths get 404 so
        // ports shared with future endpoints stay cleanly partitioned.
        verifyClient: (info, done) => {
          const url = info.req.url || '/';
          if (url.split('?')[0] !== BRIDGE_PATH) {
            done(false, 404, 'not found');
            return;
          }
          done(true);
        }
      }, () => {
        this.startedAt = Date.now();
        console.log(`  ✓ Browser bridge listening on ws://0.0.0.0:${this.opts.port}${BRIDGE_PATH}`);
        resolve();
      });
      server.on('error', (err) => {
        console.error('  ✗ Browser bridge server error:', err);
        reject(err);
      });
      server.on('connection', (ws, req) => this.onConnection(ws, req));
      this.wss = server;
    });
  }

  async stop(): Promise<void> {
    if (!this.wss) return;
    for (const c of this.clients.values()) {
      try { c.ws.close(1001, 'bridge stopping'); } catch { /* ignore */ }
    }
    this.clients.clear();
    this.byPeer.clear();
    await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
    this.wss = null;
    this.startedAt = null;
  }

  isRunning(): boolean {
    return this.wss !== null;
  }

  getStats(): BrowserBridgeStats {
    let pending = 0;
    for (const c of this.byPeer.values()) pending += c.queue.length;
    return {
      name: this.name,
      running: this.isRunning(),
      connectedClients: this.clients.size,
      inboundCount: this.inboundCount,
      outboundCount: this.outboundCount,
      startedAt: this.startedAt,
      pairedPeers: this.byPeer.size,
      pendingCommands: pending,
      auditRecordsReceived: this.auditCount
    };
  }

  /**
   * Channel.deliver — runtime broadcasts an outbound message. For the
   * browser bridge this is a control envelope addressed by `channel`:
   *   - "browser:<peerId>"  → command queued/sent to that paired peer
   *   - "browser:*"         → broadcast (rare; used for kill-switch type events)
   *
   * Anything that doesn't start with "browser:" is ignored — the registry's
   * `broadcast()` hits every channel and most messages aren't for us.
   */
  deliver(message: OutboundDelivery): void {
    if (!message.channel.startsWith('browser:')) return;
    const target = message.channel.slice('browser:'.length);
    const env: BridgeEnvelope = {
      v: WIRE_VERSION,
      id: message.id || randomUUID(),
      ts: message.timestamp ?? Date.now(),
      type: 'command',
      body: {
        runId: target,                // by convention; runtime fills in
        text: message.text,           // free-form action payload
        sender: message.sender,
        agentId: message.agentId
      }
    };
    if (target === '*') {
      for (const c of this.clients.values()) {
        this.sendOrQueue(c, env);
      }
    } else {
      const c = this.byPeer.get(target);
      if (c) this.sendOrQueue(c, env);
      // No peer? Drop silently — there's nothing to deliver to, and
      // pairing must happen out-of-band before commands can flow.
    }
    this.outboundCount++;
  }

  /**
   * Direct command path for the runtime. Unlike `deliver()`, this is
   * the typed call site the action executor (TB-1-3+) will use.
   *
   * Returns the id of the dispatched envelope so the caller can match
   * the resulting `cmd_result` / `ack` against its in-flight map.
   */
  dispatchCommand(peerId: string, action: string, args: Record<string, unknown> = {}, runId?: string): string {
    const env: BridgeEnvelope = {
      v: WIRE_VERSION,
      id: randomUUID(),
      ts: Date.now(),
      type: 'command',
      body: { runId: runId || null, action, args }
    };
    const c = this.byPeer.get(peerId);
    if (c) this.sendOrQueue(c, env);
    return env.id;
  }

  /** Emit a scope event so the popup updates its run indicator. */
  emitScope(peerId: string, runId: string, label: string): void {
    const c = this.byPeer.get(peerId);
    if (!c) return;
    this.send(c, {
      v: WIRE_VERSION,
      id: randomUUID(),
      ts: Date.now(),
      type: 'scope',
      body: { runId, label }
    });
  }

  /** Emit run_end to clear the popup indicator. */
  emitRunEnd(peerId: string, runId: string): void {
    const c = this.byPeer.get(peerId);
    if (!c) return;
    this.send(c, {
      v: WIRE_VERSION,
      id: randomUUID(),
      ts: Date.now(),
      type: 'run_end',
      body: { runId }
    });
  }

  // ── Connection lifecycle ────────────────────────────────────────────────

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const remote = req?.socket?.remoteAddress || 'unknown';
    const client: ExtensionClient = {
      ws,
      remote,
      peerId: null,
      pairingCode: null,
      bundleHash: null,
      connectedAt: Date.now(),
      helloAt: null,
      pairedAt: null,
      queue: []
    };
    this.clients.set(ws, client);
    console.log(`  ↔ Browser bridge client connected from ${remote}`);

    // Greet immediately. Phase 0 extension treats this as informational;
    // Phase 1 will validate the server bundle hash before sending anything
    // sensitive (commands carrying secrets, etc.).
    this.send(client, {
      v: WIRE_VERSION,
      id: randomUUID(),
      ts: Date.now(),
      type: 'hello',
      body: {
        server: 'thundergate',
        server_bundle_hash: 'tg-dev0',
        wire_version: WIRE_VERSION
      }
    });

    ws.on('message', (raw) => this.onMessage(client, raw.toString()));
    ws.on('close', (code, reason) => {
      this.clients.delete(ws);
      console.log(`  ✗ Browser bridge client ${client.peerId || 'unpaired'} disconnected`, {
        code,
        reason: reason?.toString() || null
      });
      // Keep `byPeer` mapping pointing at the old client object so we can
      // re-attach the queue if a new socket pairs to the same peer. The
      // queue stays in memory until the bridge restarts.
    });
    ws.on('error', (err) => {
      console.warn(`  ⚠ Browser bridge client error (${client.peerId || 'unpaired'}):`, err.message);
    });
  }

  private onMessage(client: ExtensionClient, raw: string): void {
    let env: BridgeEnvelope;
    try {
      env = JSON.parse(raw);
    } catch {
      this.sendError(client, null, 'invalid_json');
      return;
    }
    if (!this.isEnvelope(env)) {
      this.sendError(client, null, 'invalid_envelope');
      return;
    }

    this.inboundCount++;

    switch (env.type) {
      case 'ready':
        this.onReady(client, env);
        break;
      case 'pair_init':
        this.onPairInit(client, env);
        break;
      case 'ack':
        this.onAck(client, env);
        break;
      case 'cmd_result':
        this.onCmdResult(client, env);
        break;
      case 'audit':
        this.onAudit(client, env);
        break;
      default:
        // Forward-compat: ignore unknown types but log so we can spot
        // protocol drift between extension and bridge in the SW console.
        console.log(`  · browser bridge ignoring unknown type "${env.type}"`);
    }
  }

  private onReady(client: ExtensionClient, env: BridgeEnvelope): void {
    client.helloAt = Date.now();
    client.bundleHash = (env.body?.bundle_hash as string) || null;
    console.log('  ✓ Browser extension ready', {
      ua: env.body?.ua || null,
      bundle_hash: client.bundleHash,
      remote: client.remote
    });
  }

  /**
   * Phase 0: optimistic pairing. The options page generates a pairing
   * code (TB-0-8) and POSTs it to the SW, the SW relays a `pair_init`
   * carrying the code. We accept it, stash the peerId, and emit a
   * `paired` event the SW promotes to "paired" in IndexedDB.
   *
   * Phase 1 will require:
   *   - The pair_init carry a JWT signed by the extension's device key
   *     (TB-0-7) — verified against the pubkey from the QR exchange.
   *   - The bridge persist the pairing record so it survives restart.
   */
  private onPairInit(client: ExtensionClient, env: BridgeEnvelope): void {
    const body = env.body || {};
    const peerId = (body.peerId as string) || (body.extensionPairId as string);
    const pairingCode = (body.pairingCode as string) || null;
    if (!peerId) {
      this.sendError(client, env.id, 'pair_init_missing_peerId');
      return;
    }

    if (!this.opts.acceptUnverifiedPairing) {
      // Phase 1+ path. Reject until JWT verification is plumbed.
      this.sendError(client, env.id, 'pair_init_unverified');
      return;
    }

    client.peerId = peerId;
    client.pairingCode = pairingCode;
    client.pairedAt = Date.now();

    // Re-attach any queued commands from a prior session for this peer.
    const prior = this.byPeer.get(peerId);
    if (prior && prior !== client) {
      client.queue.push(...prior.queue);
      prior.queue.length = 0;
    }
    this.byPeer.set(peerId, client);

    this.send(client, {
      v: WIRE_VERSION,
      id: randomUUID(),
      ts: Date.now(),
      type: 'paired',
      ref: env.id,
      body: {
        peerId,
        pairingCode,
        endpoint: `ws://0.0.0.0:${this.opts.port}${BRIDGE_PATH}`,
        tg_kid_pubkeys: [],          // Phase 1 fills this with the bridge's signing key(s)
        accepted_at: client.pairedAt
      }
    });

    console.log(`  ✓ Browser bridge paired peer=${peerId} (Phase 0 optimistic)`);

    // Drain any queued commands now that the peer is back.
    this.drainQueue(client);
  }

  private onAck(client: ExtensionClient, env: BridgeEnvelope): void {
    // The runtime currently doesn't track in-flight commands at the bridge
    // layer — acks are informational. Logging makes flapping reconnects
    // easy to spot in the SW + bridge logs side by side.
    if (env.ref) {
      console.log(`  · ack ${env.ref} from peer=${client.peerId || 'unpaired'}`);
    }
  }

  private onCmdResult(client: ExtensionClient, env: BridgeEnvelope): void {
    // TB-1-3+ will plumb this into the runtime's action executor so the
    // caller's awaiting promise resolves. For now, log + append to audit
    // so we have a trail even before the executor lands.
    this.appendAudit({
      kind: 'cmd_result',
      peerId: client.peerId,
      env
    });
  }

  private onAudit(client: ExtensionClient, env: BridgeEnvelope): void {
    // TB-1-12 — action-record chain. The extension flushes its local
    // chain in batches; we accept any number of records in body.records.
    const records = Array.isArray(env.body?.records) ? env.body!.records as unknown[] : [env.body];
    let accepted = 0;
    for (const rec of records) {
      if (!rec || typeof rec !== 'object') continue;
      this.appendAudit({
        kind: 'audit',
        peerId: client.peerId,
        record: rec
      });
      accepted++;
    }
    this.auditCount += accepted;

    // Ack the batch so the extension can mark these records server-acked
    // and drop them from its outbound queue (TB-1-12 invariant: never drop
    // unacked records).
    this.send(client, {
      v: WIRE_VERSION,
      id: randomUUID(),
      ts: Date.now(),
      type: 'audit_ack',
      ref: env.id,
      body: { accepted }
    });
  }

  // ── Send paths ──────────────────────────────────────────────────────────

  private send(client: ExtensionClient, env: BridgeEnvelope): boolean {
    if (client.ws.readyState !== WebSocket.OPEN) return false;
    try {
      client.ws.send(JSON.stringify(env));
      return true;
    } catch (err) {
      console.warn(`  ⚠ Browser bridge send failed to ${client.peerId || 'unpaired'}:`, (err as Error).message);
      return false;
    }
  }

  private sendError(client: ExtensionClient, ref: string | null, code: string): void {
    this.send(client, {
      v: WIRE_VERSION,
      id: randomUUID(),
      ts: Date.now(),
      type: 'error',
      ref: ref || undefined,
      body: { code }
    });
  }

  /**
   * Send if open, otherwise queue for replay on next pairing event.
   * Queue is capped per client so a long offline window can't drive the
   * bridge OOM; oldest entries trim first.
   */
  private sendOrQueue(client: ExtensionClient, env: BridgeEnvelope): void {
    if (client.ws.readyState === WebSocket.OPEN && client.peerId) {
      this.send(client, env);
      return;
    }
    client.queue.push({ envelope: env, enqueued_at: Date.now() });
    while (client.queue.length > this.opts.maxQueuePerClient) {
      client.queue.shift();
    }
  }

  private drainQueue(client: ExtensionClient): void {
    if (client.queue.length === 0) return;
    const pending = client.queue.slice();
    client.queue.length = 0;
    for (const p of pending) {
      this.send(client, p.envelope);
    }
    console.log(`  · drained ${pending.length} queued command(s) for peer=${client.peerId}`);
  }

  // ── Audit append ────────────────────────────────────────────────────────

  private appendAudit(entry: Record<string, unknown>): void {
    try {
      const line = JSON.stringify({ ts: Date.now(), ...entry }) + '\n';
      appendFileSync(this.opts.auditFile, line);
    } catch (err) {
      console.error('  ✗ Browser bridge audit append failed:', err);
    }
  }

  private ensureAuditDir(): void {
    const dir = dirname(this.opts.auditFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // ── Validation ──────────────────────────────────────────────────────────

  private isEnvelope(e: unknown): e is BridgeEnvelope {
    if (!e || typeof e !== 'object') return false;
    const x = e as Record<string, unknown>;
    return typeof x.v === 'number'
      && typeof x.id === 'string'
      && typeof x.ts === 'number'
      && typeof x.type === 'string';
  }
}
