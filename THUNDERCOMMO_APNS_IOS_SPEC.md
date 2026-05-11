# ThunderCommo APNs iOS Spec

**Date:** 2026-05-11
**Author:** CLI Jon (ThunderBase)
**Audience:** Mack (iOS implementation), Jon (relay-side handoff)
**Scope:** Apple Push Notification service integration for ThunderCommoIOS — Build 28b feature.

---

## 1. Goal

Deliver inbound ThunderCommo messages to a backgrounded or killed iOS app via APNs
so Michael sees the message without first having to foreground the app. Foreground
delivery continues to flow exclusively over the existing WSS channel — APNs is a
wake-up signal, not a replacement transport.

**Non-goals:**

- No silent location pings, no analytics piggy-backing.
- No replacement for WSS once the app is foreground. APNs and WSS never both
  surface the same message to the user — the app dedups by `message.id`.
- No web push.

---

## 2. Roles

| Component | Responsibility |
| --- | --- |
| iOS app (`ThunderCommoIOS`) | Request push permission, register device token, persist token, dedup, render notification banner, hand WSS the unread queue on launch. |
| ThunderBase relay (`thundercommo-stable` server) | Receive device tokens, store one row per `peerId+deviceToken`, mint APNs JWTs, POST to APNs HTTP/2, retry on 429/5xx, drop on 410/Unregistered. |
| Apple APNs | Deliver alert payload to the device. |

ThunderGate itself does **not** talk to APNs. The relay owns the credential
(team key + bundle id) and is the only component that holds it.

---

## 3. Xcode project configuration

Before any code lands the Xcode project must opt in. These are one-time
toggles per target — Mack does both on `ThunderCommoIOS` and on the
Notification Service Extension target (added in §7).

1. **Signing & Capabilities → Push Notifications** — add the capability.
   Xcode writes `aps-environment` (`development` for debug builds,
   `production` for App Store) into the entitlements file. Do **not**
   hand-edit the entitlements plist; let Xcode manage it so the
   provisioning profile stays in sync.
2. **Signing & Capabilities → Background Modes → Remote notifications** —
   toggle on. This is what makes `content-available: 1` actually wake the
   app for the 30-second background window referenced in §4.
3. **App Groups** — add `group.us.thunderai.thundercommo` to both the
   main app and the NSE target. Required so the NSE can read the
   seen-ids FIFO and the badge count from the same shared
   `UserDefaults(suiteName:)`.
4. **Bundle id** — confirm `us.thunderai.thundercommo` matches the App ID
   you registered the APNs key against in Apple Developer (see §8).

## 4. Token lifecycle

1. **First foreground after install** — iOS app calls
   `UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])`.
   If granted, `UIApplication.shared.registerForRemoteNotifications()`.
   See §4a for the full AppDelegate snippet.
2. **`didRegisterForRemoteNotificationsWithDeviceToken`** — hex-encode the
   `Data` token and POST to relay (snippet in §4a).

   ```
   POST https://relay.thunderai.us/v1/apns/register
   Authorization: Bearer <federation_token>   (existing TC token)
   Content-Type: application/json

   {
     "peerId":       "michael-iphone",
     "deviceToken":  "a1b2c3...",          // 64 hex chars
     "bundleId":     "us.thunderai.thundercommo",
     "environment":  "production",         // or "sandbox" during TestFlight
     "appVersion":   "1.28.0",
     "iosVersion":   "17.5"
   }
   ```

   Relay UPSERTs on `(peerId, deviceToken)`. A new device token for an existing
   peer adds a row; the old row is left alone until APNs returns 410 for it.

3. **Token rotation** — iOS reissues `didRegisterForRemoteNotificationsWithDeviceToken`
   after restore-from-backup, OS upgrades, and uninstall/reinstall. Each callback
   POSTs again; relay treats the (peerId, deviceToken) tuple as the unit. Stale
   tokens are reaped by step 5.

4. **Sign-out / kill switch** — iOS POSTs
   `DELETE /v1/apns/register` with the current device token. Relay removes that
   row only.

