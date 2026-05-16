/**
 * BrowserBridge — native runtime infrastructure.
 *
 * Not a channel. The runtime calls `browser.click(selector)` /
 * `browser.fill(...)` / `browser.getState()` directly, awaits the
 * result, and the rest of the pipeline (gates, planning, vault
 * disclosure) treats the browser as just another tool. Think of it
 * the way a process treats stdin/stdout — wire-level plumbing the
 * caller never has to think about.
 *
 * Topology: ThunderGate listens on a dedicated port (default 8771).
 * The ThunderBrowser extension dials in on load, sends `browser_ready`
 * with its current URL + portal state, and from then on this bridge
 * pushes commands and the extension answers them with `command_result`
 * envelopes carrying the same correlation_id.
 *
 * Why a second port (vs. multiplexing on the existing channel @ 9876):
 *   - That port is the channel-shaped path (queueing, audit chain,
 *     pairing). It's still useful for command-and-control scenarios.
 *   - This bridge is the *brain-commands-arm* path. Latency-sensitive,
 *     request/response-shaped, no per-peer queue. Different concerns
 *     warrant a different surface — and crucially, the extension
 *     can connect to either or both without one regressing the other.
 *
 * Failure mode contract:
 *   - If no extension is connected, every awaited call rejects with a
 *     typed BrowserNotConnectedError. Callers handle it the same way
 *     they handle any tool-unavailable case.
 *   - Listener bind failure (port in use) is logged but never throws —
 *     existing runtime functionality must remain 100% intact when the
 *     bridge can't bind. The Ghost Jon 7-day gate clock takes priority.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { WorldState } from '../world/state.js';
import { ProvenanceLedger } from '../provenance/ledger.js';

export const DEFAULT_BROWSER_BRIDGE_PORT = 8771;
export const DEFAULT_COMMAND_TIMEOUT_MS = 5000;

/** Optional per-call override. */
export interface BrowserCallOptions {
  timeoutMs?: number;
}

export interface BrowserState {
  url: string;
  title?: string;
  portalState: string | null;
  domSnapshot?: unknown;
  capturedAt: number;
}

export interface BrowserActionResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  latencyMs: number;
}

export class BrowserNotConnectedError extends Error {
  constructor() {
    super('browser_not_connected');
    this.name = 'BrowserNotConnectedError';
  }
}

export class BrowserCommandTimeoutError extends Error {
  constructor(action: string, timeoutMs: number) {
    super(`browser_command_timeout:${action}:${timeoutMs}ms`);
    this.name = 'BrowserCommandTimeoutError';
  }
}

interface InboundEnvelope {
  type: string;
  correlation_id?: string;
  url?: string;
  title?: string;
  state?: string;
  domSnapshot?: unknown;
  success?: boolean;
  data?: unknown;
  error?: string;
}

