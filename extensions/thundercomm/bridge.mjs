#!/usr/bin/env node
/**
 * ThunderCommo Bridge — bridge.mjs
 *
 * Standalone WebSocket server that bridges ThunderCommo web clients
 * to the OpenClaw gateway. No TypeScript compilation required.
 *
 * Architecture:
 * - Listens on port 8765 for ThunderCommo client connections
 * - On inbound message: dispatches to OpenClaw via `openclaw gateway call chat.send`
 * - Watches session transcript file for new agent responses → broadcasts to clients
 *
 * "Dispatch is a truth seam — write transcript before broadcast"
 *  — Burt's design principle. We read FROM the transcript, not from memory.
 *
 * Jon | ThunderBase | 2026-05-06
 */

import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, watchFile, statSync, appendFileSync, writeFileSync, existsSync, openSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { createServer } from 'http';

// ── Config ────────────────────────────────────────────────────────────────

const BRIDGE_PORT     = parseInt(process.env.TC_BRIDGE_PORT || '8765', 10);
const GATEWAY_TOKEN   = process.env.TC_GATEWAY_TOKEN || '4ca1100a180ad68a94b004056e56fd39c81bdccb742d2926';
const GATEWAY_URL     = process.env.TC_GATEWAY_URL   || 'ws://localhost:18789';
const SESSION_KEY     = process.env.TC_SESSION_KEY   || 'agent:main:slack:channel:c0anl10aamv';
const SESSIONS_JSON   = process.env.TC_SESSIONS_JSON  || '/home/ubuntu/.openclaw/agents/main/sessions/sessions.json';
const FEDERATION_RELAY = process.env.TC_FEDERATION_RELAY || 'ws://localhost:8767';
const FEDERATION_TOKEN = process.env.TC_FEDERATION_TOKEN || 'jmab-federation-2026';
const AGENT_ID_SELF    = process.env.TC_AGENT_ID || 'jon';

// External user tokens — add new testers here
// Format: token → display name
const EXTERNAL_USERS = {
  'alex-thundercommo-4a365924ea69066effbb9ed88fead6c7': 'Alex',
  'burt-thundercommo-placeholder': 'Burt',
};