5. **Reaping** — when APNs returns `410 Unregistered` for a token, relay deletes
   the matching row immediately. No retry, no exponential backoff — APNs is
   authoritative.

---

## 4a. AppDelegate integration (canonical Swift)

Drop this verbatim into `AppDelegate.swift`. The relay endpoint and bundle
id are the only values that should ever change between environments —
both are read from `Info.plist` so the same binary works in TestFlight
and production.

```swift
import UIKit
import UserNotifications

@UIApplicationMain
final class AppDelegate: UIResponder, UIApplicationDelegate {

  func application(_ application: UIApplication,
                   didFinishLaunchingWithOptions
                     launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    requestPushAuthorizationIfNeeded()
    return true
  }

  // First-launch permission flow. Idempotent — `getNotificationSettings`
  // short-circuits when the user has already answered.
  private func requestPushAuthorizationIfNeeded() {
    let center = UNUserNotificationCenter.current()
    center.getNotificationSettings { settings in
      switch settings.authorizationStatus {
      case .notDetermined:
        center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
          if let error = error {
            NSLog("apns.authRequestFailed: \(error.localizedDescription)")
          }
          if granted {
            // `registerForRemoteNotifications` MUST be called on the main
            // thread — otherwise iOS quietly never fires the callback.
            DispatchQueue.main.async {
              UIApplication.shared.registerForRemoteNotifications()
            }
          } else {
            NotificationCenter.default.post(
              name: .apnsPermissionDenied, object: nil)
          }
        }
      case .denied:
        // User said no at some point. Surface the in-app banner described
        // in §4b so they can flip it on from Settings.
        NotificationCenter.default.post(
          name: .apnsPermissionDenied, object: nil)
      case .authorized, .provisional, .ephemeral:
        DispatchQueue.main.async {
          UIApplication.shared.registerForRemoteNotifications()
        }
      @unknown default:
        break
      }
    }
  }

  func application(_ application: UIApplication,
                   didRegisterForRemoteNotificationsWithDeviceToken
                     deviceToken: Data) {
    let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
    ThunderCommStore.shared.registerAPNsToken(hex)   // POSTs §4 payload
  }

  func application(_ application: UIApplication,
                   didFailToRegisterForRemoteNotificationsWithError error: Error) {
    NSLog("apns.registerFailed: \(error.localizedDescription)")
    // No retry here. Token registration retries are owned by
    // ThunderCommStore — it re-asks iOS on the next foreground.
  }
}

extension Notification.Name {
  static let apnsPermissionDenied =
    Notification.Name("us.thunderai.thundercommo.apns.denied")
}
```

## 4b. Deny fallback (in-app banner)

When `requestAuthorization` returns `granted == false` *or* the user
arrived at `.denied` from a prior session, the app posts
`Notification.Name.apnsPermissionDenied`. `RootView.swift` listens for
that and shows a dismissible banner across the top of the chat:

> **Miss nothing when the app is closed.** Push notifications are off —
> turn them on in Settings.
> [Open Settings] [Not now]

`[Open Settings]` deep-links via
`UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!)`.
The banner persists for the session, dismissed state lives in the shared
`UserDefaults` suite so the NSE doesn't re-trigger it.

## 5. Payload shape

The relay sends a single APNs payload type. iOS must handle exactly this shape:

```json
{
  "aps": {
    "alert": {
      "title":    "Jon",
      "subtitle": "#tnt",
      "body":     "First 140 chars of message…"
    },
    "sound":            "default",
    "thread-id":        "tnt",
    "mutable-content":  1,
    "content-available": 1
  },
  "tc": {
    "v":          1,
    "id":         "abc-123-…",      // message.id — used for dedup
    "channel":    "tnt",            // 'tnt' | 'jmab' | 'direct:<peerId>'
    "sender":     "Jon",
    "senderType": "agent",          // 'agent' | 'human'
    "ts":         1747000000000,
    "preview":    "First 140 chars" // matches alert.body exactly
  }
}
```

### Field rules