interface PendingCommand {
  action: string;
  enqueuedAt: number;
  resolve: (result: BrowserActionResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface BrowserBridgeOptions {
  port?: number;
  defaultTimeoutMs?: number;
}

/**
 * BrowserBridge — minimal listener + request/response router.
 *
 * Single connected extension at a time. When a second client connects
 * the previous one is replaced (browser hot-reloads are common during
 * development; race-free behavior matters more than multi-tab fanout).
 */
export class BrowserBridge {
  private port: number;
  private defaultTimeoutMs: number;
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private clientConnectedAt: number | null = null;
  private pending = new Map<string, PendingCommand>();
  private world: WorldState;
  private provenance: ProvenanceLedger;
  private startedAt: number | null = null;

  constructor(world: WorldState, provenance: ProvenanceLedger, opts: BrowserBridgeOptions = {}) {
    this.world = world;
    this.provenance = provenance;
    this.port = opts.port ?? DEFAULT_BROWSER_BRIDGE_PORT;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Bind the listener. Resolves on success. On bind failure (e.g. port
   * already taken because a previous ThunderGate is still running) we
   * record a provenance row and resolve anyway — runtime startup must
   * not block on this. `isConnected()` will simply stay false.
   */
  async start(): Promise<void> {
    if (this.wss) return;
    return new Promise<void>((resolve) => {
      let server: WebSocketServer;
      try {
        server = new WebSocketServer({ port: this.port });
      } catch (err) {
        this.provenance.append({
          actor: 'browser-bridge',
          action: 'listener_bind_failed',
          target: 'browser-bridge',
          reason: (err as Error).message,
          data: { port: this.port }
        });
        resolve();
        return;
      }
      server.on('listening', () => {
        this.startedAt = Date.now();
        this.provenance.append({
          actor: 'browser-bridge',
          action: 'listener_started',
          target: 'browser-bridge',
          data: { port: this.port }
        });
        resolve();
      });
      server.on('error', (err) => {
        // EADDRINUSE while binding shows up here, not as a thrown
        // construct error. Same contract: log, never crash startup.
        this.provenance.append({
          actor: 'browser-bridge',
          action: 'listener_error',
          target: 'browser-bridge',
          reason: err.message,
          data: { port: this.port }
        });
        if (this.startedAt === null) resolve();
      });
      server.on('connection', (ws) => this.onConnection(ws));
      this.wss = server;
    });
  }

  async stop(): Promise<void> {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('browser_bridge_stopping'));
    }
    this.pending.clear();
    if (this.client) {
      try { this.client.close(1001, 'bridge stopping'); } catch { /* ignore */ }
      this.client = null;
    }
    this.markDisconnected('bridge_stop');
    if (this.wss) {
      const wss = this.wss;
      this.wss = null;
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
    this.startedAt = null;
  }

  // ── public API (the brain calling the arm) ────────────────────────────────

  isConnected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  getStats(): {
    port: number;
    listening: boolean;
    connected: boolean;
    pending: number;
    startedAt: number | null;
    clientConnectedAt: number | null;
  } {
    return {
      port: this.port,
      listening: this.wss !== null,
      connected: this.isConnected(),
      pending: this.pending.size,
      startedAt: this.startedAt,
      clientConnectedAt: this.clientConnectedAt
    };
  }

  async getState(opts?: BrowserCallOptions): Promise<BrowserState> {
    const result = await this.dispatch<BrowserState>('get_state', {}, opts);
    if (!result.success || !result.data) {
      throw new Error(result.error ?? 'get_state_failed');
    }
    return result.data;
  }

  async click(selector: string, opts?: BrowserCallOptions): Promise<BrowserActionResult> {
    return this.dispatch('click', { selector }, opts);
  }

  async fill(selector: string, value: string, opts?: BrowserCallOptions): Promise<BrowserActionResult> {
    return this.dispatch('fill', { selector, value }, opts);
  }

  async navigate(url: string, opts?: BrowserCallOptions): Promise<BrowserActionResult> {
    return this.dispatch('navigate', { url }, opts);
  }

  /**
   * Poll the cached portal state on a short interval until it matches
   * `stateName` or the timeout fires. Doesn't dispatch a command per
   * tick — just reads `worldState.browserPortalState` which the
   * extension keeps fresh via `state_update` envelopes. That keeps the
   * hot loop free of round-trip cost.
   */
  async waitForState(stateName: string, timeoutMs: number = this.defaultTimeoutMs): Promise<boolean> {
    const start = Date.now();
    const tickMs = 100;
    while (Date.now() - start < timeoutMs) {
      if (this.world.browserPortalState === stateName) return true;
      await new Promise((r) => setTimeout(r, tickMs));
    }
    return this.world.browserPortalState === stateName;
  }

  // ── core dispatch ─────────────────────────────────────────────────────────

  private dispatch<T = unknown>(
    action: string,
    args: Record<string, unknown>,
    opts?: BrowserCallOptions
  ): Promise<BrowserActionResult<T>> {
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    const correlationId = randomUUID();
    const enqueuedAt = Date.now();

    if (!this.isConnected() || !this.client) {
      const err = new BrowserNotConnectedError();
      this.provenance.append({
        actor: 'browser-bridge',
        action: 'command_skipped_no_extension',
        target: action,
        reason: err.message,
        data: { args, correlationId }
      });
      return Promise.reject(err);
    }

    return new Promise<BrowserActionResult<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        const latencyMs = Date.now() - enqueuedAt;
        this.logActionResult(action, args, {
          success: false,
          error: 'timeout',
          latencyMs
        });
        reject(new BrowserCommandTimeoutError(action, timeoutMs));
      }, timeoutMs);

      this.pending.set(correlationId, {
        action,
        enqueuedAt,
        resolve: (r) => resolve(r as BrowserActionResult<T>),
        reject,
        timer
      });

      try {
        this.client!.send(JSON.stringify({
          type: 'command',
          correlation_id: correlationId,
          action,
          args
        }));
        this.world.browserLastActionAt = enqueuedAt;
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(correlationId);
        this.logActionResult(action, args, {
          success: false,
          error: `send_failed:${(err as Error).message}`,
          latencyMs: Date.now() - enqueuedAt
        });
        reject(err as Error);
      }
    });
  }

  // ── socket plumbing ───────────────────────────────────────────────────────

  private onConnection(ws: WebSocket): void {
    // Single-client policy: a new connection replaces any prior. This
    // handles the development-time hot-reload case cleanly (the SW
    // re-dials and we'd otherwise leak the old socket).
    if (this.client && this.client !== ws) {
      try { this.client.close(1000, 'replaced_by_new_connection'); } catch { /* ignore */ }
    }
    this.client = ws;
    this.clientConnectedAt = Date.now();

    ws.on('message', (raw) => this.onMessage(raw.toString()));
    ws.on('close', (code, reason) => {
      if (this.client === ws) {
        this.client = null;
        this.markDisconnected(`socket_close:${code}:${reason?.toString() ?? ''}`);
      }
    });
    ws.on('error', (err) => {
      this.provenance.append({
        actor: 'browser-bridge',
        action: 'socket_error',
        target: 'browser-bridge',
        reason: err.message
      });
    });
  }

  private onMessage(raw: string): void {
    let msg: InboundEnvelope;
    try {
      msg = JSON.parse(raw) as InboundEnvelope;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'browser_ready':
        this.markConnected(msg);
        break;
      case 'state_update':
        this.applyStateUpdate(msg);
        break;
      case 'command_result':
        this.resolvePending(msg);
        break;
      default:
        // Ignore unknown types — forward-compat with future extension
        // protocol additions.
        break;
    }
  }

  private markConnected(msg: InboundEnvelope): void {
    this.world.browserConnected = true;
    this.world.browserCurrentUrl = typeof msg.url === 'string' ? msg.url : '';
    this.world.browserPageTitle = typeof msg.title === 'string' ? msg.title : '';
    this.world.browserPortalState = typeof msg.state === 'string' ? msg.state : null;
    this.provenance.append({
      actor: 'browser-bridge',
      action: 'extension_ready',
      target: 'browser',
      data: {
        url: this.world.browserCurrentUrl,
        title: this.world.browserPageTitle,
        portalState: this.world.browserPortalState
      }
    });
  }

  private markDisconnected(reason: string): void {
    if (!this.world.browserConnected) return;
    this.world.browserConnected = false;
    this.provenance.append({
      actor: 'browser-bridge',
      action: 'extension_disconnected',
      target: 'browser',
      reason
    });
    // In-flight commands fail fast — the arm is gone. Caller decides
    // whether to retry once a new connection arrives.
    for (const [id, p] of this.pending.entries()) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new BrowserNotConnectedError());
    }
  }

  private applyStateUpdate(msg: InboundEnvelope): void {
    let changed = false;
    if (typeof msg.url === 'string' && msg.url !== this.world.browserCurrentUrl) {
      this.world.browserCurrentUrl = msg.url;
      changed = true;
    }
    if (typeof msg.title === 'string' && msg.title !== this.world.browserPageTitle) {
      this.world.browserPageTitle = msg.title;
      changed = true;
    }
    if (typeof msg.state === 'string' && msg.state !== this.world.browserPortalState) {
      this.world.browserPortalState = msg.state;
      changed = true;
    }
    // Out-of-process readers (CLI `browser state`) consume the ledger,
    // not in-memory WorldState. Emit a row so they see the new URL/title
    // even though the runtime owns the live socket.
    if (changed) {
      this.provenance.append({
        actor: 'browser-bridge',
        action: 'state_update',
        target: 'browser',
        data: {
          url: this.world.browserCurrentUrl,
          title: this.world.browserPageTitle,
          portalState: this.world.browserPortalState
        }
      });
    }
  }

  private resolvePending(msg: InboundEnvelope): void {
    const id = msg.correlation_id;
    if (!id) return;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);

    const latencyMs = Date.now() - p.enqueuedAt;
    const result: BrowserActionResult = {
      success: msg.success === true,
      data: msg.data,
      error: typeof msg.error === 'string' ? msg.error : undefined,
      latencyMs
    };
    this.logActionResult(p.action, { correlation_id: id }, result);
    p.resolve(result);
  }

  private logActionResult(
    action: string,
    args: Record<string, unknown>,
    result: BrowserActionResult
  ): void {
    this.provenance.append({
      actor: 'browser-bridge',
      action: `browser_${action}`,
      target: 'browser',
      reason: result.error,
      data: {
        args,
        success: result.success,
        latencyMs: result.latencyMs
      }
    });
  }
}
