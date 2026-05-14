/**
 * ThunderGate Channel Registry
 *
 * Design principle #1: ONE context. Every channel writes to the same
 * session file and reads from the same database. No per-channel silos.
 *
 * Design principle #3: NO plugins. Channels are first-class core code —
 * register them here, wire them into the runtime, done.
 */
export { ChannelType, preferenceFor } from './types.js';
export { ChannelTypeRegistry, defaultChannelTypeRegistry } from './registry.js';
/**
 * Tiny registry: hold channels by name, broadcast outbound to all.
 * Runtime calls register() during start, then iterates startAll/stopAll.
 */
export class ChannelRegistry {
    channels = new Map();
    register(channel) {
        if (this.channels.has(channel.name)) {
            throw new Error(`Channel already registered: ${channel.name}`);
        }
        this.channels.set(channel.name, channel);
    }
    get(name) {
        return this.channels.get(name);
    }
    list() {
        return [...this.channels.values()];
    }
    /**
     * Start every channel. Per-channel failure is captured and rethrown as
     * a single aggregate error at the end so a port conflict on one channel
     * (e.g., bridge.mjs already owns 8765) does not prevent the others from
     * coming up. Runtime treats startup errors as non-fatal — Doctor will
     * show the affected channel as not running.
     */
    async startAll() {
        const errors = [];
        for (const ch of this.channels.values()) {
            try {
                await ch.start();
            }
            catch (err) {
                errors.push({ name: ch.name, err: err });
            }
        }
        if (errors.length === 1) {
            const e = errors[0];
            const wrapped = new Error(`[${e.name}] ${e.err.message}`);
            wrapped.channel = e.name;
            throw wrapped;
        }
        if (errors.length > 1) {
            throw new Error('multiple channel start failures: ' +
                errors.map((e) => `${e.name}: ${e.err.message}`).join('; '));
        }
    }
    async stopAll() {
        for (const ch of this.channels.values()) {
            try {
                await ch.stop();
            }
            catch (err) {
                console.error(`  ✗ Channel ${ch.name} stop failed:`, err);
            }
        }
    }
    /**
     * Broadcast a single outbound message to every channel that is running.
     * Channels filter internally by their own routing rules (e.g., target
     * peer, channel id).
     */
    broadcast(message) {
        for (const ch of this.channels.values()) {
            if (ch.isRunning()) {
                try {
                    ch.deliver(message);
                }
                catch (err) {
                    console.error(`  ✗ Channel ${ch.name} delivery failed:`, err);
                }
            }
        }
    }
    stats() {
        return [...this.channels.values()].map((c) => c.getStats());
    }
}
