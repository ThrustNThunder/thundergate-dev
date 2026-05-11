# ThunderCommo Build 28b — Brief Update

**Date:** 2026-05-11
**Author:** CLI Jon (ThunderBase)
**Builds on:** Build 28 (`BUILD28_PRESSURE_TEST_BRIEF.md`)
**Status:** RC scope locked; pressure-test gate non-negotiable per #tnt 2026-05-10 13:46 ET

---

## What changed since Build 28

Build 28 shipped four blockers + four UX fixes. Build 28b is a focused
follow-on that adds APNs delivery, fixes a regression Settings-suite bug
that surfaced once the NSE work started, and keeps everything else from
Build 28 intact.

Build 28b is **not** a re-test of Build 28's blockers — those passed.
The pressure-test gate still runs the full matrix, but the Build 28b
additions are scoped tightly so Mack and Jon can ship within the
post-merge-freeze window (mobile cut on May 14, this lands before).

---

## Build 28b Scope

### Priority 1 (Ship-Gating)

1. **APNs registration round-trip** — App POSTs `/v1/apns/register`
   with device token. Relay stores and returns 200. See
   `THUNDERCOMMO_APNS_IOS_SPEC.md` §3 for the wire shape.
   - Bridge changes deployed on ThunderBase (relay-side endpoint).
   - iOS: implement `didRegisterForRemoteNotificationsWithDeviceToken`
     handler, hex-encode token, POST.
   - Pass criteria: token row appears in relay log, 200 OK observed.

2. **Backgrounded-app banner delivery** — A push received while the app
   is backgrounded or killed must surface a banner within 10s of the
   relay sending it.
   - Pass criteria: 5/5 sends produce 5/5 banners with `aps.alert.body`
     populated, no double-deliveries.

3. **Foreground suppression** — A message that arrives over WSS while
   the app is foregrounded must NOT also produce an APNs banner.
   - Implementation: relay skips push when the WSS client list for that
     peerId is non-empty at broadcast time (§5 of APNs spec).
   - Pass criteria: 5/5 sends produce 0 banners while app is foreground.

4. **Settings shared-suite fix** — Build 28's Priority 7 fix wrote to
   the per-app `UserDefaults` instead of the shared
   `group.us.thunderai.thundercommo` suite. The NSE can't read per-app
   defaults, so the badge count and seen-id FIFO won't work without this
   fix.
   - Pass criteria: SettingsView toggle written from foreground reads
     back identical value from the NSE on next push.

### Priority 2 (Conditional Pass — fix in build if <30 min, else 28c)

5. **Dedup race coverage** — When WSS reconnects after offline and APNs
   has already delivered the same message, the chat scroll must show
   the message exactly once.
   - Implementation lives in `ThunderCommStore.swift` — append by `id`,
     drop duplicates.
   - Pass criteria: 20-message offline flood, online reconnect → each
     `id` appears exactly once.

6. **410 reaping verification** — Uninstall the app, send a push from
   the relay, watch the relay log for `apns_unregistered` and confirm
   the row is deleted.
   - This is a relay-side observability check; iOS contributes only the
     uninstall step.
   - Pass criteria: relay log line present within 30s, row absent on
     next `/v1/apns/register` query.

### Priority 3 (Defer if it slips)

7. **Quiet-hours UI placeholder** — Empty toggle row in SettingsView,
   no functional impact. Ships if it lands cleanly; otherwise Build 28c.

---

## Carry-forward from Build 28

All eight Build 28 fixes (DM routing, retry watchdog, DM context window,
settings persistence, avatar cleanup, phone keypad, double-hash, per-agent
thinking indicators) must remain green. The pressure-test matrix runs them
unchanged.

---

## Out of Scope — Explicit

- **End-to-end encryption** of push payloads. `tc.preview` ships
  in cleartext for now; Phase 2 swaps it for a ciphertext blob (APNs
  spec §10).
- **Per-channel mute** in settings. UI present, no functional behavior.
- **CallKit / PushKit** for voice and video. Separate spec.
- **Android FCM parity**. Tracked separately in `BYOAA_ANDROID_BRIEF.md`.
- **Watch complications**. Not this build.

---

## Bridge / Relay Pre-conditions

Relay-side changes deployed on ThunderBase before Mack starts iOS work:

- [ ] `POST /v1/apns/register` and `DELETE /v1/apns/register` endpoints
      live, persisted to relay DB.
- [ ] APNs auth wired (`.p8` token signing, `APNS_AUTH_KEY_PATH`,
      `APNS_KEY_ID`, `APNS_TEAM_ID` set in env).
- [ ] Push fan-out hooked into the existing `federation_message` path
      with the foreground/WSS suppression rule.
- [ ] Per-channel collapse id (`apns-collapse-id: <channel>`) wired.

The bridge changes are on ThunderBase only — iOS does not see them
until Mack updates `ThunderCommStore.swift` to call register on token
issue.

---

## APNs Test Matrix

The Build 27 / 28 pressure-test brief covers sections A–K (the existing
ThunderCommo flows). Build 28b extends the matrix with three new
sections that pivot specifically on the APNs additions. Each row below
is a discrete pressure-test case; the gate report (`THUNDERCOMMO_BUILD28B_GATE_REPORT.md`)
must record PASS / FAIL / N/A per row.

### Section L — APNs Integration Tests

These cover the end-to-end happy paths from device registration through
delivery and tap-to-channel navigation.