// Agents that participate via OpenClaw/Slack and never connect directly to the
// federation relay. They show as online whenever the OpenClaw gateway is healthy,
// so iOS rosters don't render them as offline just because they aren't on the relay.
const OPENCLAW_AGENTS = new Set(
  (process.env.TC_OPENCLAW_AGENTS || 'mack,rex')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

// ── Model info ──────────────────────────────────────────────────────────────

function resolveCurrentModel() {
  try {
    const sessions = JSON.parse(readFileSync(SESSIONS_JSON, 'utf8'));
    const sess = sessions[SESSION_KEY];
    if (sess) {
      const model = sess.model || sess.modelId || resolveDefaultModel();
      return {
        model,
        thinking: sess.thinkingLevel || 'off',
      };
    }
  } catch {}
  return { model: resolveDefaultModel(), thinking: 'off' };
}

function resolveDefaultModel() {
  try {
    const cfg = JSON.parse(readFileSync('/home/ubuntu/.openclaw/openclaw.json', 'utf8'));
    return cfg?.agents?.defaults?.model?.primary || cfg?.agents?.main?.model || cfg?.model || 'anthropic/claude-sonnet-4-6';
  } catch {}
  return 'anthropic/claude-sonnet-4-6';
}


const AGENT_ID        = 'jon';

// ── State ─────────────────────────────────────────────────────────────────

const clients = new Map(); // clientId → { ws, deviceId, lastSeen }
const recentMessages = []; // rolling buffer of recent messages for context
const CONTEXT_BUFFER_SIZE = 3;
const federationPeers = new Set(); // track online federation peers
let transcriptPath = null;
let transcriptSize  = 0;
let lastMessageId   = null;
let lastDispatchChannel = 'tnt'; // track which channel triggered the last dispatch — used for reply routing

// Optimistic gateway health — flipped to false on chat.send failure, back to true on
// the next success. Drives "online" status for OPENCLAW_AGENTS in the roster.
let gatewayHealthy = true;
function setGatewayHealthy(healthy) {
  if (gatewayHealthy === healthy) return;
  gatewayHealthy = healthy;
  console.log(`[Bridge] Gateway health changed → ${healthy ? 'healthy' : 'unhealthy'}`);
  broadcastRoster();
}

// ── Find current session transcript ───────────────────────────────────────

function resolveTranscriptPath() {
  try {
    const sessions = JSON.parse(readFileSync(SESSIONS_JSON, 'utf8'));
    const sess = sessions[SESSION_KEY];
    if (sess && sess.sessionFile) {
      console.log(`[Bridge] Transcript: ${sess.sessionFile}`);
      return sess.sessionFile;
    }
    // Fallback: construct path from sessionId
    if (sess && sess.sessionId) {
      const dir = SESSIONS_JSON.replace('sessions.json', '');
      const path = `${dir}${sess.sessionId}.jsonl`;
      console.log(`[Bridge] Transcript (constructed): ${path}`);
      return path;
    }
  } catch (e) {
    console.error('[Bridge] Could not resolve transcript path:', e.message);
  }
  return null;
}

// ── Read new lines from transcript ─────────────────────────────────────────

function extractAssistantText(line) {
  try {
    const entry = JSON.parse(line);
    if (entry.type !== 'message') return null;
    const msg = entry.message;
    if (!msg) return null;
    
    // Look for assistant text content (not tool calls, not tool results)
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const textParts = msg.content
        .filter(c => c.type === 'text' && c.text && c.text.trim())
        .map(c => c.text.trim());
      if (textParts.length > 0) {
        return { id: entry.id, text: textParts.join('\n'), timestamp: entry.timestamp };
      }
    }
    
    // Also handle simple string content
    if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim()) {
      return { id: entry.id, text: msg.content.trim(), timestamp: entry.timestamp };
    }
  } catch {}
  return null;
}

// Filter out internal/system messages that shouldn't display in UI
function shouldDisplayMessage(text) {
  if (!text) return false;
  const t = text.trim();
  // Skip heartbeat acks
  if (t === 'HEARTBEAT_OK' || t === 'NO_REPLY') return false;
  // Skip system completion notices
  if (t.includes('System (untrusted):') && t.includes('Exec completed')) return false;
  // Skip internal metadata
  if (t.startsWith('System:') && t.includes('async command')) return false;
  return true;
}

function checkTranscriptForNew() {
  if (!transcriptPath) return;
  
  try {
    const stat = statSync(transcriptPath);
    if (stat.size <= transcriptSize) return;
    
    // Read only the new bytes
    const content = readFileSync(transcriptPath, 'utf8');
    const lines = content.split('\n');
    const prevSize = transcriptSize;
    transcriptSize = stat.size;
    
    // Parse all lines, find ones we haven't seen
    // Simple approach: track last seen ID, broadcast any new assistant messages after it
    let broadcasting = lastMessageId === null;
    
    for (const line of lines) {
      if (!line.trim()) continue;
      const result = extractAssistantText(line);
      if (!result) continue;
      
      if (result.id === lastMessageId) {
        broadcasting = true;
        continue;
      }
      
      if (broadcasting) {
        lastMessageId = result.id;
        // Filter out internal messages
        if (shouldDisplayMessage(result.text)) {
          broadcastAgentMessage(result.id, result.text, new Date(result.timestamp).getTime());
        }
      }
    }
    
    // If we never found the last ID (new session or first run), mark the last assistant message as seen
    if (!broadcasting && lines.length > 0) {
      for (const line of [...lines].reverse()) {
        if (!line.trim()) continue;
        const result = extractAssistantText(line);
        if (result) {
          lastMessageId = result.id;
          break;
        }
      }
    }
    
  } catch (e) {
    if (!e.message.includes('ENOENT')) {
      console.error('[Bridge] Transcript read error:', e.message);
    }
  }
}

