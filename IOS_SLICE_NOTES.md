# Jon's iOS Slice — Build 23 Pass

**Date:** 2026-05-10
**Author:** CLI Jon
**Files:** `DeliveryCore.swift`, `LightweightContextEngine.swift`, `MessageListView.swift`
**Output dir:** `/home/ubuntu/thundergate-dev/ios-jon-slice/`

---

## What's in this slice

| File | Purpose | Lines | New/Changed |
|---|---|---|---|
| `DeliveryCore.swift` | Pure actor for delivery state map (no UIKit) | ~85 | NEW |
| `LightweightContextEngine.swift` | Stateless look-above + route inference | ~120 | NEW |
| `MessageListView.swift` | Message list, thinking dots, roster row, BUG-7 fix | ~165 | CHANGED |

`LightweightContextEngine.swift` was created (over the 30-line threshold per the brief). All look-above logic moved out of `MessageListView` into the engine for unit-testability.

---

## What changed and why

### 1. DeliveryCore.swift — new actor

Clean delivery-state core, isolated as an actor so the watchdog timer and ack handler can both call into it from any context without races. `ThunderCommStore` holds an instance and forwards ack/watchdog/socket events.

**Transition rules enforce monotonicity:**
- `.delivered` is sticky — a delayed ack arriving after watchdog flipped to `.failed` still wins (the message demonstrably reached the server).
- `.sent` and `.delivered` refuse the downgrade to `.failed` — this is the guard the gate report (W1) flagged as required for the watchdog race.
- `.sending` → `.sent` and `.sending` → `.delivered` and `.sending` → `.failed` are all valid.
- Unknown IDs return `.sending` from `state(for:)` — UI treats unknown as in-flight, never failed.

`retryPending() -> [String]` returns all `.failed` ids; call on socket reconnect, re-arm and re-send each with the same idempotency key.

### 2. LightweightContextEngine.swift — new struct

Stateless functional engine. Public surface:

```swift
LightweightContextEngine.inferTargetAgent(from:channel:)  -> LookAboveResult
LightweightContextEngine.inferRoute(messages:currentChannel:channelType:) -> RouteDecision
LightweightContextEngine.channelType(from:) -> InferredChannelType
```

Edge cases handled per brief:
- DM channel (`direct:<agentId>`) → short-circuit to `.explicit(agentId)`. Look-above does not apply — channel is the target.
- Last message from human → keep walking up to `lookAboveDepth = 3`.
- No agent in window → `.none` (composer should broadcast or prompt user).
- Confidence decays with depth: 1.0 immediately above, ~0.5 at depth 3, floored at 0.4.

### 3. MessageListView.swift — BUG-7 fix + look-above polish

**BUG-7 streaming churn fix (the B3 blocker from the gate report):**

The streaming row's view ID is now:

```swift
static func rowID(for message: Message) -> String {
    message.isStreaming ? "streaming-\(message.id)" : message.id
}
```

— stable across every delta within the same message. Whatever was previously keying off `updatedAt` (or any per-delta timestamp) is gone. SwiftUI no longer rebuilds the row on every delta tick, which removes the visible churn AND removes the indirect main-thread starvation that was tripping the 12s send watchdog (W1) on otherwise-fine messages during long streams.

**Look-above:** logic moved to `LightweightContextEngine`. `MessageListView.inferTargetAgent(from:channel:)` is the public helper ComposerBar calls — same signature as before from the composer's perspective, but now wraps the engine and emits a `#if DEBUG print` for inferred routes so testing surfaces routing decisions.

**Thinking dots:** `ThinkingDotsRow` is generic over agent name (works for Jon, Mack, Rex, anyone). Driven by `TimelineView(.animation(minimumInterval: 0.35))` instead of `withAnimation(...).repeatForever` — recovers cleanly when the row is re-created on `thinkingAgentId` change.

