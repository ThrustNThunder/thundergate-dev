# ThunderCommo Build 24 — Pressure Test Report

**Reviewer:** CLI Jon (combined-pass pressure test)
**Date:** 2026-05-10
**Method:** Direct source review of Jon's 3 slice files (`DeliveryCore.swift`, `LightweightContextEngine.swift`, `MessageListView.swift`); spec/notes-only review for Mack's 11 files (still on his Mac at `repos/thundergate-sparse`).
**Inputs read:**
- `/home/ubuntu/thundergate-dev/ios-jon-slice/DeliveryCore.swift`
- `/home/ubuntu/thundergate-dev/ios-jon-slice/LightweightContextEngine.swift`
- `/home/ubuntu/thundergate-dev/ios-jon-slice/MessageListView.swift`
- `/home/ubuntu/thundergate-dev/ios-jon-slice/IOS_SLICE_NOTES.md`
- `THUNDERCOMMO_BUILD24_PRESSURE_TEST_BRIEF.md`
- `THUNDERCOMMO_BUILD24_GATE_REPORT.md`
- `THUNDERCOMMO_BUILD24_GATE_BRIEF.md`
- `THUNDERCOMMO_IOS_BUILD24_BRIEF.md`

---

## Verdict: CONDITIONAL PASS

Jon's slice is **clean and correct at the file level**. BUG-7 (B3 from the gate report) is verifiably resolved in source. The DeliveryCore actor's monotonic transitions are correctly designed and will hold the W1 watchdog-race line at the data layer. LightweightContextEngine is pure, testable, and correctly handles DM short-circuit + look-above with confidence decay.

However, this pass uncovers **one new concern in Jon's MessageListView (history gating regression risk)** plus carries forward five items from the gate report that still live in Mack's lane and must be verified at integration time. None require an architectural rewrite.

If Mack confirms all CONDITIONAL items in §"Exact fixes Mack must apply" below, this is **green to ship to TestFlight**.

---

## Section A — Architecture + logic correctness

### A.1 DeliveryCore actor integration — PASS (data layer) / CONDITIONAL (wiring)

**Verified directly in `DeliveryCore.swift`:**
- `arm(messageId:)` sets `.sending` (line 31–33). ✓
- `markSent(messageId:)` refuses downgrade from `.delivered`/`.failed` (line 35–46). ✓
- `markDelivered(messageId:)` is unconditional — sticky terminal-positive (line 51–53). ✓
- `markFailed(messageId:)` refuses downgrade from `.sent`/`.delivered` (line 57–68). This is the W1 race guard at the data layer — a late-fire watchdog cannot clobber `.delivered`. ✓
- `state(for:)` returns `.sending` for unknown IDs (line 73–75). UI treats unknowns as in-flight. ✓
- `retryPending()` returns `.failed` IDs only (line 77–79). ✓
- `clear(messageId:)` and `snapshot()` round out the API. ✓
- Actor isolation means call-sites can `await` from any context (watchdog, ack handler, reconnect loop) without races.

**CONDITIONAL on Mack's `ThunderCommStore` wiring** (cannot be verified from this slice — code is on Mack's Mac):
- `arm()` called on send dispatch.
- `markSent()` called on bridge ack.
- `markDelivered()` called on read receipt / delivered confirmation.
- Watchdog fire path uses the **belt + suspenders** guard from IOS_SLICE_NOTES.md Step 2:
  ```swift
  let current = await delivery.state(for: id)
  guard current == .sending else { return }
  await delivery.markFailed(messageId: id)
  ```
- Watchdog timer is **per-message and cancelled in the ack handler** (W1.2 from gate report). The actor will protect state correctness even if the timer fires late, but a stuck cancel-token leaks a Task per message; verify cancellation.
- Reconnect loop calls `retryPending()` and re-arms each ID with the **same idempotency key**.

### A.2 LightweightContextEngine wiring — PASS