// ── Broadcast helpers ─────────────────────────────────────────────────────

function broadcast(msg) {
  const json = JSON.stringify(msg);
  for (const [id, client] of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(json);
    }
  }
}

// Track recently broadcast message IDs to prevent duplicates
const recentlyBroadcast = new Set();

function broadcastAgentMessage(id, text, timestamp) {
  // Dedupe: skip if we already broadcast this exact message ID
  if (recentlyBroadcast.has(id)) {
    console.log(`[Bridge] Skipping duplicate broadcast: ${id}`);
    return;
  }
  recentlyBroadcast.add(id);
  // Keep set small — clear old IDs after 100 entries
  if (recentlyBroadcast.size > 100) {
    const firstId = recentlyBroadcast.values().next().value;
    recentlyBroadcast.delete(firstId);
  }
  
  // Reply on the same channel that triggered the dispatch (DM vs #tnt)
  const replyChannel = lastDispatchChannel || 'tnt';
  console.log(`[Bridge] Broadcasting agent message on ${replyChannel}: ${text.slice(0, 60)}…`);
  const msgTimestamp = timestamp || Date.now();
  
  // Broadcast to local web clients
  broadcast({
    type: 'message',
    id,
    agentId: AGENT_ID,
    channel: replyChannel,
    text,
    timestamp: msgTimestamp,
  });
  
  // Federation relay — use tnt for channel messages, direct channel for DMs
  if (federationWs && federationWs.readyState === WebSocket.OPEN) {
    federationWs.send(JSON.stringify({
      type: 'federation_message',
      channel: replyChannel,
      text,
      sender: 'Jon',
      senderType: 'agent',
      agentId: AGENT_ID,
      timestamp: msgTimestamp,
    }));
  }
}

// ── Context buffer ────────────────────────────────────────────────────────

function stripContextEnvelope(text) {
  // Remove "--- Recent context ---\n...\n---\n[Michael]: " wrapper
  // and extract just the actual message
  if (!text.includes('--- Recent context ---')) return text;
  
  const match = text.match(/---\n\[Michael\]:\s*(.+)$/s);
  if (match) return match[1].trim();
  
  // Fallback: take everything after the last "---"
  const parts = text.split('---');
  if (parts.length >= 3) {
    const lastPart = parts[parts.length - 1].trim();
    // Strip leading "[Michael]: " if present
    return lastPart.replace(/^\[Michael\]:\s*/, '').trim();
  }
  
  return text;
}

function addToContextBuffer(sender, text) {
  recentMessages.push({ sender, text, timestamp: Date.now() });
  while (recentMessages.length > CONTEXT_BUFFER_SIZE) {
    recentMessages.shift();
  }
}

function buildContextString(currentText) {
  // Build context from recent messages (excluding the current one)
  if (recentMessages.length === 0) return currentText;
  
  const contextLines = recentMessages
    .slice(0, -1) // exclude the message we just added
    .map(m => `[${m.sender}]: ${m.text}`)
    .join('\n');
  
  if (!contextLines) return currentText;
  return `--- Recent context ---\n${contextLines}\n---\n[Michael]: ${currentText}`;
}

// ── Dispatch message to OpenClaw ──────────────────────────────────────────

function dispatchToAgent(text) {
  const idempotencyKey = randomUUID();
  const messageWithContext = buildContextString(text);
  const params = JSON.stringify({
    sessionKey: SESSION_KEY,
    message: messageWithContext,
    idempotencyKey,
  });
  
  // Show thinking indicator immediately
  broadcast({ type: 'thinking', agentId: AGENT_ID });
  
  return new Promise((resolve, reject) => {
    const child = spawn('openclaw', [
      'gateway', 'call', 'chat.send',
      '--url', GATEWAY_URL,
      '--token', GATEWAY_TOKEN,
      '--params', params,
      '--json',
    ]);
    
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    
    child.on('close', code => {
      if (code !== 0) {
        console.error('[Bridge] chat.send failed:', stderr);
        setGatewayHealthy(false);
        broadcast({
          type: 'error',
          code: 'INVALID_MESSAGE',
          message: `Gateway dispatch failed: ${stderr.slice(0, 100)}`,
        });
        reject(new Error(stderr));
      } else {
        console.log('[Bridge] chat.send dispatched:', stdout.trim().slice(0, 80));
        setGatewayHealthy(true);
        resolve(JSON.parse(stdout || '{}'));
      }
    });
  });
}

