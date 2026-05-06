#!/usr/bin/env node
/**
 * ThunderComm Bridge — bridge.mjs
 *
 * Standalone WebSocket server that bridges ThunderComm web clients
 * to the OpenClaw gateway. No TypeScript compilation required.
 *
 * Architecture:
 * - Listens on port 8765 for ThunderComm client connections
 * - On inbound message: dispatches to OpenClaw via `openclaw gateway call chat.send`
 * - Watches session transcript file for new agent responses → broadcasts to clients
 *
 * "Dispatch is a truth seam — write transcript before broadcast"
 *  — Burt's design principle. We read FROM the transcript, not from memory.
 *
 * Jon | ThunderBase | 2026-05-06
 */

import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, watchFile, statSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { createServer } from 'http';

// ── Config ────────────────────────────────────────────────────────────────

const BRIDGE_PORT     = parseInt(process.env.TC_BRIDGE_PORT || '8765', 10);
const GATEWAY_TOKEN   = process.env.TC_GATEWAY_TOKEN || '4ca1100a180ad68a94b004056e56fd39c81bdccb742d2926';
const GATEWAY_URL     = process.env.TC_GATEWAY_URL   || 'ws://localhost:18789';
const SESSION_KEY     = process.env.TC_SESSION_KEY   || 'agent:main:slack:channel:c0anl10aamv';
const SESSIONS_JSON   = process.env.TC_SESSIONS_JSON  || '/home/ubuntu/.openclaw/agents/main/sessions/sessions.json';
const AGENT_ID        = 'jon';

// ── State ─────────────────────────────────────────────────────────────────

const clients = new Map(); // clientId → { ws, deviceId, lastSeen }
let transcriptPath = null;
let transcriptSize  = 0;
let lastMessageId   = null;

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
        broadcastAgentMessage(result.id, result.text, new Date(result.timestamp).getTime());
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

function broadcastAgentMessage(id, text, timestamp) {
  console.log(`[Bridge] Broadcasting agent message: ${text.slice(0, 60)}…`);
  broadcast({
    type: 'message',
    id,
    agentId: AGENT_ID,
    channel: 'team',
    text,
    timestamp: timestamp || Date.now(),
  });
}

// ── Dispatch message to OpenClaw ──────────────────────────────────────────

function dispatchToAgent(text) {
  const idempotencyKey = randomUUID();
  const params = JSON.stringify({
    sessionKey: SESSION_KEY,
    message: text,
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
        broadcast({
          type: 'error',
          code: 'INVALID_MESSAGE',
          message: `Gateway dispatch failed: ${stderr.slice(0, 100)}`,
        });
        reject(new Error(stderr));
      } else {
        console.log('[Bridge] chat.send dispatched:', stdout.trim().slice(0, 80));
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
            messages.push({ id: entry.id, text, timestamp: entry.timestamp, role: 'user' });
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
    
    return recent.map(m => ({
      type: 'message',
      id: m.id,
      agentId: m.role === 'user' ? 'user' : AGENT_ID,
      channel: 'team',
      text: m.text,
      timestamp: new Date(m.timestamp).getTime(),
    }));
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
  
  if (token !== GATEWAY_TOKEN) {
    console.warn('[Bridge] Connection rejected: bad token');
    ws.close(4001, 'Unauthorized');
    return;
  }
  
  const clientId  = randomUUID();
  const deviceId  = url.searchParams.get('deviceId') || clientId.slice(0, 8);
  
  clients.set(clientId, { ws, deviceId, lastSeen: Date.now() });
  console.log(`[Bridge] Client connected: ${deviceId} (${clients.size} total)`);
  
  // Send initial status
  ws.send(JSON.stringify({ type: 'status', gateway: 'connected', sessionWarm: true }));
  
  // Send roster
  ws.send(JSON.stringify({
    type: 'roster',
    agents: [
      { id: 'jon',   name: 'Jon',   status: 'online',  role: 'Technical Director' },
      { id: 'sasha', name: 'Sasha', status: 'offline', role: 'Creative Director' },
      { id: 'mack',  name: 'Mack',  status: 'offline', role: 'Operations' },
      { id: 'rex',   name: 'Rex',   status: 'offline', role: 'AA Automation' },
    ],
  }));
  
  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch {
      ws.send(JSON.stringify({ type: 'error', code: 'INVALID_MESSAGE', message: 'Invalid JSON' }));
      return;
    }
    
    clients.get(clientId).lastSeen = Date.now();
    
    switch (msg.type) {
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
        
        try {
          await dispatchToAgent(text);
          ws.send(JSON.stringify({
            type: 'ack',
            idempotencyKey: msg.idempotencyKey,
            messageId: randomUUID(),
          }));
        } catch (e) {
          // Error already broadcast above
        }
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
  console.log(`[ThunderComm Bridge] WebSocket server on ws://0.0.0.0:${BRIDGE_PORT}`);
  console.log(`[ThunderComm Bridge] Session: ${SESSION_KEY}`);
  console.log(`[ThunderComm Bridge] Gateway: ${GATEWAY_URL}`);
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

console.log('[ThunderComm Bridge] Starting…');
