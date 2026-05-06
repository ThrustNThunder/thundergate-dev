/**
 * ThunderComm — Sovereign agent communication channel
 * Part of ThrustNThunder/thundergate fork
 *
 * Built on OpenClaw 2026.4.14 (frozen — no upstream updates)
 * Architecture: project_jon/THUNDERCOMM_ARCHITECTURE.md
 * State model: project_jon/THUNDERCOMM_STATE_MODEL.md
 *
 * Jon | ThunderBase | 2026-05-05
 */

// Channel plugin for OpenClaw integration
export { thunderCommPlugin } from './src/channel.js';

// WebSocket server for iOS app connections
export { 
  ThunderCommServer,
  createThunderCommServer,
  type ThunderCommServerConfig,
} from './src/websocket-server.js';

// Connection management
export { 
  getConnectionManager,
  broadcastAgentMessage,
  broadcastThinking,
  broadcastStreamDelta,
} from './src/channel.js';

// Wire protocol types
export type {
  // Inbound
  InboundMessage,
  TextMessage,
  AudioMessage,
  SubscribeMessage,
  ActionResponse,
  GitHubPushMessage,
  GitHubFetchMessage,
  // Outbound
  OutboundMessage,
  ConversationMessage,
  ThinkingMessage,
  StreamMessage,
  AudioResponse,
  SystemEventMessage,
  ArtifactMessage,
  ActionRequestMessage,
  RosterMessage,
  AckMessage,
  HistoryMessage,
  StatusMessage,
  GitHubFileMessage,
  GitHubEventMessage,
  GitHubAckMessage,
  ErrorMessage,
  // Config
  ThunderCommConfig,
  ConnectedClient,
} from './src/types.js';