**Live roster:** `RosterRow` is value-typed (`AgentPresence` in, no `@ObservedObject`). When a single agent's presence changes, SwiftUI re-evaluates only that row's body — the rest of the sidebar is untouched. Pair with `ForEach(store.roster) { RosterRow(agent: $0) }` and `AgentPresence: Identifiable`.

---

## What Mack needs to do to integrate

### Step 0 — Sanity check (5 min)

Confirm the three files Jon owns are the only ones in the change set. If any of these landed, push back:
- `ContentView.swift`, `ComposerBar.swift`, `SettingsView.swift`
- `MessageBubble.swift`, `ThunderCommStore.swift`, `ThunderCommWebSocketClient.swift`
- `ThunderCommModels.swift` (see boundary section below)

### Step 1 — Drop in the new files (5 min)

```
apps/ios/ThunderCommIOS/DeliveryCore.swift              ← NEW
apps/ios/ThunderCommIOS/LightweightContextEngine.swift  ← NEW
apps/ios/ThunderCommIOS/MessageListView.swift           ← REPLACES existing
```

Add both new files to the Xcode project target.

### Step 2 — Wire DeliveryCore into ThunderCommStore (15 min)

Inside `ThunderCommStore`:

```swift
private let delivery = DeliveryCore()

// On send dispatch:
Task { await delivery.arm(messageId: id) }

// On bridge ack:
Task { await delivery.markSent(messageId: id) }

// On read receipt / delivered confirmation:
Task { await delivery.markDelivered(messageId: id) }

// On watchdog fire (12s):
Task {
    // The state guard inside the timer fire that W1 flagged.
    let current = await delivery.state(for: id)
    guard current == .sending else { return }
    await delivery.markFailed(messageId: id)
    // ...update UI
}

// On socket reconnect:
let toRetry = await delivery.retryPending()
for id in toRetry { /* re-arm and re-send with same idempotencyKey */ }
```

The actor's transition rules already prevent the late-fire watchdog from clobbering `.delivered` — but keep the explicit `state == .sending` guard at the call site too. Belt and suspenders is correct here.

### Step 3 — Verify the contract MessageListView expects (10 min)

`MessageListView` reads these from `ThunderCommStore`:

| Property / method | Type | Notes |
|---|---|---|
| `visibleMessages` | `[Message]` | Already-filtered list for current channel-stream. If you currently expose `messages`, alias or rename. |
| `thinkingAgentId` | `String?` | Already exists per gate report's regression-check section. |
| `displayName(forAgent:)` | `(String) -> String?` | If you don't have this, add a one-liner: `roster.first { $0.id == agentId }?.name`. |

And these on `Message`:

| Field | Type | Notes |
|---|---|---|
| `id` | `String` | Already exists. |
| `agentId` | `String?` | Already exists per wire protocol. |
| `sender` | `String?` | Already exists per wire protocol. |
| `channel` | `String` | Already exists. |
| `isStreaming` | `Bool` | **Verify this exists.** If you currently track via `updatedAt != nil` or a state enum, expose a computed `var isStreaming: Bool { ... }` on Message. Required for BUG-7 fix to key correctly. |

`Message` already conforms to `Identifiable` per the existing `ForEach(store.visibleMessages)` usage — no change needed.

### Step 4 — Verify AgentPresence exists with the expected fields

`RosterRow` reads:
- `agent.id` (for `Identifiable`)
- `agent.name`
- `agent.isOnline` — if your roster type uses an enum (`status: .online | .offline`), add a one-line computed:
  ```swift
  extension AgentPresence {
      var isOnline: Bool { status == .online }
  }
  ```

If your type is named differently (`AgentStatus`, `RosterEntry`, etc.), update the `RosterRow` struct in `MessageListView.swift` to reference it.

### Step 5 — Build, smoke-test (15 min)

Smoke test plan:
1. Send a message in #tnt without naming an agent after Jon spoke → routes to Jon. Debug console shows `[look-above] inferred jon (confidence 1.00) on channel tnt`.
2. Send in `direct:jon` → routes to Jon directly (debug log absent — no inference needed).
3. Trigger a long streaming reply (>10s). Confirm:
   - No view churn / flicker on the streaming row.
   - Watchdog does not fire on the user's last sent message during the stream.
   - Thinking dots animate smoothly above the streaming row, then hide once the stream completes.
