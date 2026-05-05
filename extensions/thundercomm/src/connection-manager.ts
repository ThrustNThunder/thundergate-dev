/**
 * ThunderComm Connection Manager
 *
 * Manages persistent WebSocket connections from ThunderComm clients.
 * One session (agent:main:main) — many windows (clients).
 *
 * KEY RULES (per Burt's review):
 * - "Connected" ≠ "Healthy" — track application-level health separately
 * - Watchdog logic is conservative — don't create reconnect churn
 * - Dispatch seam is sacred — broadcast is fire-and-forget to clients,
 *   truth lives in transcript, not in connection state
 */

import { ConnectedClient, OutboundMessage } from './types';

export class ConnectionManager {
  private clients = new Map<string, ConnectedClient>();

  // Failover hysteresis — min time before declaring a processor failed
  // 3+ bounces within FLAP_WINDOW_MS = sustained outage → failover
  private static readonly FLAP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
  private static readonly FLAP_THRESHOLD = 3;

  addClient(client: ConnectedClient): void {
    this.clients.set(client.id, client);
    console.log(`[ThunderComm] Client connected: ${client.deviceId} (${this.clients.size} total)`);
  }

  removeClient(clientId: string): void {
    this.clients.delete(clientId);
    console.log(`[ThunderComm] Client disconnected: ${clientId} (${this.clients.size} remaining)`);
  }

  getClient(clientId: string): ConnectedClient | undefined {
    return this.clients.get(clientId);
  }

  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Broadcast to ALL connected clients.
   * Fire-and-forget — if a client misses it, they catch up from transcript on reconnect.
   * Write-ahead to transcript MUST happen before calling broadcast.
   */
  broadcast(msg: OutboundMessage): void {
    for (const client of this.clients.values()) {
      try {
        client.send(msg);
        client.lastSeen = Date.now();
      } catch (err) {
        // Client send failed — remove it, it will reconnect and catch up from transcript
        console.warn(`[ThunderComm] Broadcast failed for client ${client.id}, removing:`, err);
        this.clients.delete(client.id);
      }
    }
  }

  /**
   * Send to a specific client only.
   * Used for history replay on connect — not for normal message delivery.
   */
  sendToClient(clientId: string, msg: OutboundMessage): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    try {
      client.send(msg);
      return true;
    } catch (err) {
      console.warn(`[ThunderComm] Direct send failed for client ${clientId}:`, err);
      this.clients.delete(clientId);
      return false;
    }
  }

  /**
   * Update last seen message ID for a client.
   * Used to track reconnect position for transcript catch-up.
   */
  updateLastMessageId(clientId: string, messageId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.lastMessageId = messageId;
    }
  }

  getAllClients(): ConnectedClient[] {
    return Array.from(this.clients.values());
  }
}
