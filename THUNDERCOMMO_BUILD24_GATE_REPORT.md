# ThunderCommo Build 24 — Gate Report

**Reviewer:** CLI Jon (logic review, no direct source access)
**Date:** 2026-05-10
**Method:** Spec-vs-implementation analysis against `THUNDERCOMMO_IOS_BUILD24_BRIEF.md` and the change summary in `THUNDERCOMMO_BUILD24_GATE_BRIEF.md`. Source is on Mack's Mac (`repos/thundergate-sparse`, branch `thundercomm-ios`); this report flags logic concerns — Mack must verify each one in the actual files before integrating.

---

## Verdict: CONDITIONAL PASS

The build is structurally aligned with the spec on every P0/P1 item, but two design deviations and several unverified-from-here invariants must be confirmed before integration. None are architectural rewrites — they are localized checks Mack can do in under an hour.

If items B1–B3 below check out and W1–W4 are addressed (or knowingly accepted as deferred risk), this is **green to integrate and build**.

---

## Spec-vs-Implementation Mapping

| Spec item | Implementation note | Status |
|---|---|---|
| BUG-1 hardcoded `ios-michael-*` identity | `loadOrCreatePeerId(forUserKey:)` introduced; senderName sourced from `UserStore` | Logic-aligned, see B1/W2/W3 |
| BUG-2 stuck `.sending` on reconnect (spec: 5s) | 12s watchdog + `.failed` state + `retrySend()` | Deviation in timeout; see W1 |
| BUG-3 multi-block mis-routing (spec: turn-id / streaming session) | 8s sliding window in `bridge.mjs` | **Deviation** — see W4 |
| BUG-4 duplicate settings surfaces | Connection section in `SettingsView`; ellipsis menu removed | Aligned, see B2 |
| BUG-5 crowded header | Header rewritten as "3-row card"; ellipsis removed | Visually deviates from spec's single-row; see N1 |
| BUG-6 delete is local-only | Deferred; local tombstone | Accepted deferral per spec |
| BUG-7 streaming view churn | Not mentioned in change summary | **See B3** |
| BUG-8 identity resolution incidental | Implicitly addressed via canonical ID flow | See W2 |
| BUG-9 `channel.ts` dead path | Banner comment added | Aligned |
| BUG-10 hardcoded bridge USERS | Deferred; Add Agent is a stub | Accepted deferral, see W5 |
| Onboarding / agent-first SignUp | `SignUpView.swift` agent-first framing + brand tagline | Aligned |
| MessageBubble `.failed` + tap-to-retry + context menu retry | Implemented | Aligned, see W1 |

---

## Issues

### BLOCKERS (must resolve before integrating)

**B1. Verify generic `mappedCanonicalID` for `ios-<userKey>-<uuid>`**
- Risk: if `mappedCanonicalID` still hard-strips a literal `ios-michael-` prefix (or a fixed allow-list of handles) it will not collapse `ios-alex-…` or `ios-burt-…` to their canonical handles, so federation/DM routing breaks for every non-michael account.
- Required check: the prefix-strip is a generic `^ios-([^-]+)-[0-9a-f-]+$` (or equivalent token split) that returns capture-group 1 — not a switch over known handles. Confirm against Alex's token (already provisioned per ACTIVE_TASKS) by mentally walking `ios-alex-<uuid>` through the function.

**B2. Confirm zero dead references to ellipsis menu state**
- Risk: leftover `@State private var showingConnectionSettings`, sheet bindings, or button actions on a removed UI element compile fine but ship dead code that can resurrect on a future merge or trigger orphan sheets via state mutation.
- Required check: grep `showingConnectionSettings`, `ellipsis`, `Menu {` in `ContentView.swift` — must be zero hits, including inside `.sheet(isPresented:)`, `.confirmationDialog`, and any `onAppear` bindings.

