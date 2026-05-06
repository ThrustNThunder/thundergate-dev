/**
 * ThunderComm WebSocket Server
 * 
 * Handles incoming WebSocket connections from ThunderComm iOS clients.
 * Runs alongside the main OpenClaw gateway on a dedicated port.
 * 
 * Authentication: Token-based, same as gateway token system.
 * Protocol: JSON messages per types.ts
 * 
 * Jon | ThunderBase | 2026-05-05
 */

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import { getConnectionManager, handleInboundMessage } from "./channel.js";
import type { ConnectedClient, OutboundMessage, StatusMessage } from "./types.js";

export interface ThunderCommServerConfig {
  port: number;
  token: string; // Gateway token for authentication
  getTranscript: (sessionKey: string, limit: number) => Promise<any[]>;
  dispatchToAgent: (sessionKey: string, message: string) => Promise<void>;
  getAgentRoster: () => Promise<any[]>;
}

export class ThunderCommServer {
  private wss: WebSocketServer | null = null;
  private config: ThunderCommServerConfig;
  
  constructor(config: ThunderCommServerConfig) {
    this.config = config;
  }
  
  start(): void {
    if (this.wss) {
      console.log("[ThunderComm] Server already running");
      return;
    }
    
    this.wss = new WebSocketServer({ port: this.config.port });
    
    this.wss.on("connection", (ws, req) => {
      this.handleConnection(ws, req);
    });
    
    this.wss.on("error", (err) => {
      console.error("[ThunderComm] Server error:", err);
    });
    
    console.log(`[ThunderComm] WebSocket server listening on port ${this.config.port}`);
  }
  
  stop(): void {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
      console.log("[ThunderComm] Server stopped");
    }
  }
  
  private handleConnection(ws: WebSocket, req: any): void {
    // Extract auth token from query string or header
    const url = new URL(req.url || "/", `http://localhost`);
    const token = url.searchParams.get("token") || req.headers["x-thundercomm-token"];
    
    if (token !== this.config.token) {
      console.warn("[ThunderComm] Connection rejected: invalid token");
      ws.close(4001, "Unauthorized");
      return;
    }
    
    // Extract device ID (required for multi-device tracking)
    const deviceId = url.searchParams.get("deviceId") || randomUUID();
    
    // Create client record
    const clientId = randomUUID();
    const client: ConnectedClient = {
      id: clientId,
      deviceId,
      sessionKey: "agent:main:thundercomm:team", // Default session
      lastSeen: Date.now(),
      lastMessageId: null,
      send: (msg: OutboundMessage) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      },
    };
    
    // Register with connection manager
    const connectionManager = getConnectionManager();
    connectionManager.addClient(client);
    
    // Send initial status
    const statusMsg: StatusMessage = {
      type: "status",
      gateway: "connected",
      sessionWarm: true,
    };
    client.send(statusMsg);
    
    // Handle incoming messages
    ws.on("message", async (data) => {
      try {
        const raw = data.toString();
        await handleInboundMessage(client, raw, {} as any, {
          dispatchToAgent: this.config.dispatchToAgent,
          getTranscript: this.config.getTranscript,
          getAgentRoster: this.config.getAgentRoster,
        });
        client.lastSeen = Date.now();
      } catch (err) {
        console.error("[ThunderComm] Message handling error:", err);
        client.send({
          type: "error",
          code: "INVALID_MESSAGE",
          message: "Internal error processing message",
        });
      }
    });
    
    // Handle disconnection
    ws.on("close", (code, reason) => {
      connectionManager.removeClient(clientId);
      console.log(`[ThunderComm] Client ${deviceId} disconnected: ${code} ${reason}`);
    });
    
    // Handle errors
    ws.on("error", (err) => {
      console.error(`[ThunderComm] Client ${deviceId} error:`, err);
      connectionManager.removeClient(clientId);
    });
    
    // Ping/pong for keepalive
    ws.on("pong", () => {
      client.lastSeen = Date.now();
    });
  }
  
  /**
   * Periodic cleanup of stale connections.
   * Call this from a timer if needed.
   */
  cleanupStaleConnections(maxAgeMs: number = 5 * 60 * 1000): void {
    const now = Date.now();
    const connectionManager = getConnectionManager();
    
    for (const client of connectionManager.getAllClients()) {
      if (now - client.lastSeen > maxAgeMs) {
        console.log(`[ThunderComm] Removing stale client: ${client.deviceId}`);
        connectionManager.removeClient(client.id);
      }
    }
  }
}

/**
 * Create and start the ThunderComm server.
 * Called during gateway startup.
 */
export function createThunderCommServer(config: ThunderCommServerConfig): ThunderCommServer {
  const server = new ThunderCommServer(config);
  server.start();
  return server;
}