**Verified directly in `LightweightContextEngine.swift` and `MessageListView.swift`:**
- `Message: LookAboveMessage` conformance is at MessageListView.swift:22 — keeps the engine free of Mack's full `Message` type. ✓
- Same Xcode target, no `import` needed.
- DM short-circuit: `channelType(from:)` parses `direct:<agentId>` (LightweightContextEngine.swift:60–66) and `inferTargetAgent` returns `.explicit(agentId)` immediately for DMs (line 81–83). ✓
- Multi-agent walk: `messages.filter { $0.channel == channel }.suffix(3).reversed()` then iterates with `enumerated()` (line 85–101). ✓
- Confidence decay: `1.0 - offset * 0.25`, floored at `0.4`. At depth 3 → `0.5`; floor of `0.4` is unreachable within `lookAboveDepth = 3` and exists only as a safety floor. Math is correct. ✓
- Debug log at MessageListView.swift:107–115 — `.inferred` and `.none` both log under `#if DEBUG`; `.explicit` (DM) deliberately does not (no inference performed). ✓ matches gate report's "log inferred routing at debug level" requirement.
- Empty-string `agentId` is correctly skipped (line 93: `!agentId.isEmpty`). ✓

### A.3 MessageListView BUG-7 verification — PASS (verifiable in source)

**Verified directly in `MessageListView.swift`:**
- `rowID(for:)` at line 83–85:
  ```swift
  message.isStreaming ? "streaming-\(message.id)" : message.id
  ```
  Stable across deltas within a single streaming session. ✓
- **No `updatedAt` references anywhere in the file.** ✓ (B3 blocker from the gate report is resolved by this slice.)
- Thinking dots use `TimelineView(.animation(minimumInterval: 0.35))` (line 132) — not `withAnimation(...).repeatForever`. Animation context is independent of row identity, survives row re-creation. ✓
- `RosterRow` is a value-typed `struct` with `let agent: AgentPresence` (line 160–175). No `@ObservedObject` / class reference. ✓ — **assuming** Mack's `AgentPresence` is itself a struct (see WARNING-3).

**Subtle behavior worth noting** (not a defect): when `isStreaming` flips false at end-of-stream, `rowID` changes from `"streaming-X"` to `"X"`. SwiftUI sees this as a row swap. Per the inline comment, this is deliberate and useful for end-of-stream styling. NOTE only.

### A.4 Bridge multi-block routing (8s sliding window) — NOT VERIFIABLE FROM SLICE

`bridge.mjs` is on Mack's Mac. Cannot verify directly. Gate report W4 already flagged the deviation (8s sliding window vs. spec's turn-id) with three required conditions:
- (a) window resets on every block (true sliding) — change-summary language ("8s sliding window multi-block routing") is **consistent** with reset-per-block.
- (b) stream-end signal closes the window early — **unstated** in change summary; flagged as carry-forward warning below.
- (c) misroute case logs at warn level — **unstated**; flagged as carry-forward warning.

### A.5 Identity (no `ios-michael-*` anywhere) — NOT VERIFIABLE FROM SLICE

Identity code lives in Mack's `ThunderCommStore.swift` and `ThunderCommModels.swift`, neither of which is in Jon's slice. The three gate-report items (B1: generic `mappedCanonicalID`, W2: per-userKey storage scoping, W3: pre-auth sentinel) carry forward unchanged.

---

## Section B — Regression check

### `inferDirectAgentIDIfNeeded` look-above — PASS

Logic is now in `LightweightContextEngine.inferTargetAgent`, surfaced to ComposerBar via the `MessageListView.inferTargetAgent(from:channel:)` static helper (line 96–117). Same call-site signature as before from the composer's side. DM short-circuit is preserved.

### `pendingResponseChannels` queue (single-text turns pop once) — NOT VERIFIABLE FROM SLICE

bridge.mjs concern. Carry-forward.

### Sent/delivered indicators (✓ / ✓✓) — NOT VERIFIABLE FROM SLICE

`MessageBubble.swift` is in Mack's lane. Per gate report, badges are preserved.

