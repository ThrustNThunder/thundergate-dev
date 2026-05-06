/**
 * ThunderComm Channel Implementation
 * 
 * This is a WebSocket-based channel for the ThunderComm iOS app.
 * Unlike Telegram/WhatsApp which poll external services, this serves
 * direct WebSocket connections from our own app.
 * 
 * Key differences from other channels:
 * - No external API — we ARE the server
 * - Persistent connections — clients stay connected
 * - Multi-device — same session, multiple windows
 * - History sync — catch-up on reconnect
 * 
 * Jon | ThunderBase | 2026-05-05
 */

import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { ConnectionManager } from "./connection-manager.js";
import type {
  InboundMessage,
  OutboundMessage,
  ConversationMessage,
  ThunderCommConfig,
  ConnectedClient,
  HistoryMessage,
  StatusMessage,
  RosterMessage,
} from "./types.js";

// Global connection manager — singleton for this gateway instance
const connectionManager = new ConnectionManager();

// Message ID counter (would be replaced by proper ID generation in production)
let messageIdCounter = 0;
function generateMessageId(): string {
  return `tc_${Date.now()}_${++messageIdCounter}`;
}

/**
 * Handle incoming WebSocket message from ThunderComm client.
 * This is called by the WebSocket server when a client sends data.
 */
export async function handleInboundMessage(
  client: ConnectedClient,
  raw: string,
  config: OpenClawConfig,
  deps: {
    dispatchToAgent: (sessionKey: string, message: string) => Promise<void>;
    getTranscript: (sessionKey: string, limit: number) => Promise<ConversationMessage[]>;
    getAgentRoster: () => Promise<RosterMessage["agents"]>;
  }
): Promise<void> {
  let msg: InboundMessage;
  
  try {
    msg = JSON.parse(raw);
  } catch {
    client.send({
      type: "error",
      code: "INVALID_MESSAGE",
      message: "Failed to parse JSON",
    });
    return;
  }

  switch (msg.type) {
    case "subscribe": {
      // Client wants to subscribe / catch up on history
      const history = await deps.getTranscript(client.sessionKey, 50);
      const historyMsg: HistoryMessage = {
        type: "history",
        messages: history,
        hasMore: history.length >= 50,
      };
      client.send(historyMsg);
      
      // Send current agent roster
      const agents = await deps.getAgentRoster();
      const rosterMsg: RosterMessage = {
        type: "roster",
        agents,
      };
      client.send(rosterMsg);
      
      // Send connection status
      const statusMsg: StatusMessage = {
        type: "status",
        gateway: "connected",
        sessionWarm: true,
      };
      client.send(statusMsg);
      break;
    }

    case "message": {
      // Text message from user
      const sessionKey = msg.channel === "direct" && msg.agentId
        ? `agent:${msg.agentId}:thundercomm:direct:${client.deviceId}`
        : `agent:main:thundercomm:team`;
      
      // Dispatch to agent
      await deps.dispatchToAgent(sessionKey, msg.text);
      
      // Ack the message
      client.send({
        type: "ack",
        idempotencyKey: msg.idempotencyKey,
        messageId: generateMessageId(),
      });
      break;
    }

    case "audio": {
      // Audio message — decode and dispatch
      // TODO: Integrate with STT pipeline
      client.send({
        type: "ack",
        idempotencyKey: msg.idempotencyKey,
        messageId: generateMessageId(),
      });
      break;
    }

    case "action_response": {
      // User responded to an action request (e.g., exec approval)
      // TODO: Route to approval system
      client.send({
        type: "ack",
        idempotencyKey: msg.idempotencyKey,
        messageId: msg.id,
      });
      break;
    }

    case "github_push": {
      // TODO: Implement GitHub push
      client.send({
        type: "error",
        code: "INVALID_MESSAGE",
        message: "GitHub push not yet implemented",
      });
      break;
    }

    case "github_fetch": {
      // TODO: Implement GitHub fetch
      client.send({
        type: "error",
        code: "INVALID_MESSAGE",
        message: "GitHub fetch not yet implemented",
      });
      break;
    }

    default:
      client.send({
        type: "error",
        code: "INVALID_MESSAGE",
        message: `Unknown message type`,
      });
  }
}

/**
 * Broadcast an agent message to all connected ThunderComm clients.
 * Called by the gateway when an agent produces output.
 */
export function broadcastAgentMessage(
  agentId: string,
  text: string,
  channel: "team" | "direct"
): void {
  const msg: ConversationMessage = {
    type: "message",
    id: generateMessageId(),
    agentId,
    channel,
    text,
    timestamp: Date.now(),
  };
  connectionManager.broadcast(msg);
}

/**
 * Broadcast typing indicator when agent starts processing.
 */
export function broadcastThinking(agentId: string): void {
  connectionManager.broadcast({
    type: "thinking",
    agentId,
  });
}

/**
 * Broadcast stream token for real-time typing effect.
 */
export function broadcastStreamDelta(agentId: string, delta: string): void {
  connectionManager.broadcast({
    type: "stream",
    agentId,
    delta,
  });
}

/**
 * Get the connection manager for WebSocket server integration.
 */
export function getConnectionManager(): ConnectionManager {
  return connectionManager;
}

/**
 * ThunderComm channel plugin definition.
 * Follows OpenClaw's plugin SDK patterns but adapted for our WebSocket model.
 */
export const thunderCommPlugin = createChatChannelPlugin({
  id: "thundercomm",
  name: "ThunderComm",
  description: "Sovereign agent communication channel for ThunderComm iOS app",
  
  // ThunderComm doesn't use traditional config — it's always enabled if the extension is loaded
  isConfigured: () => true,
  
  // Session key format for ThunderComm
  normalizeSessionKey: (key: string) => {
    // Expected formats:
    // - agent:main:thundercomm:team
    // - agent:jon:thundercomm:direct:device123
    if (key.includes(":thundercomm:")) {
      return key;
    }
    return undefined;
  },
  
  // Route outbound messages to connected clients
  send: async (sessionKey, payload) => {
    const parts = sessionKey.split(":");
    const channel = parts[3] as "team" | "direct";
    const agentId = parts[1];
    
    if (typeof payload === "string") {
      broadcastAgentMessage(agentId, payload, channel);
    } else if ("text" in payload) {
      broadcastAgentMessage(agentId, payload.text, channel);
    }
    
    return { success: true };
  },
});