// ── Load history from transcript ──────────────────────────────────────────

function loadHistory(limit = 20) {
  if (!transcriptPath) return [];
  try {
    const content = readFileSync(transcriptPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    const messages = [];
    
    for (const line of lines) {
      const result = extractAssistantText(line);
      if (result) messages.push(result);
    }
    
    // Also grab user messages
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'message' && entry.message?.role === 'user') {
          const content = entry.message.content;
          let text = '';
          if (typeof content === 'string') text = content.trim();
          else if (Array.isArray(content)) {
            text = content.filter(c => c.type === 'text').map(c => c.text).join(' ').trim();
          }
          if (text) {
            // Strip context envelope if present
            text = stripContextEnvelope(text);
            if (text) {
              messages.push({ id: entry.id, text, timestamp: entry.timestamp, role: 'user' });
            }
          }
        }
      } catch {}
    }
    
    // Sort by timestamp, return last N
    messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const recent = messages.slice(-limit);
    
    // Mark our position
    const lastAssistant = [...recent].reverse().find(m => !m.role);
    if (lastAssistant) lastMessageId = lastAssistant.id;
    
    return recent.map(m => {
      const msg = {
        type: 'message',
        id: m.id,
        channel: 'tnt',
        text: m.text,
        timestamp: new Date(m.timestamp).getTime(),
      };
      if (m.role === 'user') {
        msg.sender = 'Michael';
      } else {
        msg.agentId = AGENT_ID;
      }
      return msg;
    });
  } catch (e) {
    console.error('[Bridge] History load error:', e.message);
    return [];
  }
}

