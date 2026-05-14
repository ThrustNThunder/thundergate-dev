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
import { ChannelType } from './types.js';
export { ChannelType } from './types.js';
export { preferenceFor } from './types.js';
export type { ChannelPreference } from './types.js';
export { ChannelTypeRegistry, defaultChannelTypeRegistry } from './registry.js';
export type { ChannelTypeMatcher } from './registry.js';
/**
 * Wire-protocol envelope written to the unified context file.
 * Each line in context.jsonl is one of these.
 *
 * `channelType` is populated by the runtime once the raw `channel` key
 * has been classified by the `ChannelTypeRegistry`. Channels themselves
 * MAY set it directly when they know their own type; the runtime will
 * fill it in when missing so older adapters keep working unchanged.
 */
export interface ContextEntry {
    id: string;
    timestamp: number;
    channel: string;
    channelType?: ChannelType;
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
    channel: string;
    channelType?: ChannelType;
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
    contextFile: string;
    onInbound: InboundHandler;
}
/**
 * Tiny registry: hold channels by name, broadcast outbound to all.
 * Runtime calls register() during start, then iterates startAll/stopAll.
 */
export declare class ChannelRegistry {
    private channels;
    register(channel: Channel): void;
    get(name: string): Channel | undefined;
    list(): Channel[];
    /**
     * Start every channel. Per-channel failure is captured and rethrown as
     * a single aggregate error at the end so a port conflict on one channel
     * (e.g., bridge.mjs already owns 8765) does not prevent the others from
     * coming up. Runtime treats startup errors as non-fatal — Doctor will
     * show the affected channel as not running.
     */
    startAll(): Promise<void>;
    stopAll(): Promise<void>;
    /**
     * Broadcast a single outbound message to every channel that is running.
     * Channels filter internally by their own routing rules (e.g., target
     * peer, channel id).
     */
    broadcast(message: OutboundDelivery): void;
    stats(): ChannelStats[];
}
