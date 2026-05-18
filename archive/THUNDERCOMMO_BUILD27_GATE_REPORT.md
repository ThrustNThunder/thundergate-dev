# ThunderCommo Build 27 — Gate Report

**Reviewer:** CLI Jon (logic review, no direct source access for Mack's 4 files)
**Date:** 2026-05-10
**Method:** Spec-vs-implementation analysis against `BUILD27_GATE_BRIEF.md`. The four files in this build (`ThunderCommWebSocketClient.swift`, `MessageBubble.swift`, `MessageListView.swift`, `ContentView.swift`) all live on Mack's Mac in `repos/thundergate-sparse`. My local copy of `MessageListView.swift` is the Build 23/24 version (no `localPeerId` parameter yet) and was not used to verify Build 27 behavior. This report flags logic concerns Mack must verify in source before integrating.
**Inputs read:**
- `BUILD27_GATE_BRIEF.md`
- `THUNDERCOMMO_BUILD24_GATE_REPORT.md` (carry-forward regression context)
- `THUNDERCOMMO_BUILD24_PRESSURE_REPORT.md` (DeliveryCore / WSClient wiring context)
- `THUNDERCOMMO_IOS_BUILD24_BRIEF.md` (identity + delivery state spec)
- `ios-jon-slice/MessageListView.swift`, `DeliveryCore.swift`, `LightweightContextEngine.swift`, `IOS_SLICE_NOTES.md`

---

## Verdict: CONDITIONAL PASS

The shape of the `connectionEpoch` fix is exactly the right pattern for the reconnect-loop bug described, and the peer-identity alignment change is a clean follow-on to BUG-8 from Build 24. **There is nothing in the brief that suggests Mack reached for the wrong tool.**

However, an epoch guard is a pattern with several failure modes if any one site is missed, and the brief describes the change at the level of intent ("Added `connectionEpoch` guard"; "Old socket callbacks ignored once newer connection is live") not at the level of code. I cannot verify from the brief alone that **every** stale-callback path is gated, that the epoch variable is thread-safe, or that intentional disconnect invalidates the live epoch. Section A below enumerates the exact invariants Mack must confirm in source. If items A1–A6 and B1–B3 check out, this is **green to build and ship Build 27**.

---

## Section A — `connectionEpoch` guard (CRITICAL — the reason for the build)

The pattern is correct: a monotonically increasing counter, captured by value into each connection attempt's closures, used to short-circuit any callback whose captured epoch no longer matches `self.connectionEpoch`. The bug being fixed (self-inflicted reconnect cycling) happens when an *old* socket's ping-timeout / auth-timeout / receive-error callback fires *after* a newer connection is already live and triggers a reconnect on the live connection — which kills it, which triggers another reconnect from the new old socket, which… loops. The epoch is the right cut.

But the pattern only works if **every** stale path is gated and the counter itself is race-free. Six invariants must hold.

### A1. Epoch increments on every new connection *attempt*, not just successful connection — BLOCKER

The bump must happen at the **start** of `connect()` (before the `URLSessionWebSocketTask` is created and before any closure captures it), not after the connection opens. Reasoning: if epoch increments only on successful `didOpen`, then a stale callback from a previous *failed-but-still-in-flight* connection can fire during the new attempt's setup phase and the epoch comparison won't catch it (the stale closure's `myEpoch` still matches `self.connectionEpoch` because the new attempt hasn't bumped yet).

**Required check:** the first line of the connect path (whether named `connect()`, `reconnect()`, `establishSocket()`, etc.) is `connectionEpoch += 1` (or equivalent), and **every** closure that gets passed to the new `URLSessionWebSocketTask` captures the post-bump value into a local `let myEpoch = connectionEpoch` BEFORE the closure is created. Standard pattern:

```swift
func connect() {
    connectionEpoch &+= 1
    let myEpoch = connectionEpoch
    let task = session.webSocketTask(with: ...)
    task.receive { [weak self] result in
        guard let self, myEpoch == self.connectionEpoch else { return }
        // ... handle result
    }
    // same for send completion, ping, auth timer, error handler, close handler
}
```

If `myEpoch` is read from `self.connectionEpoch` *inside* the closure instead of captured at site, the guard does nothing — the closure will always see whatever the current epoch is.

### A2. Coverage: every async callback gates on epoch — BLOCKER

The brief lists "stale receive, send, ping, auth-timeout reconnect triggers." That is the right set, but easy to under-cover. The complete set:

| Callback site | Must gate? | Why |
|---|---|---|
| `task.receive { … }` continuation | YES | A stale message-decode that fails could trigger reconnect on the live socket |
| `task.send(.string …) { error in … }` completion | YES | A stale send-error from the old socket would mis-mark `.failed` on a message that's actually in flight on the new socket |
| `task.sendPing { error in … }` completion | YES | Stale ping-failure → reconnect on live socket = the original bug |
| Auth/connect timeout `Task { try? await Task.sleep …; if !authenticated { … } }` | YES | Stale auth timeout firing on a newer authenticated socket → forced reconnect |
| Idle / keepalive timer firing | YES | If the WS client has its own client-side keepalive (separate from relay's 20s server-side ping per the brief) |
| `URLSessionDelegate` callbacks (`didOpen`, `didClose`, `didCompleteWithError`) | YES | Stale `didClose` for a previous task would trigger reconnect on a live connection |
| Outbound message queue drain on (re)connect | YES | A stale `Task` flushing the queue against an old task's send method needs to bail; otherwise it's calling `.send` on a torn-down socket |
| The reconnect trigger itself (`triggerReconnect()` / `scheduleReconnect()` — whatever the function is called) | YES — see A3 | This is the single most important gate |

**Required check:** open `ThunderCommWebSocketClient.swift`, search for every closure / `Task { … }` block that references `self`. Each one needs the epoch-equality guard, OR it must be unambiguously called only from a code path that already gated. There is no acceptable "this one is fine because it only runs once" — the bug is precisely that callbacks run when you don't expect them to.

### A3. The reconnect trigger itself must check epoch — BLOCKER

This is the highest-leverage gate. Even if every individual callback gates, if there is a `func handleConnectionFailure()` (or `triggerReconnect()`, `scheduleReconnect()`, etc.) that all those callbacks funnel into — that function must ALSO check epoch before initiating a new connect. Reasoning: defense in depth. A stale callback that slipped past its individual gate (e.g. a code path added in a future change that forgot to gate) can still be stopped if the reconnect funnel itself gates.

Concretely:

```swift
private func triggerReconnect(myEpoch: Int) {
    guard myEpoch == self.connectionEpoch else { return }
    // proceed with reconnect (which will itself bump epoch)
}
```

All call sites of `triggerReconnect` must pass their captured `myEpoch` in, not read `self.connectionEpoch` inside the function.

**Required check:** find the reconnect entry point. Confirm it takes an `epoch:` parameter (or equivalent) and gates on it.

### A4. Thread safety on the epoch variable — BLOCKER (gate brief D3)

If `connectionEpoch` is a plain `var Int` on the client class and is read from `URLSession`'s delegate queue (default: a private background queue) while being written from MainActor (the typical connect-from-UI path), this is a data race. Swift 6 will refuse to compile it; Swift 5 will compile and ship a heisenbug — the comparison `myEpoch == self.connectionEpoch` reads an `Int` that may be torn on a 32-bit value but is almost always atomic on 64-bit ARM, so the bug is "appears to work, then misbehaves under timing pressure" — exactly the class of bug Build 27 is trying to fix.

**Acceptable patterns** (any one of these):
- The whole client is `@MainActor`-isolated. Every callback hops to MainActor before reading/writing epoch. (Simplest; matches the SwiftUI ownership model.)
- The epoch lives inside an `actor` (e.g. `actor ConnectionEpochStore { var current: Int = 0 }`) and reads/writes go through `await`.
- The epoch is read/written through a dedicated serial `DispatchQueue` with sync barriers.
- The epoch is an `OSAllocatedUnfairLock<Int>` (iOS 16+) or `os_unfair_lock`-protected `Int`.

**Unacceptable patterns:**
- Bare `var connectionEpoch: Int` on a non-actor class with no isolation, read/written from multiple contexts. Even if it "works" today, this is a latent race.
- `@Published var connectionEpoch` without `@MainActor` — `@Published`'s write triggers `objectWillChange.send()`, which is itself MainActor-isolated; reading on a background queue is unsafe.

**Required check:** how is `connectionEpoch` declared? If it's bare `var Int` on a non-actor class, this is a build-safety fail per gate-brief D3 and must be fixed before ship.

**Subtle point on capture-by-value:** capturing `let myEpoch = connectionEpoch` *into* a closure is safe (Int is a value type) — but the *read* at the site of `let myEpoch = …` and the *read* of `self.connectionEpoch` inside the closure's guard must both be on the same isolation domain as writes. If the client is `@MainActor`, both must be on MainActor; the closure body's guard read needs to be from a `Task { @MainActor in … }` hop unless URLSession's delegate already delivers on MainActor (it doesn't by default).

### A5. Intentional disconnect invalidates the epoch — BLOCKER (gate brief A edge case 2)

The brief calls this out explicitly. On sign-out / explicit `disconnect()`, the user expects all pending callbacks to be no-ops. The fix: `disconnect()` increments the epoch before tearing down the task. Any callback that was already enqueued from the old task will see `myEpoch != self.connectionEpoch` and bail.

**Required check:** `disconnect()` (or whatever the explicit-teardown method is called) bumps `connectionEpoch` *before* calling `task.cancel(with: .goingAway, reason: nil)`. If the bump happens after, there's a small window where a stale auth-timeout could fire reconnect *after* the user signed out — exactly the scenario the brief asks about.

Equally important: after `disconnect()`, the client should NOT reconnect automatically. If reconnect logic is keyed off "did the previous task end without an intentional close?", confirm that the intentional-close path is distinguished from the error-close path. A common pattern is a `private var intentionallyDisconnected: Bool` flag that's set in `disconnect()` and checked in any close-handler before scheduling reconnect. With the epoch guard in place, this flag may be redundant — but it's belt-and-suspenders, and the gate brief asks for it.

### A6. Two-connection race: latest epoch wins — BLOCKER (gate brief A edge case 1)

If `connect()` is called twice in quick succession (e.g. user taps reconnect twice, or reconnect logic and a sign-in flow race), there will be two `URLSessionWebSocketTask` instances alive briefly with `myEpoch = N` and `myEpoch = N+1`. The first one's callbacks must bail (their `myEpoch == N` no longer matches `self.connectionEpoch == N+1`). The second one's callbacks proceed.

This falls out automatically from invariant A1 (bump on every attempt). But verify that:

1. The old task is explicitly cancelled when a new connect starts — otherwise the old socket may keep delivering messages that get correctly ignored by the epoch guard, but burns network and battery until iOS times it out. Standard pattern: `oldTask?.cancel(with: .goingAway, reason: nil)` before creating the new task. The cancel triggers a `didClose` callback on the old task, which the epoch guard correctly ignores — so this is purely an efficiency consideration, not a correctness one.
2. The old task's `URLSessionDelegate` callbacks (which fire from the cancel) are gated. Per A2 this is required anyway.

**Required check:** in `connect()`, is there a `previousTask?.cancel(...)` before the new task is created? If not, the bug still doesn't manifest (epoch guard catches it), but file as a follow-up cleanup.

---

## Section B — Peer identity for message alignment

The brief describes the change at the right level: `localPeerId` flows ThunderCommStore → ContentView → MessageListView → MessageBubble, and `MessageBubble` switches alignment off peerId match instead of display-name match. This is the right fix for BUG-8 (identity resolution incidental) from the Build 24 spec — that bug was flagged P1 ("fragile, works by fallback").

### B1. Verify the full data flow — BLOCKER (gate brief B)

Concrete chain of reads/passes Mack must confirm:

1. **`ThunderCommStore.peerId: String?`** — the canonical local peer ID from auth. Per Build 24, this is `ios-<userKey>-<uuid>` after sign-in, or `nil`/anonymous-sentinel pre-auth. Verify the type matches whatever `MessageBubble` expects (String vs String? — see B3).
2. **`ContentView` reads `store.peerId`** and passes it into `MessageListView` as `localPeerId`. Required check: is `store` observed (`@ObservedObject` / `@StateObject`)? If `peerId` is set asynchronously *after* `ContentView` first renders, the view must re-render when it updates. Otherwise: first message after sign-in renders with `localPeerId == nil` and aligns wrong, then the bubble's identity never recomputes when `peerId` later populates because the bubble has captured a stale value.
3. **`MessageListView` passes `localPeerId` to each `MessageBubble`.** Required check: it's passed as a parameter, not read from a singleton or environment. The brief's title for this file ("Passes `localPeerId` through to bubbles") supports the parameter approach; verify in source.
4. **`MessageBubble` compares** `message.senderId` (or `message.peerId` — whichever field carries the originator's canonical ID; **NOT** `message.senderName` / display name) to `localPeerId`. If equal → right-align. If not equal → left-align.

### B2. Pre-auth / no-`peerId` fallback — BLOCKER (gate brief B edge case)

The brief raises this directly: "first launch before peerId is set — should default to right-align for all human messages? Or no alignment until peerId known?"

**Recommendation: left-align (default to "other") until peerId is known, with one caveat.** Reasoning:

- The pre-peerId window is short — auth hydrates `ThunderCommStore` within a frame or two of cold start. Visual flicker from "left-aligned for one frame, then re-aligns right" is a worse experience than briefly left-aligned with no flicker.
- More importantly: if `localPeerId == nil` and the comparison `message.senderId == localPeerId` evaluates to `nil == nil → true`, you'd right-align EVERY message (including agent messages) until peerId loads. That is catastrophic — agent messages flash on the right side of the screen, then jump left. The "default left-align" rule prevents this.
- Caveat: a human message authored by THIS device *before* `peerId` was hydrated (rare, but possible if persistence restores a pending send across cold start) should still right-align. Easy fix: when sending, stamp the message's `senderId` with the current `peerId` *or* with a `isLocal: true` flag that survives persistence. If the flag is present, right-align regardless of `localPeerId` state.

**Required check (in `MessageBubble`):** the alignment comparison must explicitly bail out (default to left-align) when `localPeerId == nil`. Pseudocode:

```swift
var isLocal: Bool {
    if let localPeerId, !localPeerId.isEmpty {
        return message.senderId == localPeerId
    }
    return message.isLocalOriginated ?? false  // or just `false`
}
```

If the comparison is written as `message.senderId == localPeerId` without the nil-guard, the `nil == nil → true` case will mis-align agent messages on cold start. **This is the single most likely regression hiding in this change.**

### B3. Type contract — `String` vs `String?` — BLOCKER

If `MessageListView` declares `let localPeerId: String` (non-optional) but `store.peerId` is `String?`, the call site in `ContentView` will either force-unwrap (build-safety fail per gate brief D1) or fall back to a sentinel like `""`. Empty-string fallback is worse than nil — `message.senderId == ""` happens to be false for valid messages, so it "works," but it silently breaks B2's nil-bailout: an empty-string `localPeerId` doesn't enter the nil branch.

**Required check:**
- `MessageListView.localPeerId` and `MessageBubble.localPeerId` are both `String?`, OR
- They are `String` and the call site in `ContentView` uses a meaningful sentinel (e.g. `"anonymous"`) that `MessageBubble` recognizes as "treat as nil."

The cleanest version is just `String?` end-to-end. Verify there is no `store.peerId ?? ""` shortcut at the call site.

### B4. Display name is still rendered, just not used for alignment — NOTE

The fix is correctly scoped: alignment moves from display-name match to peerId match. Display name is still used to *render* the sender label above/below the bubble. Confirm in source that `MessageBubble` still reads `message.senderName` (or equivalent) for the label, just doesn't use it for the alignment decision.

---

## Section C — Regression check (gate brief C)

The touched set is `ThunderCommWebSocketClient.swift`, `MessageBubble.swift`, `MessageListView.swift`, `ContentView.swift`. Cross-referenced against Build 24 wins that must survive:

### C1. DeliveryCore actor integration — CONDITIONAL (likely fine)

DeliveryCore itself (`ios-jon-slice/DeliveryCore.swift`) is not touched. The risk is at the WSClient ↔ DeliveryCore boundary: does the epoch guard accidentally drop *valid* acks for the live connection? It shouldn't, because the live connection's callbacks have `myEpoch == self.connectionEpoch` and proceed normally. But verify:

- The send-completion callback's success path (which leads to `delivery.markSent(messageId:)`) is reached for live-connection acks. Specifically, the guard is `guard myEpoch == self.connectionEpoch else { return }` — early-return, not throw — so live-epoch callbacks fall through to the existing ack-forwarding logic unchanged.
- The receive callback's bridge-ack-parse path likewise forwards to `delivery.markDelivered(messageId:)` for live-epoch messages.

**Required check:** in WSClient, the ack-forwarding code paths sit *after* the epoch guard, not before it. If for some reason the ack forwarding happens *before* the guard, stale acks would still be accepted — which isn't catastrophic (acks for messages on stale sockets are usually still valid acks), but it's a tell that the gating isn't comprehensive.

### C2. LightweightContextEngine look-above routing — PASS (touched file is safe)

`MessageListView.swift` is touched, but only to thread `localPeerId` through to bubbles. The look-above helper (`MessageListView.inferTargetAgent(from:channel:)`) is unrelated and should be untouched. Required check: grep `inferTargetAgent` in the updated MessageListView — signature and body unchanged from Build 24.

### C3. BUG-7 streaming row stable ID — PASS (touched file is safe, verify regression)

Same file as C2 — `MessageListView`. The BUG-7 fix is `static func rowID(for message: Message) -> String { message.isStreaming ? "streaming-\(message.id)" : message.id }`. Required check: this function still exists, still keys on `message.id` (NOT on anything involving `localPeerId`), and the `ForEach { … }.id(Self.rowID(for: message))` call site is intact. Adding `localPeerId` as a `MessageListView` parameter does not touch rowID; if Mack accidentally folded `localPeerId` into the row identity (e.g. `"\(message.id)-\(localPeerId ?? "anon")"`), every message re-renders when peerId hydrates. Don't do that.

### C4. Bridge ack loop (Mack's Build 24 fix) — PASS (touched file outside scope)

The bridge ack loop fix from Build 24 was in `bridge.mjs`, not in WSClient. WSClient changes here don't touch wire protocol or message framing, so the bridge ack loop should be unaffected. Required check: epoch guard does not alter the *content* or *encoding* of outbound messages — it only short-circuits stale callbacks. If Mack changed message framing in this build, that's a scope creep flag.

### C5. The 20s relay keepalive interaction — PASS (worth noting)

Per the brief, the relay (server-side) now pings every client every 20s and terminates dead connections cleanly. The WSClient epoch guard interacts with this cleanly: if the server terminates a stale connection, the resulting `didClose` callback fires with `myEpoch != self.connectionEpoch` and is correctly ignored. **One thing to confirm:** the server-side termination should NOT cause the client to trigger a reconnect storm. Required check: when the server cleanly closes a stale connection (e.g. because a newer connection from the same client took over), the client's `didClose` handler — even after passing the epoch guard for the live connection — should not aggressively reconnect a connection that's already live. With the epoch guard in place, this is structurally impossible (a `didClose` for the live connection means the live connection died, so reconnect is correct), but worth a smoke test.

---

## Section D — Build safety (gate brief D)

### D1. No new force-unwraps in epoch tracking — BLOCKER (carry-forward from gate brief D1)

Search the epoch-tracking code paths for `!` (force-unwrap) and `as!` (force-cast). Specifically risky sites:
- `connectionEpoch` itself can't be force-unwrapped (it's not optional).
- Any captured task: `task!.cancel(...)` would crash if the task was nil. Use `task?.cancel(...)`.
- Any captured continuation: `continuation!.resume(...)` is a common bug. Use `?.resume(...)` and prefer to make the continuation non-optional via initialization.
- Force-unwrap of `localPeerId` at the call site in `ContentView` is the other risk (see B3).

### D2. No MainActor violations in the callback guards — BLOCKER (carry-forward from gate brief D2)

If WSClient is `@MainActor`-isolated and the epoch guard reads `self.connectionEpoch` from a non-MainActor closure (URLSession's default delegate queue), Swift 6 will refuse compilation; Swift 5 will compile with warnings. Acceptable patterns:

```swift
// Pattern 1: hop to MainActor before guarding
task.receive { [weak self] result in
    Task { @MainActor in
        guard let self, myEpoch == self.connectionEpoch else { return }
        // ... handle on MainActor
    }
}

// Pattern 2: epoch lives in an actor
task.receive { [weak self] result in
    Task {
        guard let self, await self.epochStore.current == myEpoch else { return }
        // ...
    }
}
```

Pattern 1 is simpler and matches the rest of the SwiftUI ownership model. Pattern 2 isolates epoch access without making the whole client MainActor. Either is fine; pick one and apply consistently.

**Required check:** if WSClient has `@MainActor` on the class declaration, every closure passed to URLSession must either hop via `Task { @MainActor in … }` or be marked `@MainActor` itself (which URLSession's callback types don't allow directly — so it's the Task hop in practice).

### D3. Thread safety on the epoch variable — see A4

Already covered as a blocker in A4. The build-safety section of the brief calls this out explicitly: "epoch variable must be atomic or MainActor-protected." Either is fine; a bare `var Int` on a non-actor class is not.

---

## Carry-forward from Build 24 gate report

These items lived in Mack's lane in Build 24 and are not addressed by Build 27's scope. They remain open unless Mack has resolved them in a prior build:

- **B1 (Build 24)** — generic `mappedCanonicalID` over `userKey`. Not touched by Build 27. Verify still holding.
- **W2 (Build 24)** — per-userKey peer ID storage scoping. Build 27 *uses* `peerId` for alignment; if W2 was unresolved, two accounts on the same device could collide on alignment as well as on canonical resolution.
- **W6 (Build 24)** — Keychain access group correctness on device. The Build 21 device-crash root cause. If unresolved, Build 27 will inherit it because the new peerId-alignment path reads from the same identity store.
- **W4 (Build 24)** — 8s sliding window for multi-block routing. Unrelated to Build 27's scope; carry-forward unchanged.

---

## What Mack must do before integrating

In order of risk, expected to take 45–75 minutes total:

1. **A1** — `connect()` bumps epoch on its first line, BEFORE any closure captures the new task. Closures capture `let myEpoch = connectionEpoch` at site, not `self.connectionEpoch` inside the body.
2. **A2** — every async callback in WSClient (receive, send completion, ping completion, auth/connect timeout, idle/keepalive timer, URLSessionDelegate `didOpen`/`didClose`/`didCompleteWithError`, outbound queue drain) gates on epoch.
3. **A3** — the reconnect funnel (`triggerReconnect` / `scheduleReconnect` / whatever name) takes an `epoch:` parameter and gates on it. All call sites pass their captured `myEpoch`.
4. **A4 / D3** — `connectionEpoch` is either `@MainActor`-isolated, lives inside an `actor`, or is lock-protected. NOT a bare `var Int` on a non-actor class.
5. **A5** — `disconnect()` bumps epoch BEFORE `task.cancel(...)`. Sign-out path uses `disconnect()`, not a side door that skips the bump.
6. **A6** — `connect()` cancels the previous task before creating the new one (efficiency, not correctness).
7. **B1** — `ContentView` observes `store` and passes `localPeerId` to `MessageListView`, which passes it to `MessageBubble`. No environment / singleton reads — explicit parameter at each hop.
8. **B2** — `MessageBubble`'s alignment logic explicitly bails to left-align when `localPeerId == nil`. **This is the single most likely regression** — verify the comparison is `message.senderId == localPeerId` guarded by `if let localPeerId`, not a bare `==` that admits `nil == nil`.
9. **B3** — `localPeerId` is `String?` end-to-end (or there's a documented sentinel). No `?? ""` shortcut at the call site.
10. **C3** — `MessageListView.rowID(for:)` still keys on `message.id` only; not folded with `localPeerId`.
11. **D1** — no new `!` or `as!` in the epoch-tracking or peer-id-threading code paths.
12. **D2** — every URLSession callback either hops to MainActor or accesses epoch through an actor. No bare `self.connectionEpoch` reads from URLSession's delegate queue.

Once items A1–A6, B1–B3, C3, and D1–D2 check out (and the carry-forward items from Build 24 are confirmed or knowingly deferred), this is **green to build and ship Build 27**.

---

## Notes on review limits

I reviewed against the brief and the broader Build 24 context. I did not read `ThunderCommWebSocketClient.swift`, `MessageBubble.swift`, the Build-27 version of `MessageListView.swift`, or `ContentView.swift` — those live on Mack's Mac. Everywhere this report says "required check," it means a concrete grep or code read Mack must do; nothing in this report is source-verified by me for Build 27's actual diff. If any of A1–A6 or B1–B3 returns an unexpected result, escalate before integrating.

The epoch pattern is a "single missed call-site and the bug returns" pattern. The danger isn't whether the pattern is right (it is) — the danger is whether **every** call site got it. A1's bump-at-start invariant and A2's coverage matrix are the two most likely places for a defect to hide. Spend the time there.

---

## If A1–A6, B1–B3, C3, D1–D2 check out:

**Green light. Mack builds and ships Build 27.**