// ── WebSocket server ──────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: BRIDGE_PORT });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://localhost`);
  const token = url.searchParams.get('token');
  
  // Accept "Michael" as shortcut for full token
  const validTokens = [GATEWAY_TOKEN, 'Michael', 'michael', ...Object.keys(EXTERNAL_USERS)];
  if (!validTokens.includes(token)) {
    console.warn('[Bridge] Connection rejected: bad token');
    ws.close(4001, 'Unauthorized');
    return;
  }
  
  // Determine sender name from token
  const senderName = EXTERNAL_USERS[token] || 'Michael';
  
  const clientId  = randomUUID();
  const deviceId  = url.searchParams.get('deviceId') || clientId.slice(0, 8);
  
  clients.set(clientId, { ws, deviceId, lastSeen: Date.now(), senderName });
  console.log(`[Bridge] Client connected: ${deviceId} (${clients.size} total)`);
  
  // Send initial status
  const modelInfo = resolveCurrentModel();
  ws.send(JSON.stringify({ type: 'status', gateway: 'connected', sessionWarm: true, ...modelInfo }));
  
  // Send roster (dynamic based on federation peers)
  ws.send(JSON.stringify({ type: 'roster', agents: buildRoster() }));
  
  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch {
      ws.send(JSON.stringify({ type: 'error', code: 'INVALID_MESSAGE', message: 'Invalid JSON' }));
      return;
    }
    
    clients.get(clientId).lastSeen = Date.now();
    
    switch (msg.type) {
      case 'ping':
        // Keepalive ping — respond with pong, nothing else
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        return;

      case 'subscribe': {
        // Send recent history
        const history = loadHistory(30);
        ws.send(JSON.stringify({ type: 'history', messages: history, hasMore: false }));
        ws.send(JSON.stringify({ type: 'ack', idempotencyKey: msg.lastMessageId || 'init', messageId: 'history-sent' }));
        break;
      }
      
      case 'message': {
        const text = msg.text?.trim();
        if (!text) break;
        
        const channel = msg.channel || 'tnt';
        
        // Always add to context buffer
        addToContextBuffer('Michael', text);
        
        // Direct messages to other agents go through federation relay
        console.log(`[Bridge] Message received: channel=${channel}, agentId=${msg.agentId}, AGENT_ID_SELF=${AGENT_ID_SELF}`);
        if (channel === 'direct' && msg.agentId && msg.agentId !== AGENT_ID_SELF) {
          console.log(`[Bridge] Routing to federation: direct:${msg.agentId}`);
          // Send thinking indicator for the target agent
          broadcast({ type: 'thinking', agentId: msg.agentId });
          
          // Route through federation relay
          if (federationWs && federationWs.readyState === WebSocket.OPEN) {
            federationWs.send(JSON.stringify({
              type: 'federation_message',
              channel: `direct:${msg.agentId}`,
              text,
              sender: 'Michael',
              timestamp: Date.now(),
            }));
            // Broadcast to local UI as well
            broadcast({
              type: 'message',
              sender: 'Michael',
              channel: `direct:${msg.agentId}`,
              text,
              timestamp: Date.now(),
              idempotencyKey: msg.idempotencyKey,
            });
          }
          ws.send(JSON.stringify({
            type: 'ack',
            idempotencyKey: msg.idempotencyKey,
            messageId: randomUUID(),
          }));
          break;
        }
        
        // Direct message to Jon — dispatch immediately, no mention required
        if (channel === 'direct' && (!msg.agentId || msg.agentId === AGENT_ID_SELF)) {
          // Track channel so reply routes back to the DM thread
          lastDispatchChannel = `direct:${AGENT_ID}`;
          // Ack immediately before dispatching
          ws.send(JSON.stringify({ type: 'ack', idempotencyKey: msg.idempotencyKey, messageId: randomUUID() }));
          broadcast({ type: 'thinking', agentId: AGENT_ID });
          dispatchToAgent(text).catch(() => { /* error already broadcast */ });
          break;
        }

        // Always send TNT messages to federation relay so other agents can see them
        if (channel === 'tnt' && federationWs && federationWs.readyState === WebSocket.OPEN) {
          federationWs.send(JSON.stringify({
            type: 'federation_message',
            channel: 'tnt',
            text,
            sender: 'Michael',
            senderType: 'human',
            timestamp: Date.now(),
          }));
        }
        
        // TNT channel requires mention for Jon — or agentId targeting Jon
        if (channel === 'tnt') {
          const mentionPatterns = ['jon', '@jon', 'Jon', '@Jon'];
          const hasMention = mentionPatterns.some(p => text.includes(p));
          const hasAgentId = msg.agentId && msg.agentId.toLowerCase() === 'jon';
          console.log(`[Bridge] TNT mention check: text="${text.slice(0,50)}", hasMention=${hasMention}, agentId=${msg.agentId}`);
          if (!hasMention && !hasAgentId) {
            // Broadcast human message for display, but don't invoke Jon
            broadcast({
              type: 'message',
              sender: 'Michael',
              channel,
              text,
              timestamp: Date.now(),
              idempotencyKey: msg.idempotencyKey,
            });
            ws.send(JSON.stringify({
              type: 'ack',
              idempotencyKey: msg.idempotencyKey,
              messageId: randomUUID(),
            }));
            break;
          }
        }
        
        // Track channel so reply routes back to #tnt
        lastDispatchChannel = 'tnt';
        // Ack immediately — iOS ack means "received", not "agent replied".
        // Dispatch async so the ack is never delayed by gateway processing time.
        ws.send(JSON.stringify({
          type: 'ack',
          idempotencyKey: msg.idempotencyKey,
          messageId: randomUUID(),
        }));
        dispatchToAgent(text).catch(() => { /* error already broadcast */ });
        break;
      }
      
      default:
        ws.send(JSON.stringify({ type: 'error', code: 'INVALID_MESSAGE', message: `Unknown: ${msg.type}` }));
    }
  });
  
  ws.on('close', () => {
    clients.delete(clientId);
    console.log(`[Bridge] Client disconnected: ${deviceId} (${clients.size} remaining)`);
  });
  
  ws.on('error', (err) => {
    console.error(`[Bridge] Client error ${deviceId}:`, err.message);
    clients.delete(clientId);
  });
});

