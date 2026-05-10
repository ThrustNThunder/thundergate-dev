# ThunderCommo Build 24 — Combined Pressure Test Brief
## Date: May 10, 2026
## From: Jon | ThunderBase
## Purpose: Final CLI Jon pressure test before Mack integrates and ships

---

## What you're reviewing

Two parallel CLI Jon passes, now combined into one build:

### Mack's pass (11 files, 1240 insertions, 502 deletions):
- ContentView.swift — 3-row card header, route chip, + menu, gear only
- ComposerBar.swift — pill shape, gradient send button 36pt circle
- SettingsView.swift — Connection section, one settings surface, no ellipsis
- MessageBubble.swift — failed overlay, tap-to-retry, delivery badges
- ThunderCommModels.swift — .failed state added to DeliveryState
- ThunderCommStore.swift — 12s watchdog, retrySend(), identity from UserStore
- ThunderCommWebSocketClient.swift — onMessageFailed callback
- SignUpView.swift — agent-first framing, brand tagline
- bridge.mjs — 8s sliding window multi-block routing
- channel.ts — dead code banner
- ⚠️ MessageListView.swift — Mack touched this BUT Jon's version supersedes it (see below)

### Jon's pass (3 files, all NEW or superseding):
- `DeliveryCore.swift` (NEW) — pure actor, monotonic transitions, W1 watchdog race guard
- `LightweightContextEngine.swift` (NEW) — stateless look-above engine, depth-3 walk, DM short-circuit
- `MessageListView.swift` (SUPERSEDES Mack's) — BUG-7 streaming row stable ID, TimelineView thinking dots, RosterRow value-typed, debug logging on inferred routes

### MessageListView.swift resolution:
Use Jon's version. It contains the BUG-7 fix (B3 blocker) + look-above refactor that feeds into LightweightContextEngine. Mack's version may have partial changes — Jon's is the complete authoritative version for this file.

One thing to verify: Jon's MessageListView uses `message.isStreaming: Bool` — if ThunderCommModels.swift doesn't have this property, add it as a computed property:
```swift
var isStreaming: Bool { deliveryState == .sending && !text.isEmpty }
```
Check Mack's ThunderCommModels.swift first — if .failed was added there, isStreaming may already exist or be easy to add.

---

## Pressure Test Tasks

### A. Architecture + logic correctness

1. **DeliveryCore actor integration:**
   - Confirm ThunderCommStore wires to DeliveryCore correctly
   - `arm()` called on send, `markSent()` on socket success, `markDelivered()` on ack, `markFailed()` on watchdog fire
   - Watchdog timer cancels on ack (no late-fire overwriting .delivered)
   - `retryPending()` called on reconnect — re-arms and re-sends with same idempotency key

2. **LightweightContextEngine wiring:**
   - MessageListView (Jon's version) imports and calls LightweightContextEngine
   - DM channel (`direct:jon`) → short-circuit, no look-above
   - #tnt → walk up to 3, find last agent, confidence-decays
   - Inferred route logged at debug level (verify print/logger call exists)

3. **MessageListView BUG-7 verification:**
   - Streaming row uses `rowID(for:)` returning `"streaming-\(message.id)"` — stable across deltas
   - NOT keyed off `updatedAt` or any timestamp
   - Thinking dots use TimelineView (survives row re-creation)
   - RosterRow is value-typed struct (no class reference causing full re-render)

4. **Bridge multi-block routing (8s window):**
   - Window resets per-block from same agent (sliding, not fixed from dispatch)
   - Fallback to #tnt after 8s is logged at warn level
   - Single-text turns still pop queue exactly once

5. **Identity (no ios-michael-* anywhere):**
   - `loadOrCreatePeerId(forUserKey:)` storage key includes userKey (not a global key)
   - Pre-auth callers use sentinel or skip identity resolution
   - `mappedCanonicalID` is generic regex, not a switch over known names

### B. Regression check (must not have broken these)
- `inferDirectAgentIDIfNeeded` look-above (now in LightweightContextEngine) — DM short-circuit works
- pendingResponseChannels queue — single-text turns still work (8s window addition only)
- Sent/delivered indicators — MessageBubble still shows ✓/✓✓
- History gating — didInitialScroll guard untouched
- Code block copy button — untouched
- Federation 45s idle terminate + 15s ping in bridge.mjs — untouched by 8s window addition

### C. Integration completeness
- All 3 of Jon's files are present in the iOS project folder
- `Message.isStreaming` exists in ThunderCommModels.swift (either added or computed from existing state)
- LightweightContextEngine.swift added to Xcode project (TARGETS → ThunderCommIOS)
- DeliveryCore.swift added to Xcode project (TARGETS → ThunderCommIOS)
- No import cycles (DeliveryCore has no UIKit, LightweightContextEngine has no UIKit)

### D. Build safety
- No force-unwraps on critical send/auth/identity paths
- No MainActor violations in watchdog timer code
- Keychain access group (W6): if peer ID is in Keychain, `kSecAttrAccessGroup` matches device entitlement
- `bridge.mjs` node --check passes

---

## Output
Write `THUNDERCOMMO_BUILD24_PRESSURE_REPORT.md` to `/home/ubuntu/thundergate-dev/`

Format:
- PASS | CONDITIONAL PASS | FAIL
- For each section A-D: PASS / ISSUES
- List any issues: BLOCKER | WARNING | NOTE
- If CONDITIONAL: exact fixes Mack must apply
- If PASS: "Green light. Mack integrates Jon's files + his files, builds Build 24, ships to TestFlight."

## Source files for this review:
- Jon's slice files: `/home/ubuntu/thundergate-dev/ios-jon-slice/` (all 4 files)
- Jon's slice notes: `/home/ubuntu/thundergate-dev/ios-jon-slice/IOS_SLICE_NOTES.md`
- Gate report (context): `/home/ubuntu/thundergate-dev/THUNDERCOMMO_BUILD24_GATE_REPORT.md`
- Original build brief: `/home/ubuntu/thundergate-dev/THUNDERCOMMO_IOS_BUILD24_BRIEF.md`

Note: Mack's files are on his Mac (repos/thundergate-sparse). You don't have direct access.
Review Jon's files directly. For Mack's files, reason from the implementation notes already captured.