- `aps.alert.body` is the message text truncated at the first of: 140 UTF-16
  code units, the first newline, or the end of the message. If truncated, a
  single `…` (U+2026) is appended. The relay does the truncation; iOS displays
  whatever it receives.
- `aps.thread-id` mirrors `tc.channel` so iOS groups DMs and channel chatter
  separately in Notification Center.
- `mutable-content: 1` lets the Notification Service Extension (NSE, see §7)
  decrypt or rewrite the alert before display.
- `content-available: 1` wakes the app for ~30s in background. Used to drain
  any unread WSS backlog before the user taps in. **Do not** abuse this for
  arbitrary work — APNs throttles apps that wake without showing the alert.
- `tc.id` is the canonical dedup key. iOS keeps a 256-entry FIFO of seen ids
  in `UserDefaults` (group container so the NSE shares it) and drops any
  payload whose id is already present.

---

## 5a. Notification handling (tap + background wake)

**Tap-to-channel:** When the user taps a notification banner,
`UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:)`
fires with the original payload. The handler reads `tc.channel` and
posts a deep-link notification:

```swift
func userNotificationCenter(
  _ center: UNUserNotificationCenter,
  didReceive response: UNNotificationResponse,
  withCompletionHandler completionHandler: @escaping () -> Void
) {
  let userInfo = response.notification.request.content.userInfo
  if let tc = userInfo["tc"] as? [String: Any],
     let channel = tc["channel"] as? String {
    NotificationCenter.default.post(
      name: .openChannel, object: nil,
      userInfo: ["channel": channel])
  }
  completionHandler()
}
```

`RootView.swift` listens for `.openChannel` and pushes the matching
chat view (`tnt`, `jmab`, or `direct:<peerId>`). If the app was killed
and is launching from the notification, the same deep-link runs after
the initial WSS handshake completes — the channel push waits until
`ThunderCommStore.shared.isAuthed == true` so the agent context is
available before the view renders.

**Background wake (content-available):** When `content-available: 1` is
set, iOS calls
`application(_:didReceiveRemoteNotification:fetchCompletionHandler:)`
without showing the banner first. The app uses the 30-second window to
drain any unread WSS backlog so the user sees fresh state on next
foreground. Critical: call the completion handler within 30 seconds
with `.newData`, `.noData`, or `.failed` — failing to call it gets the
app throttled by iOS's push budget.

---

## 5b. Bug #9 — Message replay prevention

Bug #9 surfaced during Build 27 pressure testing: when iOS reconnected
to WSS after a network blip, the relay re-sent every message in the
unread window, even ones the device had already acked over APNs (or
over an earlier WSS session). Michael's chat scroll showed each
message 2–3 times in the worst case.

The APNs work makes this worse — APNs delivers eagerly, then WSS
replay arrives on next reconnect, then *that* replay can include
already-shown messages. The fix has three layers:

**Layer 1 — Acknowledge-only retry on reconnect (iOS → relay):**
On WSS open the app sends:

```json
{ "type": "resume", "peerId": "michael-iphone",
  "afterTimestamp": 1747000000000,
  "ackedIds": ["abc-123", "def-456", "..."] }
```

`afterTimestamp` is the `ts` of the most recent message rendered in
the chat scroll (whether it arrived via WSS or APNs — both paths write
to the same `ThunderCommStore`). `ackedIds` is the FIFO of seen ids
shared with the NSE (§5, `tc.id`). Relay delivers only messages
strictly newer than `afterTimestamp` AND whose id is not in `ackedIds`.

**Layer 2 — Ack cache clear on reconnect (relay side):**
The relay's in-memory pending-ack map for that peerId is cleared the
moment the new WSS socket authenticates. Any partial delivery state
from the dead socket is discarded — `afterTimestamp` is the only
source of truth from the device.

**Layer 3 — Relay drop, not replay, on resume gap:**
If `afterTimestamp` is older than the relay's retention window
(currently 24h), the relay returns `{"type": "resume_gap"}` and the
app does a full snapshot fetch through the existing unread-since
endpoint. No silent message loss, but also no flood from a stale
device.