wss.on('listening', () => {
  console.log(`[ThunderCommo Bridge] WebSocket server on ws://0.0.0.0:${BRIDGE_PORT}`);
  console.log(`[ThunderCommo Bridge] Session: ${SESSION_KEY}`);
  console.log(`[ThunderCommo Bridge] Gateway: ${GATEWAY_URL}`);
});

wss.on('error', err => console.error('[Bridge] Server error:', err));

// ── Transcript watcher ────────────────────────────────────────────────────

transcriptPath = resolveTranscriptPath();
if (transcriptPath) {
  try {
    transcriptSize = statSync(transcriptPath).size;
  } catch {}
  
  // Initialize lastMessageId from existing transcript
  loadHistory(1); // just to set lastMessageId
  
  // Watch for changes (poll every 500ms — fs.watch can miss events on EC2)
  setInterval(checkTranscriptForNew, 500);
  console.log(`[Bridge] Watching transcript: ${transcriptPath}`);
} else {
  console.warn('[Bridge] No transcript path found — responses will not be delivered');
}

// Re-resolve transcript path periodically (in case session resets)
setInterval(() => {
  const newPath = resolveTranscriptPath();
  if (newPath && newPath !== transcriptPath) {
    console.log(`[Bridge] Transcript path changed: ${newPath}`);
    transcriptPath = newPath;
    try { transcriptSize = statSync(transcriptPath).size; } catch {}
    lastMessageId = null;
    loadHistory(1);
  }
}, 30000);

// ── CLI Jon launcher (trigger-file watcher) ──────────────────────────────
//
// When /home/ubuntu/cli-jon-trigger.txt is written with a non-empty body,
// spawn CLI Jon (`claude`) as a detached child using that body as the
// prompt, then clear the trigger so the next write fires again. Lets Jon
// launch CLI Jon from any channel (Slack, ThunderCommo, WhatsApp) by
// writing to the trigger file — the bridge is a long-lived systemd
// service and is not subject to the per-message exec sandbox that
// constrains the agent itself.

const CLI_JON_TRIGGER_FILE = process.env.TC_CLI_JON_TRIGGER || '/home/ubuntu/cli-jon-trigger.txt';
const CLI_JON_LAUNCHER_LOG = process.env.TC_CLI_JON_LOG || '/tmp/cli-jon-launcher.log';
const CLI_JON_BIN          = process.env.TC_CLI_JON_BIN || '/home/ubuntu/.npm-global/bin/claude';
const CLI_JON_CWD          = process.env.TC_CLI_JON_CWD || '/home/ubuntu';