**B3. BUG-7 (streaming preview view churn) status is unstated**
- The change summary lists no fix for BUG-7. Spec marked it P1 ("fix before ship"). If the streaming row is still keyed off `updatedAt`, every delta tick rebuilds the row — visible churn during long replies, and on weaker devices it can starve the main thread enough to delay ack handling (which then cascades into the 12s watchdog firing spuriously — see W1).
- Required check: in `MessageListView`, is the streaming row's `id:` parameter the message ID (or a streaming-session ID), not `updatedAt`? If still `updatedAt`, this is a ship blocker — the watchdog and the rebuild interact badly.

---

### WARNINGS (should address; document if knowingly deferred)

**W1. Watchdog timeout deviates from spec (12s vs 5s)**
- Spec said 5s. 12s is defensible — gives reconnect headroom and reduces false-positive failure flashes — but it has two follow-on requirements that must be true:
  1. The watchdog's "fire" handler must re-check `message.state == .sending` on the main actor before flipping to `.failed`. Otherwise a late-fire after ack will overwrite a `.delivered` message back to `.failed`. Standard pattern: `Task { @MainActor in try? await Task.sleep(for: .seconds(12)); guard !Task.isCancelled, message.state == .sending else { return }; … }` — and the cancellation token must be stored per-message, cancelled in the ack handler.
  2. With BUG-7 unfixed (see B3), main-thread churn during long streams can delay ack processing past 12s and trip the watchdog on a message that is actually fine. Either fix BUG-7 or raise watchdog to 20s.
- Required check: confirm both — the state guard inside the timer fire, and the per-message cancel token wired to the ack path.

**W2. Per-user peer ID storage scoping**
- `loadOrCreatePeerId(forUserKey:)` is correct in shape, but the persistence key it writes to must include `userKey` in the storage key (e.g. `peerId.<userKey>` in UserDefaults/Keychain). Otherwise: sign out → sign up new account → the same UUID-suffixed peer ID is recycled across users. Federation will think two accounts are the same device-identity for canonical resolution.
- Required check: open the function — the read/write key must be a function of `userKey`, not a single global `peerId` key.

**W3. Anonymous / pre-signup fallback**
- Spec: "If no user signed in → identity is `anonymous-<uuid>` until signup completes." The signature `loadOrCreatePeerId(forUserKey:)` implies a non-optional key. If callers pass an empty string before auth completes, the resulting `ios--<uuid>` (double dash) will not parse cleanly through `mappedCanonicalID`.
- Required check: callers either (a) skip identity resolution entirely until auth completes, or (b) call with a sentinel `"anonymous"` userKey. Verify the path that runs at app cold-start before `UserStore` has hydrated.