**Acceptance:** the dedup test in §10 (Test plan) covers the happy
path. The pressure-test gate (§13) adds two new scenarios: WiFi↔LTE
mid-session switch, and 30-second background → foreground bounce, both
verified to produce zero duplicates across a 20-message flood. The
Build 28b brief carries the full APNs test matrix in its Section L/M/N.

---

## 6. Delivery rules (relay side)

The relay sends a push when, and only when, **all** of the following hold:

1. The inbound message is `senderType: 'human'` OR `senderType: 'agent'` with
   `agentId !== 'jon'` (so Jon's own outputs to Michael trigger a push; Jon's
   self-talk on tnt does not).
2. The recipient peer has no active WSS connection — i.e., the in-memory
   `clients` map in `ThunderCommoChannel` shows no `state.authedAt > 0` for
   that peerId at the moment the message is broadcast.
3. The recipient peer has at least one APNs row whose `environment` matches
   the current build environment.
4. The message channel is in the peer's subscription list (`tnt`, `jmab`, or
   `direct:<peerId>`).

If any condition fails the relay records a `push_skipped` audit entry with the
reason and moves on. WSS-only delivery already covered it.

### Priorities

- `apns-priority: 10` for `direct:<peerId>` and any message tagged
  `urgent: true` in the original envelope.
- `apns-priority: 5` for `tnt` and `jmab` channel traffic. Low-priority pushes
  may be batched by Apple but won't burn the battery as fast on Michael's
  phone.

### Collapse key

`apns-collapse-id: <channel>` so a flood of messages on one channel coalesces
into the latest banner if the device has been offline. The notification body
shows the most recent message; the app drains the full backlog from WSS on
launch.

### Retry

429, 500, 502, 503, 504 — exponential backoff (1s, 2s, 4s, 8s, cap 60s) up to
5 attempts. After the 5th failure the message is dropped from the push queue
but **remains in the unified context file** for WSS replay on next foreground.
APNs delivery is a wake-up bonus, not the system of record.

---

## 7. Notification Service Extension (NSE)

iOS-only — Mack adds a target `ThunderCommoIOSNotificationService` to the
Xcode project. Responsibilities:

1. Decrypt or rewrite the alert body if `tc.preview` is `null` (placeholder
   for future end-to-end encryption — Phase 2; for now `tc.preview` is always
   populated and the NSE is a passthrough).
2. Update the unread badge count by reading the shared `UserDefaults`
   (`group.us.thunderai.thundercommo`) and writing back the new value.
3. Append `tc.id` to the seen-ids FIFO so the main app skips the dup if the
   WSS replay races the push.

The NSE has 30 seconds wall time, after which iOS shows the original payload.
Do not call the network from the NSE in this phase — all work is local.

---

## 8. Settings UI (iOS)

In `SettingsView.swift` add a "Notifications" section, after the existing
"Account" rows:

```
Notifications
  Push notifications        [toggle, default on]
    Status                  Authorized / Denied / Not Determined
    Last token refresh      <relative time>
    Last delivery           <relative time, or "—">
  Quiet hours (placeholder)
```

The toggle proxies to `requestAuthorization` (first time) or opens
`UIApplication.openSettingsURLString` (after the user has denied). Token state
is read from the shared container — same source the NSE writes to.

**Important:** the settings UI must persist its values to UserDefaults using
the suite `group.us.thunderai.thundercommo`. The current `SettingsView` bug
(Priority 7 in Build 28) writes to a per-app suite that the NSE cannot see;
fixing that bug is a prerequisite for the badge logic to work.

---

## 9. Provisioning & credentials

**Apple Developer artefacts (one-time setup):**

| Artefact   | Source                                              | Used by      |
| ---------- | --------------------------------------------------- | ------------ |
| Team ID    | Apple Developer → Membership                        | Relay        |
| Key ID     | Apple Developer → Keys → "+ Create" → APNs         | Relay        |
| Auth Key   | Same screen, download once as `AuthKey_<KEYID>.p8`  | Relay        |
| Bundle ID  | Identifiers tab — `us.thunderai.thundercommo`       | App + relay  |

