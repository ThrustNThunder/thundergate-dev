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

// ── Config ────────────────────────────────────────────────────────────────

const RELAY_PORT = parseInt(process.env.TC_RELAY_PORT || '8767', 10);
const FEDERATION_TOKEN = process.env.TC_FEDERATION_TOKEN || 'jmab-federation-2026';
const GATEWAY_TOKEN = process.env.TC_GATEWAY_TOKEN || '4ca1100a180ad68a94b004056e56fd39c81bdccb742d2926';
const VALID_TOKENS = new Set([FEDERATION_TOKEN, GATEWAY_TOKEN, 'Michael', 'michael']);
const FEDERATED_CHANNELS = (process.env.TC_FEDERATED_CHANNELS || 'jmab,tnt').split(',');

// ── State ─────────────────────────────────────────────────────────────────

const peers = new Map(); // peerId → { ws, channels, connectedAt, model }

// ── Relay Server ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: RELAY_PORT });

// Ping all clients every 30s. Allow 2 missed pings before terminating (60s grace).
const PING_INTERVAL = 30000;
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.missedPings >= 2) { ws.terminate(); return; }
    ws.missedPings = (ws.missedPings || 0) + 1;
    try { ws.ping(); } catch {}
  });
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
      if (!VALID_TOKENS.has(msg.token)) {
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

wss.on('listening', () => {
  console.log(`[ThunderComm Relay] Federation relay on ws://0.0.0.0:${RELAY_PORT}`);
  console.log(`[ThunderComm Relay] Federated channels: ${FEDERATED_CHANNELS.join(', ')}`);
});

wss.on('error', err => console.error('[Relay] Server error:', err));

// ── Health check endpoint (optional HTTP) ─────────────────────────────────

import { createServer } from 'http';
const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', peers: peers.size, uptime: process.uptime() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
http.listen(RELAY_PORT + 1, () => {
  console.log(`[ThunderComm Relay] Health check on http://0.0.0.0:${RELAY_PORT + 1}/health`);
});
