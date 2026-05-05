/**
 * ThunderComm Channel
 *
 * Implements the OpenClaw plugin channel contract.
 * Same interface as extensions/telegram/src/channel.ts — just a different transport.
 *
 * ARCHITECTURE NOTES:
 * - This channel does NOT own session truth. BeeKeeper does.
 * - This channel does NOT manage agent state. The gateway session does.
 * - This channel IS responsible for: connection auth, message routing,
 *   broadcast fanout, history replay, four UI message type routing.
 *
 * Per Burt: "Separate orchestration from channel transport.
 *            Don't let channel code quietly become state authority."
 */

import { ConnectionManager } from './connection-manager';
import {
  InboundMessage,
  OutboundMessage,
  ThunderCommConfig,
  ConnectedClient,
  ConversationMessage,
  SystemEventMessage,
} from './types';

// Agent roster — hardcoded for Phase 1, will be dynamic in Phase 2
const DEFAULT_ROSTER = [
  { id: 'jon', name: 'Jon', status: 'online' as const, role: 'Technical Director' },
  { id: 'mack', name: 'Mack', status: 'offline' as const, role: 'Operations' },
  { id: 'rex', name: 'Rex', status: 'offline' as const, role: 'AA Pilot Automation' },
];

export function createThunderCommChannel(config: ThunderCommConfig = {}) {
  const connectionManager = new ConnectionManager();
  const maxHistory = config.maxHistoryOnConnect ?? 50;

  /**
   * Handle a new WebSocket connection from a ThunderComm client.
   * Called by the gateway when a new WS connection is authenticated.
   */
  function onClientConnect(
    clientId: string,
    deviceId: string,
    sessionKey: string,
    send: (msg: OutboundMessage) => void,
    disconnect: () => void,
  ): void {
    const client: ConnectedClient = {
      id: clientId,
      deviceId,
      sessionKey,
      lastSeen: Date.now(),
      lastMessageId: null,
      send,
    };

    connectionManager.addClient(client);

    // Send roster on connect
    send({
      type: 'roster',
      agents: DEFAULT_ROSTER,
    });

    // Send status
    send({
      type: 'status',
      gateway: 'connected',
      sessionWarm: true,
    });
  }

  /**
   * Handle a client disconnecting.
   */
  function onClientDisconnect(clientId: string): void {
    connectionManager.removeClient(clientId);
  }

  /**
   * Handle an inbound message from a ThunderComm client.
   * Route to the appropriate agent session via the gateway.
   *
   * ORDERING: Gateway receive timestamp is authoritative.
   * Single queue — audio and text share the same path.
   */
  function onInboundMessage(
    clientId: string,
    raw: unknown,
    routeToAgent: (sessionKey: string, text: string, metadata?: Record<string, unknown>) => void,
  ): void {
    const client = connectionManager.getClient(clientId);
    if (!client) return;

    let msg: InboundMessage;
    try {
      msg = raw as InboundMessage;
    } catch {
      client.send({ type: 'error', code: 'INVALID_MESSAGE', message: 'Could not parse message' });
      return;
    }

    if (msg.type === 'subscribe') {
      // Client is requesting history catch-up — handled by history-handler.ts
      // For now: acknowledge
      client.lastMessageId = msg.lastMessageId;
      return;
    }

    if (msg.type === 'message') {
      // Route to agent session
      const targetSession =
        msg.channel === 'direct' && msg.agentId
          ? `agent:main:${msg.agentId}`
          : 'agent:main:main';

      routeToAgent(targetSession, msg.text, {
        idempotencyKey: msg.idempotencyKey,
        channel: 'thundercomm',
        surface: msg.channel,
      });

      // Send thinking indicator to ALL clients immediately
      // This is the gap no other AI app fills — you know it's working before first token
      connectionManager.broadcast({
        type: 'thinking',
        agentId: msg.agentId ?? 'jon',
      });

      return;
    }

    if (msg.type === 'action_response') {
      // Route action response back to the pending action handler
      // TODO: implement action queue in Phase 2
      return;
    }
  }

  /**
   * Deliver an agent response to all connected clients.
   * Called by the gateway after agent responds.
   *
   * WRITE-AHEAD CONTRACT: Transcript append MUST happen before this is called.
   * If this function fails, clients reconnect and catch up from transcript.
   * Truth is never lost — only delivery to active windows may be delayed.
   */
  function deliverAgentResponse(
    agentId: string,
    text: string,
    messageId: string,
    channel: 'team' | 'direct' = 'team',
  ): void {
    const msg: ConversationMessage = {
      type: 'message',
      id: messageId,
      agentId,
      channel,
      text,
      timestamp: Date.now(),
    };

    connectionManager.broadcast(msg);

    // Update last message ID for all clients
    for (const client of connectionManager.getAllClients()) {
      connectionManager.updateLastMessageId(client.id, messageId);
    }
  }

  /**
   * Deliver a system event (non-conversation) to all clients.
   * Used for: GitHub pushes, failover events, Scribe completions, etc.
   * Visually distinct from conversation messages in the UI.
   */
  function deliverSystemEvent(
    category: SystemEventMessage['category'],
    text: string,
  ): void {
    connectionManager.broadcast({
      type: 'system_event',
      category,
      text,
      timestamp: Date.now(),
    });
  }

  return {
    onClientConnect,
    onClientDisconnect,
    onInboundMessage,
    deliverAgentResponse,
    deliverSystemEvent,
    getConnectionManager: () => connectionManager,
  };
}