function appendLauncherLog(line) {
  try {
    appendFileSync(CLI_JON_LAUNCHER_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch (err) {
    console.warn(`[Launcher] log write failed: ${err.message}`);
  }
}

function handleTriggerChange(curr, prev) {
  // Skip if size is zero (we clear after firing) or nothing changed.
  if (curr.size === 0) return;
  if (curr.size === prev.size && curr.mtimeMs === prev.mtimeMs) return;

  let prompt = '';
  try {
    prompt = readFileSync(CLI_JON_TRIGGER_FILE, 'utf8').trim();
  } catch (err) {
    appendLauncherLog(`read trigger failed: ${err.message}`);
    return;
  }
  if (!prompt) return;

  appendLauncherLog(`fired with prompt (${prompt.length} chars): ${prompt.slice(0, 120).replace(/\n/g, ' ')}`);

  let child;
  try {
    const logFile = `${CLI_JON_LAUNCHER_LOG}.${Date.now()}.out`;
    const logFd = openSync(logFile, 'a');
    child = spawn(CLI_JON_BIN, ['--dangerously-skip-permissions', '-p', prompt], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: CLI_JON_CWD,
      env: { ...process.env, PATH: `/home/ubuntu/.npm-global/bin:${process.env.PATH}` },
    });
    child.unref();
  } catch (err) {
    appendLauncherLog(`spawn failed: ${err.message}`);
    return;
  }
  appendLauncherLog(`spawned PID ${child.pid}`);

  // Clear the trigger so the next write is detected as a state change.
  try {
    writeFileSync(CLI_JON_TRIGGER_FILE, '');
  } catch (err) {
    appendLauncherLog(`clear trigger failed: ${err.message}`);
  }
}

// Ensure the trigger file exists so watchFile has something to poll.
try {
  if (!existsSync(CLI_JON_TRIGGER_FILE)) {
    writeFileSync(CLI_JON_TRIGGER_FILE, '');
  }
} catch (err) {
  console.warn(`[Launcher] could not initialize trigger file: ${err.message}`);
}

watchFile(CLI_JON_TRIGGER_FILE, { interval: 2000, persistent: false }, handleTriggerChange);
console.log(`[Launcher] watching ${CLI_JON_TRIGGER_FILE} (poll 2s) → spawns ${CLI_JON_BIN}`);

console.log('[ThunderCommo Bridge] Starting…');

// ── Federation connection (for peer status) ──────────────────────────────

let federationWs = null;

function connectToRelay() {
  if (federationWs && federationWs.readyState === WebSocket.OPEN) return;
  
  console.log(`[Federation] Connecting to relay: ${FEDERATION_RELAY}`);
  
  try {
    federationWs = new WebSocket(FEDERATION_RELAY);
  } catch (e) {
    console.error(`[Federation] Connection error: ${e.message}`);
    setTimeout(connectToRelay, 5000);
    return;
  }
  
  federationWs.on('open', () => {
    console.log('[Federation] Connected to relay');
    // Authenticate
    federationWs.send(JSON.stringify({
      type: 'federation_auth',
      token: FEDERATION_TOKEN,
      peerId: `thunderbase-${AGENT_ID_SELF}`,
      channels: ['tnt', 'jmab', 'direct:jon', 'direct:michael'],
      model: resolveCurrentModel().model,
    }));
  });
  
  federationWs.on('message', (data) => {
    lastRelayActivity = Date.now();
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'federation_status') {
        console.log(`[Federation] Status: ${msg.status}, peers: ${msg.peers?.join(', ')}`);
        updatePeersFromRelay(msg.peers || [], msg.models || {});
      }
      
      if (msg.type === 'federation_peers') {
        console.log(`[Federation] Peers updated: ${msg.peers?.join(', ')}`);
        updatePeersFromRelay(msg.peers || [], msg.models || {});
      }
      
      // Forward typing/thinking to web clients
      if (msg.type === 'typing' || msg.type === 'thinking') {
        broadcast(msg);
      }
      
      // Forward federated messages to web clients
      if (msg.type === 'federation_message') {
        // Skip messages that originated from us — we already broadcast them directly
        const fromSelf = msg.originPeer && msg.originPeer.includes('thunderbase');
        if (!fromSelf) {
          broadcast({
            type: 'message',
            agentId: msg.agentId || msg.originPeer,
            sender: msg.senderType === 'human' ? msg.sender : null,
            channel: msg.channel,
            text: msg.text,
            timestamp: msg.timestamp || Date.now(),
          });
        }
        
        // Check if Jon should respond
        const text = msg.text || '';
        const mentionPatterns = ['jon', '@jon', 'Jon', '@Jon'];
        const hasMention = mentionPatterns.some(p => text.includes(p));
        const targetedAgent = msg.agentId ? String(msg.agentId).toLowerCase() : null;
        const normalizedChannel = String(msg.channel || '').toLowerCase();
        const isDirect = normalizedChannel === 'direct:jon' || (normalizedChannel === 'direct' && targetedAgent === 'jon');
        const isTargetedTnt = (normalizedChannel === 'tnt' || normalizedChannel === 'team') && targetedAgent === 'jon';

        if ((hasMention || isDirect || isTargetedTnt) && msg.originPeer && !msg.originPeer.includes('thunderbase')) {
          // Message from another agent/peer mentions Jon, targets him in #tnt, or is a direct DM
          const reason = isDirect ? 'DM' : isTargetedTnt ? 'targeted #tnt' : 'mention';
          console.log(`[Federation] ${reason} from ${msg.sender || msg.originPeer}, dispatching`);
          const envelope = `[${msg.sender || msg.originPeer}] [#${msg.channel}] [TO:jon]: ${text}`;
          dispatchToAgent(envelope);
        }
      }
    } catch {}
  });
  
  federationWs.on('close', () => {
    console.log('[Federation] Disconnected from relay');
    federationPeers.clear();
    broadcastRoster();
    setTimeout(connectToRelay, 5000);
  });
  
  federationWs.on('error', (e) => {
    console.error(`[Federation] Error: ${e.message}`);
  });
}

