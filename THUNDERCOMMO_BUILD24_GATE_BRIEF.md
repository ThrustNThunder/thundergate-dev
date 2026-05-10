# ThunderCommo Build 24 — Jon's Gate Pass
## Date: May 10, 2026
## Purpose: Final CLI Jon review before Mack integrates + ships

## What Mack's CLI Jon changed (read these files):

### iOS files changed:
- `apps/ios/ThunderCommIOS/ThunderCommModels.swift` — identity fix + .failed state
- `apps/ios/ThunderCommIOS/ThunderCommStore.swift` — senderName from UserStore, 12s watchdog, retrySend()
- `apps/ios/ThunderCommIOS/SettingsView.swift` — Connection section added, one settings surface
- `apps/ios/ThunderCommIOS/ContentView.swift` — header rewritten (3-row card), ellipsis menu removed
- `apps/ios/ThunderCommIOS/SignUpView.swift` — agent-first framing, brand tagline
- MessageBubble.swift — failed state UI, tap-to-retry, retry context menu

### Bridge file changed:
- `extensions/thundercomm/bridge.mjs` — 8s sliding window for multi-block assistant routing
- `extensions/thundercomm/src/channel.ts` — dead code banner added

## Gate Review Tasks

### 1. Identity fix verification
- Confirm `loadOrCreatePeerId(forUserKey:)` properly scopes to signed-in user
- Confirm no `ios-michael-*` hard-coding remains anywhere in the codebase
- Check `mappedCanonicalID` handles generic `ios-<userKey>-<uuid>` correctly
- Verify fallback behavior on first launch (no account yet) is safe

### 2. Settings consolidation
- Confirm single gear path — no duplicate connection config surfaces remain
- Verify `SettingsView` has the Connection section with Save & reconnect
- Confirm ellipsis menu and `showingConnectionSettings` are fully removed (no dead references)

### 3. Header
- Verify old header layout is fully replaced
- Confirm gear, route chip, + menu, peers chip all work without crashes
- Check the "Add channel" alert stub is clean (no unimplemented action that crashes)

### 4. Failed send watchdog
- Confirm 12s watchdog is armed on every send
- Confirm watchdog is cancelled on ack (no premature failure flash)
- Confirm `.failed` state renders correctly in MessageBubble
- Confirm `retrySend` uses same idempotency key (no duplicate sends)
- Check: reconnect-time sends don't fail-fast — watchdog handles them

### 5. Bridge multi-block routing
- Confirm 8s sliding window is correct — first block routes, subsequent blocks in same turn reuse channel
- Confirm single-text turns unchanged (queue still pops once per dispatch)
- Confirm no regression on DM routing (direct:jon, direct:michael still work)
- Check: what happens when 8s window expires mid-stream? Should be safe fallback to #tnt.

### 6. Deferred items — verify they're truly safe to defer
- Bridge USERS hardcoding: still hard-coded, but Add Agent in SettingsView is a stub — confirm no crash if user taps Add Agent after signup
- Server-side delete: local tombstone adequate? Or can it cause confusion?
- Auto-jump to Add Agent after signup: currently manual — confirm the "Add your first agent" CTA is visible and functional (even if not auto-jump)

### 7. Regression check
- Confirm all overnight fixes are preserved:
  - inferDirectAgentIDIfNeeded look-above routing
  - pendingResponseChannels queue (now enhanced with 8s window)
  - Sent/delivered indicators
  - History gating (didInitialScroll guard)
  - Code block copy button
  - Federation resilience (45s idle terminate + 15s ping)

### 8. Build safety check
- No force-unwraps on critical paths (send, auth, identity)
- No MainActor violations in the new watchdog timer code
- Keychain access group — is identity stored in Keychain? Confirm access group is correct for device (not simulator-only)

## Output
- Write a GATE_REPORT.md to /home/ubuntu/thundergate-dev/THUNDERCOMMO_BUILD24_GATE_REPORT.md
- Format: PASS / CONDITIONAL PASS / FAIL
- List any issues found with severity: BLOCKER | WARNING | NOTE
- If CONDITIONAL PASS: list exactly what Mack must fix before integrating
- If PASS: explicitly state "Green light for Mack to integrate and build"

## Repo location
Files are in Mack's local working tree on Mac (repos/thundergate-sparse, branch thundercomm-ios).
Jon does NOT have direct access to these files. 
Your job: review the LOGIC described in the implementation notes and flag any concerns.
Read: /home/ubuntu/thundergate-dev/THUNDERCOMMO_IOS_BUILD24_BRIEF.md (the original spec)
Read: The implementation notes summary above
Produce the gate report based on spec-vs-implementation analysis.