4. Toggle one agent offline (drop the bridge connection from that agent's side). Confirm only that row's presence dot redraws — no full sidebar re-render visible.
5. Send a message, then immediately drop the network. Confirm watchdog flips to `.failed` after 12s, message gets red retry affordance, reconnect → `retryPending()` re-sends with same idempotency key, server dedupes, message lands.

---

## Boundary: ThunderCommModels.swift

**Required model changes: NONE** — assuming the fields above already exist as documented in the wire protocol handoff.

**Verify before integrating:**

1. `Message.isStreaming: Bool` — if not present, this is the only model addition needed. Could be:
   ```swift
   var isStreaming: Bool { updatedAt != nil && deliveryState != .delivered }
   ```
   or a stored property set explicitly by the streaming pipeline. **Mack: confirm which pattern matches the current code and add the computed property if missing.** Do not let me guess at the model — flag back if this is non-trivial.

2. `AgentPresence` field naming — see Step 4. A one-line extension covers any naming mismatch; no struct edits needed.

3. `DeliveryState` — there may already be a delivery-state enum on Message itself. The new `DeliveryCore.DeliveryState` is intentionally a separate type so the actor doesn't depend on Message. If Mack wants them unified, the cleanest path is:
   - Keep `DeliveryCore.DeliveryState` as the canonical type.
   - Have `Message.deliveryState` be a `DeliveryCore.DeliveryState` (typealias if needed).
   - The store updates `Message.deliveryState` from the actor snapshot.

---

## Things flagged for Mack's attention

1. **BUG-7 fix is what unblocks B3 in the gate report.** Once integrated, B3 is resolved without raising the watchdog timeout. (W1's other requirements — state guard in fire handler + per-message cancel token — still apply; those live in `ThunderCommStore`, not in this slice.)

2. **`Message: LookAboveMessage` extension** is at the top of `MessageListView.swift`. If `Message` lives in a different module than `LightweightContextEngine` after integration (it shouldn't — same target), the extension may need to move.

3. **Roster ForEach efficiency** depends on `AgentPresence: Identifiable` with `id == agentId` (not array index). If your current roster uses indices, fix that — otherwise the "only-affected-row redraws" property doesn't hold.

4. **Debug logs** in `inferTargetAgent` are gated `#if DEBUG`. They're load-bearing for the gate-report's "log inferred routing at debug level" requirement, so keep them in. They strip in release builds.

5. **No bridge.mjs changes from this slice.** Jon's iOS slice is iOS-only. The 8s sliding window question (W4 in gate report) is unrelated and stays in Mack's lane.

---

## Test plan (post-integration, on device)

- [ ] Cold start, no signed-in user → app does not crash on identity resolution.
- [ ] Send in #tnt → look-above routes to last agent speaker. Verify in debug console.
- [ ] Send in direct:jon → goes to Jon, no look-above log.
- [ ] Stream a long reply (>10 seconds) → no row churn, no false `.failed`.
- [ ] Pull network during send → after 12s, message marked `.failed` with retry affordance.
- [ ] Reconnect → `.failed` messages re-send with same idempotency key, server dedupes.
- [ ] Two agents online simultaneously, both thinking → dots show for the agent whose `thinkingAgentId` is set (most recent).
- [ ] Toggle agent presence → only that roster row redraws (verify with SwiftUI debug overlay if needed).

---

## What I did NOT touch

Per the brief: `ContentView.swift`, `ComposerBar.swift`, `SettingsView.swift`, `MessageBubble.swift`, `ThunderCommStore.swift`, `ThunderCommWebSocketClient.swift`, `ThunderCommModels.swift`. Any of those changes are Mack's lane. If something in here looks like it requires a change to one of them, that's a coordination gap — flag back and we'll rework the slice.
