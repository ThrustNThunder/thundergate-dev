# ThunderCommo Build 27 — Combined Pressure Test Brief
## Date: May 10, 2026
## This is Michael's overnight build. Must be ready to ship when he wakes up.

## Mack's iOS changes (must verify all):

### CRITICAL — connectionEpoch guard (stale socket fix)
- A1: Epoch bumps at START of connect() before any closure captures
- A2: ALL async callbacks gated (receive, send, ping, auth-timeout, URLSessionDelegate, outbound queue drain)
- A3: Reconnect funnel also checks epoch (defense-in-depth)
- A4: connectionEpoch is @MainActor protected or atomic — NOT bare var Int on non-actor class
- A5: disconnect() bumps epoch BEFORE task.cancel()
- A6: Latest-epoch-wins for two-connection race

### Message alignment
- B1: localPeerId comparison has if-let guard (nil==nil must NOT right-align agent messages)
- B2: Default to LEFT-align until peerId is known
- B3: localPeerId NOT folded into rowID (would undo BUG-7 stable-key fix)

### Full feature set (Michael's requirements)
- User messages right-justified ✓ (Mack says in)
- Agent messages left-justified ✓
- Collapsible top menu ✓
- Color scheme (purple/dark) ✓
- Thinking dots indicator (Jon processing) — verify bridge sends thinking events and iOS renders them
- Add Human function — verify it's wired (not a stub that crashes)
- Add Agent function — verify AddAgentView is reachable and functional
- Add Channel function — Mack says real flow (not alert stub) — verify custom channels persist
- Model label next to agent name in roster — verify bridge sends model info and iOS renders it

### Regression checks
- DeliveryCore actor still intact (Build 24 Jon slice)
- LightweightContextEngine look-above routing (Build 24 Jon slice)
- BUG-7 streaming row stable ID (Build 24)
- Federation ack loop (Build 24 Mack fix)

## Jon's server-side changes (verify):
- Relay keepalive — 30s ping, 2 missed pings = terminate, activity resets counter
- Relay wrapper bypassed — relay.mjs runs directly via systemd
- Bridge roster — Mack/agents show online when active via OpenClaw (not just relay-connected)
- Thinking indicator broadcast — bridge sends thinking events to iOS clients

## Build safety
- No force-unwraps on critical paths
- connectionEpoch thread safety (MUST be verified)
- Keychain access group matches device entitlement (W6 carry-forward)

## Output
Write THUNDERCOMMO_BUILD27_PRESSURE_REPORT.md to /home/ubuntu/thundergate-dev/
- PASS / CONDITIONAL PASS / FAIL
- For each section: status + any issues
- If PASS: "Green light. Mack builds and ships Build 27."
- Michael wakes up to this build. Make it count.
