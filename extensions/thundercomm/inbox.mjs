/**
 * ThunderCommo Relay — Server-Side Message Inbox API
 *
 * Holds messages for offline users. iOS drains this on every foreground.
 *
 * Endpoints:
 *   GET  /api/inbox?since=<timestamp>  — fetch messages since timestamp
 *   POST /api/messages                 — send a message (stored + forwarded)
 *   POST /api/devices/token            — register APNs device token
 *   GET  /api/inbox/status             — inbox health check
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import * as os from 'os';

const INBOX_DIR = join(os.homedir(), '.thundergate', 'inbox');
const TOKENS_FILE = join(os.homedir(), '.thundergate', 'device-tokens.json');

// In-memory inbox — keyed by token (user identifier)
const inbox = new Map(); // token → [{ id, content, sender, timestamp, channel }]

// Device tokens for APNs — keyed by gateway token
const deviceTokens = new Map(); // gatewayToken → [apnsToken]

// Load persisted tokens
function loadTokens() {
  if (existsSync(TOKENS_FILE)) {
    try {
      const data = JSON.parse(readFileSync(TOKENS_FILE, 'utf-8'));
      for (const [k, v] of Object.entries(data)) {
        deviceTokens.set(k, v);
      }
    } catch {}
  }
}

function saveTokens() {
  const obj = {};
  for (const [k, v] of deviceTokens) obj[k] = v;
  writeFileSync(TOKENS_FILE, JSON.stringify(obj, null, 2));
}

loadTokens();

/**
 * Store a message in the inbox for a token
 */
export function storeInbox(token, message) {
  if (!inbox.has(token)) inbox.set(token, []);
  const messages = inbox.get(token);
  messages.push({
    id: message.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    content: message.content || message.text,
    sender: message.sender,
    channel: message.channel || 'tnt',
    timestamp: message.timestamp || Date.now()
  });

  // Keep last 500 messages per user
  if (messages.length > 500) messages.splice(0, messages.length - 500);
}

/**
 * Get messages for a token since a timestamp
 */
export function getInbox(token, since = 0) {
  const messages = inbox.get(token) || [];
  return messages.filter(m => m.timestamp > since);
}

/**
 * Register APNs device token for a gateway token
 */
export function registerDeviceToken(gatewayToken, apnsToken) {
  const tokens = deviceTokens.get(gatewayToken) || [];
  if (!tokens.includes(apnsToken)) {
    tokens.push(apnsToken);
    deviceTokens.set(gatewayToken, tokens);
    saveTokens();
  }
}

/**
 * Get APNs tokens for a gateway token
 */
export function getDeviceTokens(gatewayToken) {
  return deviceTokens.get(gatewayToken) || [];
}

/**
 * Create the inbox HTTP server
 */
export function createInboxServer(port = 8768) {
  const server = createServer((req, res) => {
    // CORS headers for iOS app
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth: Bearer token
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace('Bearer ', '').trim();

    const url = new URL(req.url, `http://localhost:${port}`);

    // GET /api/inbox?since=<timestamp>
    if (req.method === 'GET' && url.pathname === '/api/inbox') {
      if (!token) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const since = parseInt(url.searchParams.get('since') || '0');
      const messages = getInbox(token, since);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        messages,
        count: messages.length,
        serverTime: Date.now()
      }));
      return;
    }

    // POST /api/messages
    if (req.method === 'POST' && url.pathname === '/api/messages') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const message = JSON.parse(body);

          // Store in inbox for the recipient
          if (message.to) {
            storeInbox(message.to, message);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, id: message.id }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'invalid JSON' }));
        }
      });
      return;
    }

    // POST /api/devices/token
    if (req.method === 'POST' && url.pathname === '/api/devices/token') {
      if (!token) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { apnsToken, environment } = JSON.parse(body);
          if (!apnsToken) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'apnsToken required' }));
            return;
          }

          registerDeviceToken(token, apnsToken);
          console.log(`[Inbox] APNs token registered for gateway token ...${token.slice(-8)}`);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/inbox/status
    if (req.method === 'GET' && url.pathname === '/api/inbox/status') {
      let totalMessages = 0;
      for (const msgs of inbox.values()) totalMessages += msgs.length;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        users: inbox.size,
        totalMessages,
        deviceTokens: deviceTokens.size,
        serverTime: Date.now()
      }));
      return;
    }

    // 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(port, () => {
    console.log(`[Inbox] Message inbox API listening on :${port}`);
  });

  return server;
}