### History gating (`didInitialScroll` guard untouched) — **WARNING (new finding)**

This is **the only new concern Jon's slice introduces**. `MessageListView.swift:52–57`:

```swift
.onChange(of: store.visibleMessages.count) { _ in
    guard let last = store.visibleMessages.last else { return }
    withAnimation(.easeOut(duration: 0.15)) {
        proxy.scrollTo(Self.rowID(for: last), anchor: .bottom)
    }
}
```

There is **no `didInitialScroll` guard** in this onChange. Every time `visibleMessages.count` changes, it animates a scroll-to-bottom.

- If `ThunderCommStore` hydrates initial history as a **single batched assignment**, count changes once, scroll fires once — fine.
- If `ThunderCommStore` streams hydration **row-by-row** (e.g., async page-in), count changes N times, scroll-with-animation fires N times — visible thrash on cold start, and on a slow device this can starve the main thread enough to interact badly with the 12s send watchdog (the same coupling the BUG-7 fix was meant to break).

The IOS_SLICE_NOTES.md "What I did NOT touch" list explicitly claims `didInitialScroll` is untouched, but the gate report places that guard's behavior conceptually in MessageListView's scroll handler. Either (a) the guard always lived on the store side (count is gated upstream), in which case Jon's onChange is fine and the claim is consistent; or (b) Mack's prior MessageListView had a guard at this exact onChange and Jon dropped it.

**Required check at integration**: confirm initial hydration is a single batched assignment, OR restore the guard at the onChange:
```swift
@State private var didInitialScroll = false
// ...
.onChange(of: store.visibleMessages.count) { _ in
    guard let last = store.visibleMessages.last else { return }
    if !didInitialScroll {
        proxy.scrollTo(Self.rowID(for: last), anchor: .bottom)
        didInitialScroll = true
    } else {
        withAnimation(.easeOut(duration: 0.15)) {
            proxy.scrollTo(Self.rowID(for: last), anchor: .bottom)
        }
    }
}
```

### Code block copy button — UNTOUCHED (Mack's lane, regression-safe by omission)

### Federation 45s idle terminate + 15s ping — UNTOUCHED (bridge.mjs heartbeat logic outside the 8s-window addition)

---

## Section C — Integration completeness