| Case  | Scenario                          | Pass criteria |
| ----- | --------------------------------- | --- |
| L-1   | Device token registration         | Launch fresh install → user grants push → `didRegisterForRemoteNotificationsWithDeviceToken` fires → app POSTs `/v1/apns/register` → relay returns 200 → row appears in relay DB with environment, bundleId, peerId fields populated. |
| L-2   | Push delivery (background)        | App backgrounded → another peer sends a `#tnt` message → relay observes WSS client list empty for recipient → push dispatched → APNs delivers → iOS shows banner with `aps.alert.body` matching truncated message text within 10s. |
| L-3   | Notification tap → channel        | Banner from L-2 tapped → app foregrounds → `userNotificationCenter(_:didReceive:)` fires → `tc.channel` deep-links to correct chat view → unread badge clears for that channel. |
| L-4   | Background wake (content-available) | App killed → push arrives with `content-available: 1` → iOS wakes app for ~30s → app drains WSS unread backlog → completion handler called with `.newData` → message visible on next foreground without re-fetch. |
| L-5   | Foreground suppression            | App foreground → message arrives over WSS → relay confirms WSS path delivered → APNs branch skipped → 0 banners shown. Run for 10 successive sends to catch any race. |
| L-6   | Token rotation                    | Force a token rotation (delete-app + reinstall, or simulate restore-from-backup) → new token POSTs → old token row reaped on next 410 from APNs → relay log shows `apns_unregistered`. |
| L-7   | Sign-out kill switch              | User signs out in Settings → app POSTs `DELETE /v1/apns/register` with current device token → row removed → next push to peerId from another device still delivers (separate row). |

### Section M — Bug #9 Replay Prevention

Bug #9 (originally surfaced in Build 27 pressure testing) is that
post-reconnect WSS replay was duplicating messages that APNs (or a
prior WSS session) had already delivered. The fix lives in APNs spec
§5b: `afterTimestamp` + `ackedIds` on the resume frame, ack-cache clear
on reconnect, and a `resume_gap` reply when the device is stale beyond
retention.

| Case  | Scenario                           | Pass criteria |
| ----- | ---------------------------------- | --- |
| M-1   | WiFi↔cellular mid-session switch   | Active chat → flip iPhone WiFi → cellular fails over → WSS reconnects → resume frame includes correct `afterTimestamp` → relay delivers only messages newer than the last rendered one → zero duplicate ids in chat scroll across a 20-message flood. |
| M-2   | App backgrounding bounce           | App backgrounded for 30s → APNs delivers 5 messages → app foregrounded → WSS reconnects → resume frame's `ackedIds` includes all 5 push-delivered ids → relay sends no message with id in `ackedIds` → 5/5 messages appear exactly once. |
| M-3   | `afterTimestamp` validation        | Resume frame's `afterTimestamp` value matches the `ts` of the most recent message in `ThunderCommStore` (regardless of source: WSS or NSE-handled push). Relay returns only `ts > afterTimestamp`. Verify with relay log inspection. |
| M-4   | Queue retry behavior               | Force a relay-side retry (synthetic 500 from relay layer) → unacked messages re-enqueue → on next deliver attempt, already-acked messages do NOT resend → only the un-acked subset is retried. |
| M-5   | `resume_gap` past retention        | Force the device clock back 26h (beyond the 24h retention window) → reconnect → relay returns `{"type": "resume_gap"}` → app falls back to full unread-since fetch → no silent message loss; no flood of stale messages. |

### Section N — First Launch Notification Prompt

These cover the user-permission paths from a clean install. The deny
fallback (APNs spec §4b) is the easy-to-miss case — most testing flows
default to accept and never exercise the deny path's in-app banner.

| Case  | Scenario                         | Pass criteria |
| ----- | -------------------------------- | --- |
| N-1   | Fresh install — prompt appears   | Wipe app + offload from Settings → relaunch → permission prompt appears on first foreground → prompt text matches the system default for `[.alert, .badge, .sound]`. |
| N-2   | Grant flow                       | Fresh install → user grants → `registerForRemoteNotifications()` fires on main thread → `didRegisterForRemoteNotificationsWithDeviceToken` callback received → POST `/v1/apns/register` → 200 OK from relay → no banner shown (denial UI never appears). |
| N-3   | Deny flow + recovery             | Fresh install → user denies → app posts `.apnsPermissionDenied` → in-app banner appears: "Miss nothing when the app is closed." → tap `[Open Settings]` → app deep-links to system Settings → enable in Settings → foreground app → app re-checks status → registers and POSTs token → banner dismissed. |
| N-4   | Subsequent launch (already granted) | Relaunch app that already has push authorization → no prompt → no banner → token POSTs only if more than 24h since last register (rotation hygiene). |
| N-5   | Subsequent launch (denied)       | Relaunch app where user denied on first launch and has not re-enabled → banner appears once per session → dismissible → reappears next session if still denied. |

Section L/M/N are **gate-blocking** — Build 28b must pass all L-1..L-5,
M-1..M-3, and N-1..N-3 to ship. L-6/L-7, M-4/M-5, and N-4/N-5 are
**warn-only** for 28b and become gate-blocking from Build 29 onward
(once Mack has had a real-device cycle to address any rough edges
surfaced by the warn-only failures).

---

## Pressure-test gate (locked)

Before Mack ships Build 28b:

1. CLI Jon runs the existing pressure-test matrix from Build 28 brief.
2. CLI Jon runs the APNs additions from §10 of the APNs spec plus
   Section L/M/N of this brief.
3. Both produce a `THUNDERCOMMO_BUILD28B_GATE_REPORT.md` with PASS /
   CONDITIONAL PASS / FAIL.
4. Mack ships only on PASS or CONDITIONAL PASS with explicit known
   issues called out.

The pressure-test gate is non-negotiable per the #tnt workflow lock on
May 10. No fast-track shortcuts even for "small" follow-ons.

---

## Output

Write `THUNDERCOMMO_BUILD28B_GATE_REPORT.md` to `/home/ubuntu/thundergate-dev/`
on completion.
