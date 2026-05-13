#!/usr/bin/env node
/**
 * ThunderComm Federation Relay
 * 
 * Stateless message relay for federated channels between ThunderComm bridges.
 * Each bridge connects as a peer. Messages in federated channels broadcast to all peers.
 * 
 * Jon | ThunderBase | 2026-05-06
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { createServer, request as httpRequest } from 'http';

// ── Config ────────────────────────────────────────────────────────────────

const RELAY_PORT = parseInt(process.env.TC_RELAY_PORT || '8767', 10);
const FEDERATION_TOKEN = process.env.TC_FEDERATION_TOKEN || 'jmab-federation-2026';
const GATEWAY_TOKEN = process.env.TC_GATEWAY_TOKEN || '4ca1100a180ad68a94b004056e56fd39c81bdccb742d2926';
const VALID_TOKENS = new Set([FEDERATION_TOKEN, GATEWAY_TOKEN, 'Michael', 'michael']);
const FEDERATED_CHANNELS = (process.env.TC_FEDERATED_CHANNELS || 'jmab,tnt').split(',');

// Accept dynamic tc-a-/tc-h- tokens issued by the inbox auth server in
// addition to the hardcoded set above. Per ThunderCommo onboarding spec
// (May 12 2026): tokens beginning with these prefixes are issued by the
// backend and revocable at /api/tokens/<id>. The relay accepts any
// well-formed token of these prefixes; revocation is enforced upstream
// when the inbox stops including them in /api/auth responses.
function isAcceptedToken(t) {
  if (!t) return false;
  if (VALID_TOKENS.has(t)) return true;
  if (typeof t !== 'string') return false;
  return t.startsWith('tc-a-') || t.startsWith('tc-h-');
}

const APNS_REGISTER_HOST = process.env.TC_APNS_HOST || '127.0.0.1';
const APNS_REGISTER_PORT = parseInt(process.env.TC_APNS_PORT || '18794', 10);

// Local inbox auth lookup (sessions map lives in the inbox process).
const INBOX_AUTH_HOST = process.env.TC_INBOX_HOST || '127.0.0.1';
const INBOX_AUTH_PORT = parseInt(process.env.TC_INBOX_PORT || '8769', 10);

// ── State ─────────────────────────────────────────────────────────────────

const peers = new Map(); // peerId → { ws, channels, connectedAt, model }

// ── Relay Server ──────────────────────────────────────────────────────────
// We run an http.createServer so the same port (8767, Cloudflare-proxied)
// can serve both plain HTTP POSTs (e.g. /api/devices/token) and WebSocket
// upgrades. The WebSocketServer is `noServer` and is wired up via the
// 'upgrade' event below — all existing WS routing logic is unchanged.

const wss = new WebSocketServer({ noServer: true });

const relayHttp = createServer(handleRelayHttp);

relayHttp.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

relayHttp.listen(RELAY_PORT, () => {
  console.log(`[ThunderComm Relay] HTTP+WS on :${RELAY_PORT} (ws upgrades + POST /api/devices/token)`);
  console.log(`[ThunderComm Relay] Federated channels: ${FEDERATED_CHANNELS.join(', ')}`);
});

relayHttp.on('error', err => console.error('[Relay] HTTP server error:', err));

// ── /api/devices/token handler ────────────────────────────────────────────
// Accepts the same body the iOS app already sends to apns_server.py's
// /register endpoint and forwards it to the locally-bound apns_server.
// Port 18794 is not reachable from the public internet (security group
// blocks it); this endpoint is reachable via Cloudflare TLS on 8767.

function readJsonBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function writeJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders,
  });
  res.end(body);
}

// Resolve a tc-h- session token → user_id by calling the local inbox.
// Returns { ok: true, userId } on success, { ok: false, status } otherwise.
function lookupHumanSessionUserId(token) {
  return new Promise((resolve) => {
    const req = httpRequest({
      host: INBOX_AUTH_HOST,
      port: INBOX_AUTH_PORT,
      path: '/api/auth/me',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 3000,
    }, (resp) => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => {
        if (resp.statusCode !== 200) {
          resolve({ ok: false, status: resp.statusCode || 0 });
          return;
        }
        try {
          const me = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (me && me.id) resolve({ ok: true, userId: me.id });
          else resolve({ ok: false, status: 500 });
        } catch {
          resolve({ ok: false, status: 500 });
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('inbox auth timeout')); });
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.end();
  });
}

function forwardTokenToApns(bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const req = httpRequest({
      host: APNS_REGISTER_HOST,
      port: APNS_REGISTER_PORT,
      path: '/register',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      },
      timeout: 8000,
    }, (resp) => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => resolve({
        status: resp.statusCode || 502,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => { req.destroy(new Error('apns_server timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function handleRelayHttp(req, res) {
  const url = req.url || '/';

  // CORS preflight (iOS doesn't need it, but harmless and clean).
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type',
      'Access-Control-Max-Age': '600',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url === '/health') {
    writeJson(res, 200, { status: 'ok', peers: peers.size, uptime: process.uptime() });
    return;
  }

  if (req.method === 'POST' && url === '/api/devices/token') {
    const authHeader = req.headers['authorization'] || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    const token = match ? match[1].trim() : '';
    // Accept any non-empty Bearer token for device registration.
    // apns_server.py validates device_token format; relay auth not needed here.
    if (!token) {
      console.warn('[Relay] /api/devices/token: missing auth header');
      writeJson(res, 401, { error: 'unauthorized' });
      return;
    }

    readJsonBody(req).then(async (body) => {
      const deviceToken = body?.device_token;
      const bodyUserId = body?.user_id;
      const appBundleId = body?.app_bundle_id;
      if (!deviceToken || !bodyUserId) {
        writeJson(res, 400, { error: 'missing_field', required: ['device_token', 'user_id'] });
        return;
      }

      // Ownership check: a tc-h- (human) bearer can only register a device
      // under the user_id of its own session. We resolve that via the inbox.
      // tc-a- (agent) bearers register on behalf of users and may pass any
      // user_id in the body. Other token shapes (legacy hardcoded) are
      // treated like agents for backward compatibility.
      let effectiveUserId = bodyUserId;
      if (token.startsWith('tc-h-')) {
        const lookup = await lookupHumanSessionUserId(token);
        if (!lookup.ok) {
          console.warn(`[Relay] /api/devices/token: tc-h- session lookup failed (status=${lookup.status})`);
          writeJson(res, 401, { error: 'unauthorized' });
          return;
        }
        if (lookup.userId !== bodyUserId) {
          console.warn(`[Relay] /api/devices/token: body user_id=${bodyUserId} overridden with session user_id=${lookup.userId}`);
        }
        effectiveUserId = lookup.userId;
      }

      try {
        const upstream = await forwardTokenToApns({
          device_token: deviceToken,
          user_id: effectiveUserId,
          app_bundle_id: appBundleId || '',
        });
        console.log(`[Relay] token registered: user=${effectiveUserId} device=${String(deviceToken).slice(0, 8)}… upstream=${upstream.status}`);
        res.writeHead(upstream.status, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Content-Length': Buffer.byteLength(upstream.body),
        });
        res.end(upstream.body);
      } catch (e) {
        console.warn('[Relay] apns_server unreachable:', e.message);
        writeJson(res, 503, { error: 'apns_server_unavailable', detail: e.message });
      }
    }).catch((e) => {
      writeJson(res, 400, { error: 'bad_request', detail: e.message });
    });
    return;
  }

  writeJson(res, 404, { error: 'not_found' });
}

// Ping all clients every 30s. Allow 2 missed pings before terminating (60s grace).
const PING_INTERVAL = 30000;
setInterval(() => {
  for (const peer of peers.values()) {
    const ws = peer.ws;
    if (ws.missedPings >= 2) { try { ws.terminate(); } catch {} continue; }
    ws.missedPings = (ws.missedPings || 0) + 1;
    try { ws.ping(); } catch {}
  }
}, PING_INTERVAL);

wss.on('connection', (ws, req) => {
  let peerId = null;
  let authenticated = false;
  ws.missedPings = 0;
  ws.on('pong', () => { ws.missedPings = 0; });
  // Also reset on any message activity
  ws.on('message', () => { ws.missedPings = 0; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // Authentication
    if (msg.type === 'federation_auth') {
      // WebSocket federation is agent-only. Accept hardcoded VALID_TOKENS or
      // tc-a-* agent tokens; reject tc-h-* human tokens and anything else.
      const t = msg.token;
      const wsTokenOk = typeof t === 'string' && t.length > 0 &&
        (VALID_TOKENS.has(t) || t.startsWith('tc-a-'));
      if (!wsTokenOk) {
        console.warn(`[Relay] Auth rejected: bad token from ${msg.peerId}`);
        ws.send(JSON.stringify({ type: 'federation_status', status: 'rejected', reason: 'bad_token' }));
        ws.close(4001, 'Unauthorized');
        return;
      }

      peerId = msg.peerId || randomUUID().slice(0, 8);
      const channels = (msg.channels || []).filter(c => FEDERATED_CHANNELS.includes(c) || c.startsWith('direct:'));
      
      peers.set(peerId, { ws, channels, connectedAt: Date.now(), model: msg.model || null });
      authenticated = true;

      console.log(`[Relay] Peer connected: ${peerId} (channels: ${channels.join(', ')})`);
      
      // Build models map
      const peerModels = {};
      for (const [pid, peer] of peers) {
        if (peer.model) peerModels[pid] = peer.model;
      }
      
      ws.send(JSON.stringify({
        type: 'federation_status',
        status: 'connected',
        peerId,
        channels,
        peers: Array.from(peers.keys()),
        models: peerModels,
      }));

      // Notify other peers
      broadcastPeerList();
      return;
    }

    // Require auth for all other messages
    if (!authenticated) {
      ws.send(JSON.stringify({ type: 'error', code: 'NOT_AUTHENTICATED', message: 'Send federation_auth first' }));
      return;
    }

    // Typing/thinking events — broadcast to all peers
    if (msg.type === 'typing' || msg.type === 'thinking') {
      msg.originPeer = peerId;
      msg.relayedAt = Date.now();
      
      // Broadcast to ALL other peers (typing indicators are global)
      for (const [pid, peer] of peers) {
        if (pid === peerId) continue;
        if (peer.ws.readyState === WebSocket.OPEN) {
          peer.ws.send(JSON.stringify(msg));
        }
      }
      return;
    }

    // Federation message
    if (msg.type === 'federation_message') {
      // Allow federated channels, direct:agent messages, and bare 'direct' (bridge handles routing)
      const isDirectAgent = msg.channel?.startsWith('direct:') || msg.channel === 'direct';
      if (!FEDERATED_CHANNELS.includes(msg.channel) && !isDirectAgent) {
        console.warn(`[Relay] Rejected message to non-federated channel: ${msg.channel}`);
        return;
      }

      msg.relayedAt = Date.now();
      msg.relayedBy = 'thunderbase';

      console.log(`[Relay] ${msg.sender} (${msg.originPeer}) → #${msg.channel}: ${msg.text?.slice(0, 50)}...`);

      // Broadcast to all OTHER peers
      for (const [pid, peer] of peers) {
        if (pid === peerId) continue; // Don't echo back to sender
        // Allow if peer subscribes to channel OR if it's a direct:agent message (including bare 'direct')
        const isPeerDirectEligible = msg.channel?.startsWith('direct:') || msg.channel === 'direct';
        if (!peer.channels.includes(msg.channel) && !isPeerDirectEligible) continue;
        if (peer.ws.readyState === WebSocket.OPEN) {
          peer.ws.send(JSON.stringify(msg));
        }
      }
    }
  });

  ws.on('close', () => {
    if (peerId && peers.has(peerId)) {
      peers.delete(peerId);
      console.log(`[Relay] Peer disconnected: ${peerId} (${peers.size} remaining)`);
      broadcastPeerList();
    }
  });

  ws.on('error', (err) => {
    console.error(`[Relay] Peer error ${peerId}:`, err.message);
  });
});

function broadcastPeerList() {
  const peerList = Array.from(peers.keys());
  const peerModels = {};
  for (const [pid, peer] of peers) {
    if (peer.model) peerModels[pid] = peer.model;
  }
  const msg = JSON.stringify({ type: 'federation_peers', peers: peerList, models: peerModels });
  for (const [pid, peer] of peers) {
    if (peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(msg);
    }
  }
}

wss.on('error', err => console.error('[Relay] WSS error:', err));

// ── Health check endpoint (legacy http server on RELAY_PORT+1) ────────────
// Kept for existing local monitors that hit http://localhost:8768/health.
// The unified http server on RELAY_PORT also serves /health.

const healthHttp = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', peers: peers.size, uptime: process.uptime() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
healthHttp.listen(RELAY_PORT + 1, () => {
  console.log(`[ThunderComm Relay] Health check on http://0.0.0.0:${RELAY_PORT + 1}/health`);
});
