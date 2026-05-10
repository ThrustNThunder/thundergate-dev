/**
 * ThunderGate Channel Registry
 *
 * Design principle #1: ONE context. Every channel writes to the same
 * session file and reads from the same database. No per-channel silos.
 *
 * Design principle #3: NO plugins. Channels are first-class core code —
 * register them here, wire them into the runtime, done.
 */

import type { Config } from '../config/loader.js';
import type { SessionDB } from '../session/database.js';

/**
 * Wire-protocol envelope written to the unified context file.
 * Each line in context.jsonl is one of these.
 */
export interface ContextEntry {
  id: string;
  timestamp: number;
  channel: string;          // 'thundercommo:tnt', 'thundercommo:jmab', 'direct:jon', ...
  direction: 'inbound' | 'outbound';
  sender: string;
  senderType: 'human' | 'agent';
  text: string;
  agentId?: string;
  originPeer?: string;
  model?: string;
}

/**
 * Channel lifecycle. start() opens connections, stop() drains them.
 * deliver() pushes a runtime-generated response out to the channel's clients.
 */
export interface Channel {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  deliver(message: OutboundDelivery): void;
  isRunning(): boolean;
  getStats(): ChannelStats;
}

export interface OutboundDelivery {
  id: string;
  agentId?: string;
  sender: string;
  channel: string;          // 'tnt' | 'jmab' | 'direct:<id>'
  text: string;
  timestamp?: number;
  model?: string;
}

export interface ChannelStats {
  name: string;
  running: boolean;
  connectedClients: number;
  inboundCount: number;
  outboundCount: number;
  startedAt: number | null;
}

/**
 * Hook the runtime supplies so channels can hand inbound messages over
 * for processing. The runtime decides what to do with them — channels
 * just relay.
 */
export type InboundHandler = (entry: ContextEntry) => void | Promise<void>;

export interface ChannelContext {
  config: Config;
  db: SessionDB;
  contextFile: string;       // unified context.jsonl path
  onInbound: InboundHandler;
}

/**
 * Tiny registry: hold channels by name, broadcast outbound to all.
 * Runtime calls register() during start, then iterates startAll/stopAll.
 */
export class ChannelRegistry {
  private channels = new Map<string, Channel>();

  register(channel: Channel): void {
    if (this.channels.has(channel.name)) {
      throw new Error(`Channel already registered: ${channel.name}`);
    }
    this.channels.set(channel.name, channel);
  }

  get(name: string): Channel | undefined {
    return this.channels.get(name);
  }

  list(): Channel[] {
    return [...this.channels.values()];
  }

  async startAll(): Promise<void> {
    for (const ch of this.channels.values()) {
      await ch.start();
    }
  }

  async stopAll(): Promise<void> {
    for (const ch of this.channels.values()) {
      try {
        await ch.stop();
      } catch (err) {
        console.error(`  ✗ Channel ${ch.name} stop failed:`, err);
      }
    }
  }

  /**
   * Broadcast a single outbound message to every channel that is running.
   * Channels filter internally by their own routing rules (e.g., target
   * peer, channel id).
   */
  broadcast(message: OutboundDelivery): void {
    for (const ch of this.channels.values()) {
      if (ch.isRunning()) {
        try {
          ch.deliver(message);
        } catch (err) {
          console.error(`  ✗ Channel ${ch.name} delivery failed:`, err);
        }
      }
    }
  }

  stats(): ChannelStats[] {
    return [...this.channels.values()].map((c) => c.getStats());
  }
}
