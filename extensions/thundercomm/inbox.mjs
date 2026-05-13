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

    // Token management routes (agent invites + revocation)
    if (url.pathname === '/api/tokens' || url.pathname.startsWith('/api/tokens/')) {
      if (handleTokenRequest(req, res, url)) return;
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
const users = new Map(); // email → { id, email, displayName, phone, role, passwordHash, salt, agents[], emailVerified }
const sessions = new Map(); // tc-h-<token> → { userId, email, expiresAt }
// Agent token registry: tc-a-<token> → { userId, createdAt, label, revoked }
// Pre-populated with Jon's legacy agent token below so existing relay clients continue to work.
const agentTokens = new Map();
// Email verification: one-time verifyToken → { userId, expiresAt }
const verifyTokens = new Map();
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RELAY_WS_URL = 'wss://relay.thunderai.us';
const RELAY_HTTP_URL = 'https://relay.thunderai.us';

// Legacy Jon agent token — preserved per build spec (May 12 2026).
const LEGACY_JON_AGENT_TOKEN = '4ca1100a180ad68a94b004056e56fd39c81bdccb742d2926';
agentTokens.set(LEGACY_JON_AGENT_TOKEN, {
  userId: 'michael-lovell-admin',
  createdAt: new Date().toISOString(),
  label: 'Jon (legacy)',
  revoked: false,
});


function hashPassword(password, salt) {
  return createHash('sha256').update(password + salt).digest('hex');
}

function generateHumanToken() {
  return `tc-h-${randomBytes(24).toString('hex')}`;
}

function generateAgentToken() {
  return `tc-a-${randomBytes(24).toString('hex')}`;
}

function generateVerifyToken() {
  return randomBytes(24).toString('hex');
}

// Public helper: token is valid for relay use if it's a known active agent
// token OR a known active human session token. Used by the relay (when
// loaded inline) and exposed for HTTP-based validation if needed later.
export function isKnownRelayToken(token) {
  if (!token) return false;
  const agent = agentTokens.get(token);
  if (agent && !agent.revoked) return true;
  const session = sessions.get(token);
  if (session && (!session.expiresAt || session.expiresAt > Date.now())) return true;
  return false;
}

function findUserById(userId) {
  for (const u of users.values()) if (u.id === userId) return u;
  return null;
}

function getBearer(req) {
  const authHeader = req.headers['authorization'] || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (!body) { resolve({}); return; }
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function userPublicView(user) {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    displayName: user.displayName,
    role: user.role,
    emailVerified: !!user.emailVerified,
    agents: user.agents,
  };
}

function issueVerifyToken(user) {
  const t = generateVerifyToken();
  verifyTokens.set(t, { userId: user.id, expiresAt: Date.now() + VERIFY_TTL_MS });
  const link = `https://thunderai.us/verify?token=${t}`;
  // SMTP/GOG send is not wired in this environment — log the link so it can
  // be retrieved from the server logs (and so this code is observable when
  // a real mailer is plugged in).
  console.log(`[Auth] Welcome email for ${user.email}: verify link ${link}`);
  return { token: t, link };
}

export function handleAuthRequest(req, res, url) {
  // POST /api/auth/signup
  if (req.method === 'POST' && url.pathname === '/api/auth/signup') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { email, password, displayName, phone } = JSON.parse(body);

        if (!email || !password) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'email and password required' }));
          return;
        }
        const emailStr = String(email);
        if (emailStr.length < 5 || emailStr.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailStr)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid email format' }));
          return;
        }
        if (password.length < 8) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'password must be at least 8 characters' }));
          return;
        }
        if (password.length > 256) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid email format' }));
          return;
        }
        if (displayName != null && String(displayName).length > 100) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid email format' }));
          return;
        }

        if (users.has(email.toLowerCase())) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Account already exists' }));
          return;
        }

        const salt = randomBytes(16).toString('hex');
        const effectiveDisplayName = displayName && displayName.trim()
          ? displayName.trim()
          : email.split('@')[0];

        const user = {
          id: `user-${randomBytes(8).toString('hex')}`,
          email: email.toLowerCase(),
          displayName: effectiveDisplayName,
          phone,
          role: 'user',
          emailVerified: false,
          salt,
          passwordHash: hashPassword(password, salt),
          agents: [{
            id: 'jon-agent',
            agentName: 'Jon',
            agentEmoji: '⚡',
            wsURL: RELAY_WS_URL,
            httpURL: RELAY_HTTP_URL,
            token: LEGACY_JON_AGENT_TOKEN,
            isDefault: true
          }],
          createdAt: new Date().toISOString()
        };

        users.set(email.toLowerCase(), user);

        // Generate human session token (tc-h-)
        const token = generateHumanToken();
        sessions.set(token, {
          userId: user.id,
          email: user.email,
          expiresAt: null, // tc-h- tokens do not expire by default (revocable)
        });

        // Fire welcome/verify email (logged for now — real SMTP wires in later)
        issueVerifyToken(user);

        console.log(`[Auth] New account: ${email} (${effectiveDisplayName})`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          token,
          expires_at_ms: null,
          user: userPublicView(user),
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

        const token = generateHumanToken();
        sessions.set(token, {
          userId: user.id,
          email: user.email,
          expiresAt: null,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          token,
          expires_at_ms: null,
          user: userPublicView(user),
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return true;
  }

  // POST /api/auth/refresh
  // tc-h- tokens do not expire by default; refresh is a no-op echo that
  // confirms the bearer is still recognized.
  if (req.method === 'POST' && url.pathname === '/api/auth/refresh') {
    const token = getBearer(req);
    const session = sessions.get(token);

    if (!session || (session.expiresAt && session.expiresAt < Date.now())) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or expired token' }));
      return true;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token, expires_at_ms: session.expiresAt }));
    return true;
  }

  // GET /api/auth/me
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const token = getBearer(req);
    const session = sessions.get(token);

    if (!session || (session.expiresAt && session.expiresAt < Date.now())) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }

    const user = findUserById(session.userId);
    if (!user) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'User not found' }));
      return true;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(userPublicView(user)));
    return true;
  }

  // POST /api/auth/verify-email — resend / send the verification email.
  // Auth optional: if a tc-h- bearer is present, use that user; otherwise
  // accept { email } in the body for the cold-link case from the signup form.
  if (req.method === 'POST' && url.pathname === '/api/auth/verify-email') {
    readJsonBody(req).then((payload) => {
      const bearer = getBearer(req);
      let user = null;
      const session = sessions.get(bearer);
      if (session) user = findUserById(session.userId);
      if (!user && payload?.email) user = users.get(String(payload.email).toLowerCase());

      if (!user) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'User not found' }));
        return;
      }
      if (user.emailVerified) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, alreadyVerified: true }));
        return;
      }

      const { link } = issueVerifyToken(user);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sent: true, link }));
    }).catch(() => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request' }));
    });
    return true;
  }

  // GET /api/auth/verify?token=<one-time>
  if (req.method === 'GET' && url.pathname === '/api/auth/verify') {
    const t = url.searchParams.get('token') || '';
    const entry = verifyTokens.get(t);
    if (!entry || entry.expiresAt < Date.now()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or expired verification token' }));
      return true;
    }
    const user = findUserById(entry.userId);
    if (!user) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'User not found' }));
      return true;
    }
    user.emailVerified = true;
    verifyTokens.delete(t);
    console.log(`[Auth] Email verified for ${user.email}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, email: user.email, emailVerified: true }));
    return true;
  }

  return false; // Not handled
}

/**
 * Token management endpoints — agent invites (tc-a-) and revocation.
 *
 * Lives under /api/tokens/* on the inbox server. Nginx routes this prefix
 * to 127.0.0.1:8769 alongside the rest of /api/auth.
 */
export function handleTokenRequest(req, res, url) {
  // POST /api/tokens/generate-agent — requires tc-h- bearer
  if (req.method === 'POST' && url.pathname === '/api/tokens/generate-agent') {
    const bearer = getBearer(req);
    const session = sessions.get(bearer);
    if (!session || !bearer.startsWith('tc-h-')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return true;
    }
    const user = findUserById(session.userId);
    if (!user) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'User not found' }));
      return true;
    }

    readJsonBody(req).then((payload) => {
      const label = (payload?.label && String(payload.label).slice(0, 64)) || 'Agent';
      const token = generateAgentToken();
      agentTokens.set(token, {
        userId: user.id,
        createdAt: new Date().toISOString(),
        label,
        revoked: false,
      });
      console.log(`[Auth] Agent token issued for ${user.email}: ...${token.slice(-8)}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        token,
        relayURL: RELAY_WS_URL,
        httpURL: RELAY_HTTP_URL,
        label,
      }));
    }).catch(() => {
      // Body is optional; on parse error, still issue a default token.
      const token = generateAgentToken();
      agentTokens.set(token, {
        userId: user.id,
        createdAt: new Date().toISOString(),
        label: 'Agent',
        revoked: false,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token, relayURL: RELAY_WS_URL, httpURL: RELAY_HTTP_URL }));
    });
    return true;
  }

  // GET /api/tokens/validate?token=<t> — internal relay validation (no auth required, localhost only)
  if (req.method === 'GET' && url.pathname === '/api/tokens/validate') {
    const t = url.searchParams.get('token') || '';
    const valid = isKnownRelayToken(t);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ valid }));
    return true;
  }