| Item | Status |
|---|---|
| `DeliveryCore.swift` present | ✓ in `ios-jon-slice/`. Mack must move to `apps/ios/ThunderCommIOS/`. |
| `LightweightContextEngine.swift` present | ✓ in `ios-jon-slice/`. Mack must move to `apps/ios/ThunderCommIOS/`. |
| `MessageListView.swift` present (supersedes Mack's) | ✓ in `ios-jon-slice/`. Mack must overwrite his version. |
| `Message.isStreaming` exists | **NOT VERIFIABLE.** Per IOS_SLICE_NOTES Step 3 + the pressure brief: if not present, add `var isStreaming: Bool { deliveryState == .sending && !text.isEmpty }`. **Required at integration.** |
| `extension Message: LookAboveMessage {}` | ✓ at MessageListView.swift:22. Will compile only if `Message` exposes `id`/`agentId`/`sender`/`channel` (per IOS_SLICE_NOTES Step 3 these fields already exist on Mack's `Message`). |
| Xcode project target membership for both new files | **Mack's responsibility.** Add to `TARGETS → ThunderCommIOS`. |
| No import cycles | ✓ DeliveryCore: `Foundation` only. LightweightContextEngine: `Foundation` only. MessageListView: `SwiftUI`. None of Jon's files import each other; they share types in the same module. No cycle. |

---

## Section D — Build safety

### Force-unwraps on critical paths — PASS in Jon's slice

- `DeliveryCore.swift`: zero `!` operators. ✓
- `LightweightContextEngine.swift`: zero `!` operators. ✓
- `MessageListView.swift`: zero force-unwraps; uses `if let agentId = store.thinkingAgentId` (line 40), safe `guard let last` in onChange (line 53), safe `guard let agentId` in second onChange (line 59). ✓

(Send/auth/identity force-unwraps live in `ThunderCommStore.swift` / `ThunderCommModels.swift` — Mack's lane; carry forward.)

### MainActor violations in watchdog timer code — PASS at the actor; CONDITIONAL at the call site

`DeliveryCore` is an `actor`, so all mutations are serialized. The watchdog fire handler must still be `@MainActor` if it pokes `@Published` state on `ThunderCommStore` after `await delivery.markFailed(...)`. The recipe in IOS_SLICE_NOTES.md Step 2 doesn't make this explicit — flag for Mack to confirm.

### Keychain access group (W6) — NOT VERIFIABLE FROM SLICE

Identity storage is Mack's lane. The W6 carry-forward from the gate report stands: this is the suspected Build 21 device-crash root cause. **Do not skip.**

### `bridge.mjs node --check` passes — NOT VERIFIABLE FROM SLICE

Mack's lane.

---

## Issue summary

### BLOCKERS

None new in Jon's slice. **Carry from gate report:**
- **B1** (Mack-side): `mappedCanonicalID` must be generic over `userKey` — `^ios-([^-]+)-[0-9a-f-]+$` or equivalent capture-group, not a switch over known handles.
- **B2** (Mack-side): Zero remaining references to `showingConnectionSettings`, `ellipsis`, or removed-menu state in `ContentView.swift` (including inside `.sheet(...)`, `.confirmationDialog`, `onAppear`).
- **B3 (BUG-7)**: ✅ **RESOLVED by this slice** — verified at MessageListView.swift:83–85.

### WARNINGS

1. **History gating regression risk** (new — Jon's MessageListView). `didInitialScroll` guard absent at MessageListView.swift:52–57. Verify batched hydration in `ThunderCommStore`, or restore the guard. See §B above for a drop-in restoration pattern.
2. **W1 carry-forward** (Mack-side): Watchdog fire handler must (a) re-check `state == .sending` at the call site (belt + suspenders with the actor), and (b) cancel its per-message Task in the ack path. The actor enforces correctness regardless, but a leaked Task per stuck message accumulates over a long session.
3. **W2 carry-forward** (Mack-side): Peer-ID storage key includes `userKey` (e.g. `peerId.<userKey>`), not a single global `peerId`. Sign-out/sign-up cycle must not recycle a UUID across user accounts.
4. **W3 carry-forward** (Mack-side): Pre-auth callers either skip identity or pass a sentinel `userKey` (`"anonymous"`). Empty string would produce `ios--<uuid>` which fails the generic prefix-strip.
5. **W4 carry-forward** (Mack-side, bridge.mjs): Confirm 8s window resets per-block from same agent. Confirm `>8s` mid-turn pause fallback to `#tnt` is **logged at warn level** (not silently dropped). Confirm a stream-end signal closes the window early (or document the absence in INTEGRATION_NOTES as a known Build-25 follow-up).
6. **W6 carry-forward** (Mack-side): Keychain access group matches device entitlement (suspected Build 21 device-crash root cause). Do not skip — this is a literal continuation of that crash if identity is in Keychain.
7. **AgentPresence assumed struct.** `RosterRow` declares `let agent: AgentPresence`. The "only-affected-row redraws" property holds **only** if `AgentPresence` is a struct. If it is a class (or wraps `@ObservedObject`-style state), the value-type efficiency claim is false. **Required check** per IOS_SLICE_NOTES Step 4.

### NOTES

- `retryPending()` returns only `.failed` IDs. In-flight `.sending` messages from before a reconnect rely on the 12s watchdog catching them (not on `retryPending`). Defensible — the watchdog is the authority. Document in INTEGRATION_NOTES.
- `markFailed` on an unknown ID **creates** a `.failed` entry (DeliveryCore.swift:58–60). With correct wiring (`arm()` strictly before any watchdog timer is set) this is unreachable, so it's a defensive choice, not a bug. Worth a one-line note for whoever next touches the actor.
- Debug `print` at MessageListView.swift:107–115 is `#if DEBUG`-gated and strips in release. Load-bearing for the gate-report's debug-logging requirement; do not remove.
- Header is "3-row card" vs. spec's single-row (gate report N1) — accepted deviation, no action.
- `+` menu duplicates sidebar `+` affordances (gate report N2) — accepted deviation, post-ship cleanup.

---

## Exact fixes Mack must apply before integrating

In order, expected to take 60–90 minutes total:

1. **Move Jon's 3 files** from `/home/ubuntu/thundergate-dev/ios-jon-slice/` (Jon side) into `apps/ios/ThunderCommIOS/` (Mack side):
   - `DeliveryCore.swift` (NEW)
   - `LightweightContextEngine.swift` (NEW)
   - `MessageListView.swift` (REPLACES Mack's CLI Jon's version — Mack's version may have partial overlap; Jon's is authoritative for this file)
2. **Add both new files to `TARGETS → ThunderCommIOS`** in the Xcode project. Without target membership the build fails fast — caught at compile.
3. **Verify or add `Message.isStreaming`** in `ThunderCommModels.swift`. Per the pressure brief, the recommended computed:
   ```swift
   var isStreaming: Bool { deliveryState == .sending && !text.isEmpty }
   ```
4. **Verify `AgentPresence` is a struct** with `id`, `name`, `isOnline`. If `isOnline` is computed from a status enum, add the one-line extension from IOS_SLICE_NOTES Step 4.
5. **Wire `DeliveryCore` into `ThunderCommStore`** per IOS_SLICE_NOTES Step 2 — `arm` / `markSent` / `markDelivered` / `markFailed` at the appropriate hooks; **per-message cancel token** for the watchdog (W1.2); reconnect loop calls `retryPending()` and re-sends with the **same idempotency key**.
6. **Verify history hydration is batched** in `ThunderCommStore` — OR restore the `didInitialScroll` guard in MessageListView's onChange (drop-in pattern in §B above).
7. **Run the gate-report Mack-side checks (B1, B2, W2, W3, W4, W6)** before Build 24 ships:
   - B1: `mappedCanonicalID` is a generic regex.
   - B2: zero dead references to ellipsis-menu state.
   - W2: peer-ID storage key includes `userKey`.
   - W3: pre-auth callers skip identity or pass sentinel.
   - W4: `bridge.mjs` 8s window resets per-block, fallback logged at warn.
   - W6: Keychain access group matches device entitlement (Build 21 crash root cause).
8. **`node --check extensions/thundercomm/bridge.mjs`** — must parse cleanly.
9. **Smoke test (per IOS_SLICE_NOTES Step 5)** on device, not simulator (W6 is a device-only failure mode):
   - Cold start without signed-in user → does not crash on identity resolution (W3).
   - Send in `#tnt` after Jon spoke → routes to Jon, debug log shows `[look-above] inferred jon (confidence 1.00)`.
   - Send in `direct:jon` → routes directly, no `[look-above]` log.
   - Long stream (>10s) → no row churn, no spurious `.failed` flap (BUG-7 + W1).
   - Drop network mid-send → `.failed` after 12s with retry affordance; reconnect re-sends with same idempotency key, server dedupes.
   - Toggle one agent's presence → only that roster row redraws (verify with SwiftUI debug overlay).

If items 1–8 land clean and item 9's smoke test passes on device, **green to ship Build 24 to TestFlight**.

---

## Notes on review limits

I directly reviewed Jon's 3 Swift files at the source level. For Mack's 11 files, I reasoned from `THUNDERCOMMO_BUILD24_GATE_BRIEF.md` (change summary), `THUNDERCOMMO_BUILD24_GATE_REPORT.md` (logic-level analysis), and `IOS_SLICE_NOTES.md` (integration recipe). The carry-forward warnings (W1, W2, W3, W4, W6) and remaining blockers (B1, B2) from the gate report are not re-verified here — they remain Mack-side checks. If any returns an unexpected result, escalate before integrating.
