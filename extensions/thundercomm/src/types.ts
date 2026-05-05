/**
 * ThunderComm wire protocol types
 * Four message categories (per Burt's architecture review, May 5 2026):
 *   1. conversation  — text/audio exchanges
 *   2. system_event  — gateway/infra notifications (not conversation)
 *   3. artifact      — files, docs, repo content surfaced inline
 *   4. action_request — structured decisions requiring a response
 */

// ── Inbound (App → Gateway) ──────────────────────────────────────────────────

export type InboundMessage =
  | TextMessage
  | AudioMessage
  | SubscribeMessage
  | ActionResponse
  | GitHubPushMessage
  | GitHubFetchMessage;

export interface TextMessage {
  type: 'message';
  channel: 'team' | 'direct';
  agentId?: string; // required when channel = 'direct'
  text: string;
  idempotencyKey: string;
}

export interface AudioMessage {
  type: 'audio';
  channel: 'team' | 'direct';
  agentId?: string;
  data: string; // base64-encoded audio
  idempotencyKey: string;
}

export interface SubscribeMessage {
  type: 'subscribe';
  lastMessageId: string | null; // null = last N messages per config
}

export interface ActionResponse {
  type: 'action_response';
  id: string; // matches ActionRequest.id
  value: string; // e.g. 'approve' | 'cancel' | 'review'
  idempotencyKey: string;
}

export interface GitHubPushMessage {
  type: 'github_push';
  repo: string;
  path: string;
  content: string; // base64-encoded
  message: string; // commit message
  idempotencyKey: string;
}

export interface GitHubFetchMessage {
  type: 'github_fetch';
  repo: string;
  path: string;
  ref?: string; // default: 'main'
}

// ── Outbound (Gateway → App) ─────────────────────────────────────────────────

export type OutboundMessage =
  | ConversationMessage
  | ThinkingMessage
  | StreamMessage
  | AudioResponse
  | RosterMessage
  | AckMessage
  | HistoryMessage
  | StatusMessage
  | SystemEventMessage
  | ArtifactMessage
  | ActionRequestMessage
  | GitHubFileMessage
  | GitHubEventMessage
  | GitHubAckMessage
  | ErrorMessage;

/** 1. Conversation UI */
export interface ConversationMessage {
  type: 'message';
  id: string;
  agentId: string;
  channel: 'team' | 'direct';
  text: string;
  timestamp: number;
}

export interface ThinkingMessage {
  type: 'thinking';
  agentId: string;
}

export interface StreamMessage {
  type: 'stream';
  agentId: string;
  delta: string; // one token/word
}

export interface AudioResponse {
  type: 'audio';
  agentId: string;
  url: string;
  duration: number; // seconds
}

/** 2. System Event UI */
export interface SystemEventMessage {
  type: 'system_event';
  category: 'github' | 'failover' | 'scribe' | 'gateway' | 'beekeepeer';
  text: string;
  timestamp: number;
}

/** 3. Artifact UI */
export interface ArtifactMessage {
  type: 'artifact';
  kind: 'github_file' | 'memory_entry' | 'spec_doc';
  title: string;
  source: string;
  content: string; // base64-encoded
  sha?: string;
  timestamp: number;
}

/** 4. Action/Approval UI */
export interface ActionRequestMessage {
  type: 'action_request';
  id: string;
  agentId: string;
  description: string;
  actions: Array<{ label: string; value: string }>;
  context?: string;
  timestamp: number;
}

/** Infrastructure */
export interface RosterMessage {
  type: 'roster';
  agents: Array<{
    id: string;
    name: string;
    status: 'online' | 'offline' | 'busy';
    role?: string;
  }>;
}

export interface AckMessage {
  type: 'ack';
  idempotencyKey: string;
  messageId: string;
}

export interface HistoryMessage {
  type: 'history';
  messages: ConversationMessage[];
  hasMore: boolean;
}

export interface StatusMessage {
  type: 'status';
  gateway: 'connected' | 'reconnecting' | 'offline';
  sessionWarm: boolean;
}

export interface GitHubFileMessage {
  type: 'github_file';
  repo: string;
  path: string;
  content: string; // base64-encoded
  sha: string;
  timestamp: number;
}

export interface GitHubEventMessage {
  type: 'github_event';
  repo: string;
  event: 'push' | 'pr' | 'comment';
  author: string;
  message: string;
  files: string[];
  timestamp: number;
}

export interface GitHubAckMessage {
  type: 'github_ack';
  repo: string;
  path: string;
  sha: string;
  idempotencyKey: string;
}

export interface ErrorMessage {
  type: 'error';
  code: 'AUTH_FAILED' | 'RATE_LIMITED' | 'INVALID_MESSAGE' | 'REPO_NOT_ALLOWED' | 'CONFLICT';
  message: string;
}

// ── Config ───────────────────────────────────────────────────────────────────

export interface ThunderCommConfig {
  tts?: boolean;
  agents?: string[];
  maxHistoryOnConnect?: 25 | 50 | 100;
}

// ── Connection state ─────────────────────────────────────────────────────────

export interface ConnectedClient {
  id: string;
  deviceId: string;
  sessionKey: string;
  lastSeen: number;
  lastMessageId: string | null;
  send: (msg: OutboundMessage) => void;
}