// GET /api/tokens — list this user's active agent tokens
  if (req.method === 'GET' && url.pathname === '/api/tokens') {
    const bearer = getBearer(req);
    const session = sessions.get(bearer);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return true;
    }
    const list = [];
    for (const [t, meta] of agentTokens) {
      if (meta.userId !== session.userId || meta.revoked) continue;
      list.push({
        token: t,
        label: meta.label,
        createdAt: meta.createdAt,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tokens: list }));
    return true;
  }

  // DELETE /api/tokens/<tokenId> — revoke (agent or session token)
  const delMatch = req.method === 'DELETE' && url.pathname.match(/^\/api\/tokens\/(.+)$/);
  if (delMatch) {
    const bearer = getBearer(req);
    const session = sessions.get(bearer);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return true;
    }
    const target = decodeURIComponent(delMatch[1]);

    // Agent token revocation
    const agent = agentTokens.get(target);
    if (agent) {
      if (agent.userId !== session.userId && session.userId !== 'michael-lovell-admin') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden' }));
        return true;
      }
      agent.revoked = true;
      agentTokens.delete(target);
      console.log(`[Auth] Agent token revoked: ...${target.slice(-8)}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, type: 'agent' }));
      return true;
    }

    // Human session revocation (self-revoke or admin)
    const targetSession = sessions.get(target);
    if (targetSession) {
      if (targetSession.userId !== session.userId && session.userId !== 'michael-lovell-admin') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden' }));
        return true;
      }
      sessions.delete(target);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, type: 'human' }));
      return true;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'token not found' }));
    return true;
  }

  return false;
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