**W4. Multi-block routing: 8s sliding window is a heuristic, not a turn boundary**
- This is the largest semantic deviation from spec. The spec asked for turn-id / streaming-session tracking — a deterministic boundary. An 8s sliding window has two failure modes:
  - **Mid-turn pause >8s** (slow tool call, long thinking): subsequent blocks fall out of the window and route to the default channel (#tnt) instead of the originally-routed DM. The gate brief explicitly asks about this — confirm the fallback is to `#tnt` and is logged, not silently dropped.
  - **Back-to-back turns inside 8s**: if a second turn from the same agent starts within 8s of the previous turn's last block, the second turn inherits the first turn's channel routing. This will happen any time an agent answers two queued questions in quick succession.
- Acceptable for ship if: (a) the 8s window resets on every block (true sliding), (b) there is a stream-end signal that closes the window early, and (c) the misroute case logs at warn level so we can tell from logs that it happened.
- Required check: in `bridge.mjs`, find the window-reset logic — is it reset on every block from the same agent? Is there any stream-end signal closing the window before 8s? If neither, file as a known limitation in INTEGRATION_NOTES and accept for Build 24, fix in 25.

**W5. "Add Agent" stub crash safety**
- Bridge USERS hardcoding is acceptably deferred only if tapping "Add Agent" cannot crash. Required check: the Add Agent button's action either (a) presents a "coming soon" alert/sheet, or (b) is disabled. It must not invoke a code path that calls into a not-yet-implemented bridge handler that could throw or fatalError.

**W6. Keychain access group correctness on device**
- ACTIVE_TASKS.md (May 10 02:47 ET) flags Build 21 as crashing on device with suspected Keychain access group mismatch. Build 24 inherits the same identity-storage path with `loadOrCreatePeerId(forUserKey:)` — if peer ID is stored in Keychain and the access group is set for simulator-only entitlement, this build will crash on Michael's device the same way Build 21 did.
- Required check: is the new identity stored in Keychain or UserDefaults? If Keychain, verify `kSecAttrAccessGroup` matches the device entitlement file (not the simulator default). This is a literal continuation of the prior device crash — do not assume Build 24's identity refactor sidestepped it.

---

### NOTES (low-impact deviations, no action required)

**N1. Header is "3-row card" vs spec's single row**
- Spec: `[title 17px] [subtitle 13px] [peers chip] [gear]` on one row.
- Build: 3-row card layout.
- This is a deliberate visual interpretation. As long as the row crowding problem from BUG-5 is solved (it is — ellipsis removed, items separated vertically), this is fine. Worth a one-line note in the design retro: spec called single-row, build shipped 3-row.

**N2. Header `+` menu not in spec**
- Spec located `+` buttons inside the sidebar section headers (CHANNELS, AGENTS, DMs). Build adds a header-level `+` menu with an Add channel alert stub. Harmless if it doesn't crash (covered under gate task #3) — but it duplicates affordance with the sidebar `+`s. Decide post-ship whether to keep one or both.

**N3. SignUpView "agent-first framing + brand tagline"**
- Aligned with the agent-as-first-class-citizen design ethos in Part 2 of the spec. No issue.

---

## Regression Check (gate task #7)

All Build 23 wins called out in the spec must survive Build 24. From the change summary, the only files touched on the iOS side are: `ThunderCommModels.swift`, `ThunderCommStore.swift`, `SettingsView.swift`, `ContentView.swift`, `SignUpView.swift`, `MessageBubble.swift`. That set is consistent with the changes scoped — preserved-by-omission for:

- `inferDirectAgentIDIfNeeded` look-above routing — untouched, preserved.
- Sent/delivered indicators — `MessageBubble.swift` changed but spec preserves badges; verify in passing.
- History gating (`didInitialScroll` guard) — untouched, preserved.
- Code block copy button — untouched, preserved.
- Federation 45s idle terminate + 15s ping — `bridge.mjs` only got the 8s window add, not a teardown of the heartbeat logic.

`pendingResponseChannels` queue (gate task #7 explicit ask): the 8s window enhancement must not regress single-text turns — i.e. a one-block turn must still pop the queue exactly once on stream-end (or window expiry, whichever first). Required check in `bridge.mjs`: confirm the pop happens on either the window-close OR the first-block-after-window path, never both.

---

## What Mack must do before integrating

In order, expected to take 30–60 minutes total:

1. **B1** — `mappedCanonicalID` is generic over userKey (not a switch on known handles).
2. **B2** — grep `showingConnectionSettings` / `ellipsis` in `ContentView.swift` returns zero.
3. **B3** — confirm BUG-7 streaming-row keying status; if not fixed, either fix or raise watchdog (W1) to ≥20s and document.
4. **W1** — watchdog fire handler re-checks `state == .sending` AND has a per-message cancel token cancelled in ack path.
5. **W2** — peer ID storage key includes `userKey`.
6. **W3** — pre-auth callers either skip identity or pass a sentinel.
7. **W4** — confirm 8s window resets per-block and document the >8s pause fallback in INTEGRATION_NOTES.
8. **W5** — Add Agent button action is a safe stub (alert or disabled).
9. **W6** — Keychain access group matches device entitlement (this is the Build 21 device-crash root cause; do not skip).

Once items B1–B3 and W6 check out — and W1–W5 are either fixed or knowingly deferred with notes — **green to integrate and build**.

---

## Notes on review limits

I reviewed against the implementation summary in the gate brief and the original spec. I did not read the actual Swift or JS source — that is on Mack's Mac. Anywhere this report says "required check," it means a concrete grep or code read Mack must do; nothing in this report is verified at the source level by me. If any of B1/B2/B3/W6 returns an unexpected result, escalate before integrating.
