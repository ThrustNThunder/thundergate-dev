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
          const payload = JSON.parse(body); const apnsToken = payload.apnsToken || payload.device_token;
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

    // Auth routes
    if (url.pathname.startsWith('/api/auth/')) {
      if (handleAuthRequest(req, res, url)) return;
    }

    // Additional endpoints
    if (handleMissingEndpoints(req, res, url, token)) return;

    // 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(port, () => {
    console.log(`[Inbox] Message inbox API listening on :${port}`);
  });

  return server;
}

/**
 * User account endpoints (for ThunderCommo iOS auth)
 * 
 * POST /api/auth/signup   — create account
 * POST /api/auth/signin   — sign in, returns token
 * GET  /api/auth/me       — get current user
 * POST /api/auth/refresh  — refresh token
 */

import { createHash, randomBytes } from 'crypto';

// In-memory user store (will move to SQLite in Phase 3)
const users = new Map(); // email → { id, email, displayName, phone, role, passwordHash, salt, agents[] }
const sessions = new Map(); // token → { userId, expiresAt }

// Pre-seed Michael as admin
const michaelSalt = randomBytes(16).toString('hex');
users.set('thrustnthunder1@gmail.com', {
  id: 'michael-lovell-admin',
  email: 'thrustnthunder1@gmail.com',
  displayName: 'Michael',
  phone: '7193388327',
  role: 'admin',
  salt: michaelSalt,
  passwordHash: hashPassword('RUsty1234!@#$', michaelSalt), // Updated May 10 2026
  agents: [{
    id: 'jon-agent',
    agentName: 'Jon',
    agentEmoji: '⚡',
    wsURL: 'wss://thunderai.us',
    httpURL: 'https://thunderai.us',
    token: '4ca1100a180ad68a94b004056e56fd39c81bdccb742d2926',
    isDefault: true
  }],
  createdAt: new Date().toISOString()
});

function hashPassword(password, salt) {
  return createHash('sha256').update(password + salt).digest('hex');
}

function generateToken() {
  return randomBytes(32).toString('hex');
}

export function handleAuthRequest(req, res, url) {
  // POST /api/auth/signup
  if (req.method === 'POST' && url.pathname === '/api/auth/signup') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { email, password, displayName, phone } = JSON.parse(body);
        
        if (!email || !password || !displayName) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'email, password, displayName required' }));
          return;
        }
        
        if (users.has(email.toLowerCase())) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Account already exists' }));
          return;
        }
        
        const salt = randomBytes(16).toString('hex');
        const user = {
          id: `user-${randomBytes(8).toString('hex')}`,
          email: email.toLowerCase(),
          displayName,
          phone: phone || null,
          role: 'user',
          salt,
          passwordHash: hashPassword(password, salt),
          agents: [],
          createdAt: new Date().toISOString()
        };
        
        users.set(email.toLowerCase(), user);
        
        // Generate session token
        const token = generateToken();
        sessions.set(token, {
          userId: user.id,
          email: user.email,
          expiresAt: Date.now() + (30 * 24 * 3600 * 1000) // 30 days
        });
        
        // Register in bridge's external users

        
        console.log(`[Auth] New account: ${email} (${displayName})`);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          token,
          user: { id: user.id, email: user.email, displayName, role: user.role }
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return true;
  }

  // POST /api/auth/signin
  if (req.method === 'POST' && url.pathname === '/api/auth/signin') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { email, password } = JSON.parse(body);
        const user = users.get(email?.toLowerCase());
        
        if (!user || hashPassword(password, user.salt) !== user.passwordHash) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid email or password' }));
          return;
        }
        
        const token = generateToken();
        sessions.set(token, {
          userId: user.id,
          email: user.email,
          expiresAt: Date.now() + (30 * 24 * 3600 * 1000)
        });
        

        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          token,
          user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role, agents: user.agents }
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return true;
  }

  // POST /api/auth/refresh
  if (req.method === 'POST' && url.pathname === '/api/auth/refresh') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace('Bearer ', '').trim();
    const session = sessions.get(token);
    
    if (!session || session.expiresAt < Date.now()) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or expired token' }));
      return true;
    }
    
    // Extend session
    session.expiresAt = Date.now() + (30 * 24 * 3600 * 1000);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token, expiresAt: session.expiresAt }));
    return true;
  }

  // GET /api/auth/me
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace('Bearer ', '').trim();
    const session = sessions.get(token);
    
    if (!session || session.expiresAt < Date.now()) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    
    const user = [...users.values()].find(u => u.id === session.userId);
    if (!user) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'User not found' }));
      return true;
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: user.id, email: user.email, displayName: user.displayName,
      role: user.role, agents: user.agents, phone: user.phone
    }));
    return true;
  }

  return false; // Not handled
}

/**
 * Additional endpoints wired into createInboxServer request handler
 * Called from inside the server's request handler via handleMissingEndpoints()
 */

export function handleMissingEndpoints(req, res, url, token) {

  // POST /api/inbox/ack — acknowledge (clear) specific message IDs
  if (req.method === 'POST' && url.pathname === '/api/inbox/ack') {
    if (!token) { res.writeHead(401); res.end(JSON.stringify({ error: 'unauthorized' })); return true; }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { ids } = JSON.parse(body);
        const messages = inbox.get(token) || [];
        const filtered = messages.filter(m => !ids.includes(m.id));
        inbox.set(token, filtered);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, removed: messages.length - filtered.length }));
      } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid JSON' })); }
    });
    return true;
  }

  // POST /api/messages — send a message, store in recipient inbox + fan out
  if (req.method === 'POST' && url.pathname === '/api/messages') {
    if (!token) { res.writeHead(401); res.end(JSON.stringify({ error: 'unauthorized' })); return true; }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const message = JSON.parse(body);
        const id = message.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const stored = {
          id,
          sender: token.slice(0, 8), // sender identified by token prefix
          content: message.body || message.content || message.text || '',
          channel: message.channel || 'tnt',
          timestamp: Date.now()
        };

        // Store in recipient's inbox if 'to' specified
        if (message.to) {
          storeInbox(message.to, stored);
        }

        // Also store in sender's outbox for sync
        storeInbox(token, { ...stored, fromSelf: true });

        console.log(`[Inbox] Message ${id} stored for ${message.to || 'broadcast'}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id }));
      } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid JSON' })); }
    });
    return true;
  }

  // POST /api/devices/token — register APNs device token
  if (req.method === 'POST' && url.pathname === '/api/devices/token') {
    if (!token) { res.writeHead(401); res.end(JSON.stringify({ error: 'unauthorized' })); return true; }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { device_token, apnsToken, platform, bundle_id } = JSON.parse(body);
        const apns = device_token || apnsToken;
        if (!apns) { res.writeHead(400); res.end(JSON.stringify({ error: 'device_token required' })); return; }
        registerDeviceToken(token, apns);
        console.log(`[Inbox] APNs token registered: ...${apns.slice(-8)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid JSON' })); }
    });
    return true;
  }

  // GET /api/agent/identity — KYA agent identity for verification
  if (req.method === 'GET' && url.pathname === '/api/agent/identity') {
    // Returns Jon's identity for KYA verification step
    const fingerprint = 'thunder-echo-lima-foxtrot'; // human-readable identity hash
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      agentId: 'jon-thunderbase-001',
      displayName: 'Jon',
      emoji: '⚡',
      role: 'Technical Director',
      fingerprint,
      version: '1.0',
      gatewayURL: 'wss://thunderai.us',
      verifiedAt: null // set when user completes KYA
    }));
    return true;
  }

  return false;
}
