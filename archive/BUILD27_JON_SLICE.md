# Build 27 — Jon's Server-Side Slice
## Date: May 10, 2026

Read https://github.com/ThrustNThunder/cli-jon-context for context.

## What Mack is fixing (iOS side, Jon does NOT touch):
- ThunderCommWebSocketClient.swift — connectionEpoch guard (stale callbacks)
- MessageBubble.swift — local peer identity alignment
- MessageListView.swift — localPeerId threading
- ContentView.swift — store.peerId wiring

## What Jon fixes (server side):

### Fix 1: Relay presence labeling
Mack shows as "offline" on Michael's roster even when Mack is active on Slack/OpenClaw.
Root cause: relay roster only shows peers with active WebSocket connections to the relay.
Mack participates via Slack/OpenClaw (different channel) — never connects directly to relay.

In relay.mjs, when bridge.mjs connects as "thunderbase-jon", it should broadcast a synthetic 
roster entry for any agent that is known to be online via OpenClaw (even if not relay-connected).

Better fix: In bridge.mjs, when sending roster to iOS clients, include all known agents 
with their actual status (online = connected to OpenClaw, not just relay-connected).
File: /home/ubuntu/thundergate/extensions/thundercomm/bridge.mjs

Look for where the bridge sends `federation_peers` or roster updates to iOS clients.
Add Mack to the roster with an "online" or "available" indicator when bridge is connected.

### Fix 2: Relay keepalive robustness
Current patch (2-missed-pings, 30s interval, activity resets counter) is correct logic.
But verify the relay.mjs patch is actually running cleanly post-wrapper-bypass.

Test: check that the relay has been running > 5 minutes without SIGKILL.
Command: `systemctl status thundercomm-relay` — should show uptime > 5 min, no restarts.

### Fix 3: Relay wrapper bypass — make permanent
The run-relay.sh wrapper was killing relay processes. Bypassed it by editing the systemd unit.
Commit this change to git so it survives future deployments.

File to commit: relay.mjs (with keepalive patch)
Also document in thundergate/extensions/thundercomm/DESIGN-PRINCIPLES.md:
"DO NOT use run-relay.sh — it has a self-killing race condition. Run relay.mjs directly."

## Output
1. Fix bridge.mjs roster to show Mack/agents as online when they're active via OpenClaw
2. Verify relay keepalive is stable
3. Commit relay.mjs + systemd unit changes to thundergate repo
4. Document the wrapper issue in DESIGN-PRINCIPLES.md
5. Write BUILD27_SERVER_SUMMARY.md with what changed

## ADDITIONAL REQUIREMENTS FROM MICHAEL (18:23 ET May 10)

These must ALL be in Build 27:
1. User messages RIGHT-justified, agent messages LEFT-justified
2. Collapsible top menu (sidebar/header)
3. Color scheme correct (dark theme, purple accent, Slack-inspired from style.css)
4. Jon thinking indicator (animated dots when Jon is processing)
5. Add Human button (invite human to channel)
6. Add Agent button (onboard new agent)
7. Add Channel button (create new channel)
8. Model name displayed next to agent name in roster (e.g. "Jon — claude-sonnet-4-6")
9. Presence correct (Mack shows online when active via OpenClaw, not just relay-connected)

This is the FULL Build 27 feature set. Both Jon's server slice AND Mack's iOS slice must cover these.
Jon's server slice: items 4 (thinking indicator broadcast), 9 (presence), relay/wrapper fixes
Mack's iOS slice: items 1, 2, 3, 5, 6, 7, 8 (UI layer)

Build 27 = pressure tested and READY TO SHIP when Michael wakes up.