**Storage on ThunderBase host (relay side, never iOS side):**

| Env var               | Value                                        |
| --------------------- | -------------------------------------------- |
| `APNS_AUTH_KEY_PATH`  | `/home/ubuntu/.thundergate/apns_auth.p8`     |
| `APNS_KEY_ID`         | 10-char key id from Apple Developer          |
| `APNS_TEAM_ID`        | 10-char team id from Apple Developer         |
| `APNS_BUNDLE_ID`      | `us.thunderai.thundercommo`                  |
| `APNS_ENVIRONMENT`    | `sandbox` (TestFlight) or `production`       |

The `.p8` file lives at `~/.thundergate/apns_auth.p8` with mode `0600`
and is owned by the `thundergate` user. It is **never** checked into
git — `.gitignore` already covers `.p8`; verify before the first commit
that touches APNs code. Backups go in 1Password under
`ThunderBase / APNs Auth Key` (Mack + Michael have access).

**Bundle id:** `us.thunderai.thundercommo` — must match the App ID the
APNs key was registered against. **App group:** `group.us.thunderai.thundercommo`
on both the main app target and the NSE target (see §3).

**Environments:** `sandbox` for TestFlight builds (relay uses
`api.sandbox.push.apple.com`), `production` for App Store builds
(relay uses `api.push.apple.com`). The iOS app reports its environment
in the `/v1/apns/register` call so the relay routes correctly on a
per-row basis — no global toggle.

---

## 10. Test plan

Pre-merge checklist for Mack:

1. **Permission flow** — fresh install, accept push, confirm token POSTs to
   relay with 200 OK.
2. **Background delivery** — kill app, send a `#tnt` message from another
   peer, confirm banner appears within 10s.
3. **Foreground suppression** — keep app foreground, send a message, confirm
   **no** banner appears (WSS handled it; the relay must skip because the WSS
   client list is non-empty).
4. **Dedup race** — go offline, queue 3 messages, come back online: WSS
   replay and APNs may both arrive. Confirm each `tc.id` shows exactly once
   in the chat scroll.
5. **Stale token** — uninstall, send a push, confirm relay deletes the row
   on the 410 response (relay logs `apns_unregistered peerId=… token=…`).
6. **Quiet-hours placeholder** — UI ships disabled. The toggle just shows the
   row; no functional impact this build.
7. **Pressure test gate** — Jon runs the existing CLI Jon pressure test
   against Build 28b RC1 before Mack ships. Push delivery is included in the
   pressure-test matrix (Build 28 brief item 5 — APNs added).

---

## 11. Open items for Phase 2

1. **End-to-end encryption** — payload preview leaks message content via
   Apple infra. Phase 2 swaps `tc.preview` for a ciphertext blob and decrypts
   in the NSE. Requires a phone-side key derived at pairing.
2. **Per-channel mute** — `tc.channel` is in the payload; iOS could suppress
   `tnt` while still alerting on `direct:michael-iphone`. Settings UI gets a
   per-channel toggle in Phase 2.
3. **Critical-alert** entitlement for emergency `direct:<peerId>` pushes that
   bypass Focus mode. Requires Apple approval — not blocking Build 28b.

---

## 12. Out of scope (do not implement now)

- Voice / video call notifications (handled by CallKit / PushKit, separate
  spec).
- Watch complication updates.
- Android FCM parity — tracked in `BYOAA_ANDROID_BRIEF.md`; FCM follows the
  same payload shape with provider-specific differences captured in that
  brief.

---

## 13. Acceptance gate

Build 28b ships only after:

- [ ] `POST /v1/apns/register` round-trips successfully in TestFlight.
- [ ] Killed-app banner test passes 5/5.
- [ ] Foreground-suppression test passes 5/5 (zero banners).
- [ ] Dedup test passes — no double-rendered messages in 20-message flood.
- [ ] 410 reaping verified once on real device.
- [ ] Settings shared-suite bug (Build 28 Priority 7) fixed and pressure test
      green on Build 28b RC1.
