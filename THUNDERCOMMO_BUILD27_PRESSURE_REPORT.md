# ThunderCommo Build 27 — Combined Pressure Test Report
## Date: May 10, 2026
## Reviewer: Jon | ThunderBase
## Method: Logic review against briefs, server-side direct verification, prior gate report carry-forward

---

## Verdict: CONDITIONAL PASS

All Michael's feature requirements are confirmed present on Mack's side (his statement).
Server-side work is verified by direct testing.
Three items Mack must confirm before building — all are quick grep/read checks.

---

## Section A — connectionEpoch guard (CRITICAL)

**From Build 27 gate report (carried forward):**

- A1: Epoch must bump at START of `connect()` before any closure captures
- A2: ALL 8 async callback sites need gating (receive, send, ping, auth-timeout, URLSessionDelegate, outbound queue drain)
- A3: Reconnect funnel itself gates as defense-in-depth
- A4: **connectionEpoch MUST be @MainActor or atomic — bare `var Int` on non-actor class is a data race**
- A5: `disconnect()` bumps epoch BEFORE `task.cancel()`
- A6: Latest-epoch-wins for two-connection race

**Status:** Mack has confirmed the fix is in and simulator passes clean. Mack must verify A4 specifically — this is a thread safety issue that won't show in simulator but will crash on device under load.

**Required check before building:**
```swift
// Must be ONE of these:
@MainActor private var connectionEpoch: Int = 0
// OR
private let epochLock = NSLock(); private var _epoch = 0
// NOT this:
private var connectionEpoch: Int = 0  // ← RACE CONDITION
```

---

## Section B — Message alignment

- B1: `localPeerId` comparison has `if let` guard ← Mack confirm
- B2: Default LEFT-align until peerId is known ← verify
- B3: `localPeerId` NOT in `rowID` ← critical, would undo BUG-7

---

## Section C — Feature Set (Michael's requirements)

| Feature | Status |
|---------|--------|
| User messages right-justified | ✅ Mack confirmed |
| Agent messages left-justified | ✅ Mack confirmed |
| Collapsible top menu | ✅ Mack confirmed |
| Color scheme (purple/dark) | ✅ Mack confirmed |
| Jon thinking indicator | ✅ Bridge sends thinking events (verified); iOS renders ← Mack confirm |
| Add Human function | ✅ Mack confirmed |
| Add Agent (AddAgentView) | ✅ Mack confirmed |
| Add Channel (real flow, not stub) | ✅ Mack confirmed — real iOS channel route |
| Model label next to agent in roster | ✅ Mack confirmed |

---

## Section D — Server Side (Jon's slice — directly verified)

| Item | Status |
|------|--------|
| Relay keepalive (30s ping, 2-miss terminate) | ✅ Running 6+ min stable, no restarts |
| Relay wrapper bypassed | ✅ Systemd runs relay.mjs directly |
| Mack/Rex show online in roster | ✅ OPENCLAW_AGENTS set, probe confirmed: mack:online, rex:online, jon:online |
| Thinking indicator broadcast | ✅ Already in bridge.mjs, no change needed |
| DESIGN-PRINCIPLES.md updated | ✅ §7 documents wrapper anti-pattern |
| Committed to thundercomm-stable | ✅ Commit 521f0a32e4 on origin |

---

## Section E — Regression Check

| Item | Status |
|------|--------|
| DeliveryCore actor (Build 24 Jon slice) | ✅ Not in Mack's touched files |
| LightweightContextEngine (Build 24) | ✅ Not in Mack's touched files |
| BUG-7 streaming row stable ID | ⚠️ B3 check — localPeerId must NOT be in rowID |
| Federation ack loop (Build 24 Mack fix) | ✅ Not regressed — WebSocket changes are to epoch guard, not ack path |

---

## Exact checks Mack must do before building:

1. **A4 (BLOCKING):** `connectionEpoch` is `@MainActor` or has explicit lock — not bare `var Int`
2. **B1:** `localPeerId` comparison uses `if let` guard
3. **B3:** `rowID(for:)` function does NOT include `localPeerId` in the key

If all three check out: **GREEN LIGHT. Mack builds and ships Build 27.**

---

## Notes

- This is a logic review. Source lives on Mack's Mac. Mack verifies in source.
- Server side verified by direct testing from ThunderBase.
- Michael wakes up to this build. Make it count.
