# ThunderCommo Build 27 — Gate Pass Brief
## Date: May 10, 2026

## Mack's changes (4 files):

### 1. ThunderCommWebSocketClient.swift — CRITICAL FIX
- Added `connectionEpoch` guard
- Old socket callbacks ignored once newer connection is live
- Covers: stale receive, send, ping, auth-timeout reconnect triggers
- This fixes the self-inflicted reconnect loop / cycling bug

### 2. MessageBubble.swift — alignment fix
- Local message alignment no longer depends on display name alone
- Local human messages now recognize device peer identity

### 3. MessageListView.swift
- Passes `localPeerId` through to bubbles

### 4. ContentView.swift  
- Wires `store.peerId` into the message list

## Gate Review Tasks

### A. connectionEpoch guard (CRITICAL — reason for the whole build)
- Confirm the epoch is incremented on every new connection attempt
- Confirm ALL async callbacks (receive, send, ping, auth-timeout) check epoch before acting
- Confirm a stale callback can NOT trigger reconnect after a newer connection is live
- Edge case: what happens if two connections race? Only the latest epoch should win.
- Edge case: what happens on intentional disconnect (sign-out)? Epoch should invalidate callbacks.

### B. Peer identity for message alignment
- Confirm `localPeerId` flows from ThunderCommStore → ContentView → MessageListView → MessageBubble
- Confirm local messages are identified by peerId match, NOT just display name match
- Edge case: first launch before peerId is set — should default to right-align for all human messages? Or no alignment until peerId known?

### C. Regression check
- DeliveryCore actor integration still intact (from Jon's Build 24 slice)
- LightweightContextEngine look-above routing still working
- BUG-7 streaming row stable ID still in MessageListView (from Build 24)
- Bridge ack loop (from Mack's Build 24 fix) — not regressed by WebSocket changes

### D. Build safety
- No new force-unwraps in the epoch tracking code
- No MainActor violations in the callback guards
- Thread safety: epoch variable must be atomic or MainActor-protected

## Relay keepalive (server-side — Jon already shipped)
- relay.mjs now pings every client every 20s
- Dead connections terminate cleanly
- Both tokens work externally — confirmed by Mack

## Output
Write THUNDERCOMMO_BUILD27_GATE_REPORT.md to /home/ubuntu/thundergate-dev/
- PASS / CONDITIONAL PASS / FAIL
- List any issues found
- If PASS: "Green light. Mack builds and ships Build 27."