const federationPeerModels = {}; // peerId -> model

function updatePeersFromRelay(peerList, models = {}) {
  federationPeers.clear();
  // Clear old models, then update
  Object.keys(federationPeerModels).forEach(k => delete federationPeerModels[k]);
  Object.assign(federationPeerModels, models);
  
  for (const peer of peerList) {
    // peer format: "mac-mack", "thunderbase-jon", etc.
    const agentMatch = peer.match(/-(\w+)$/);
    if (agentMatch) {
      federationPeers.add(agentMatch[1].toLowerCase());
    }
  }
  broadcastRoster();
}

function getModelForPeer(peerId) {
  // Look up model by full peer ID (e.g., "mac-mack")
  for (const [key, model] of Object.entries(federationPeerModels)) {
    if (key.endsWith(`-${peerId}`)) return model;
  }
  return null;
}

function buildRoster() {
  const currentModel = resolveCurrentModel().model;
  // Federation relay = strongest signal. OpenClaw-known agents (Mack/Rex) reach us
  // through the OpenClaw gateway / Slack — never the relay — so absence from the
  // federation peer list does NOT mean they're offline.
  const isOnline = (id) =>
    federationPeers.has(id) || (gatewayHealthy && OPENCLAW_AGENTS.has(id));
  return [
    { id: 'jon',   name: 'Jon',   status: federationPeers.has('jon') || AGENT_ID_SELF === 'jon' ? 'online' : 'offline', role: 'Technical Director', model: currentModel },
    { id: 'mack',  name: 'Mack',  status: isOnline('mack') ? 'online' : 'offline', role: 'Operations', model: getModelForPeer('mack') || 'openai/gpt-5.4-mini' },
    { id: 'rex',   name: 'Rex',   status: isOnline('rex') ? 'online' : 'offline', role: 'AA Automation' },
  ];
}

function broadcastRoster() {
  const roster = buildRoster();
  broadcast({ type: 'roster', agents: roster });
}

// Connect to federation relay
connectToRelay();

// Federation keepalive — ping relay every 30s, force reconnect if stale
let lastRelayActivity = Date.now();

setInterval(() => {
  if (federationWs && federationWs.readyState === WebSocket.OPEN) {
    try {
      federationWs.ping();
      lastRelayActivity = Date.now();
    } catch {}
  } else if (Date.now() - lastRelayActivity > 45000) {
    // Stale or dead — force reconnect
    console.log('[Federation] Stale connection detected, reconnecting...');
    if (federationWs) { try { federationWs.terminate(); } catch {} federationWs = null; }
    connectToRelay();
  }
}, 30000);


