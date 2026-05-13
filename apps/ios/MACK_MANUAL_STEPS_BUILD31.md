# Build 31 — Manual Xcode Steps for Mack

CLI Jon completed the Build 31 source changes:

- **Task 1** — `subscribedChannels` already loops over `availableDirectAgents`
  in `ThunderCommStore.swift` (landed in Build 30 DM-routing run, lines
  ~1172-1185). Verified on disk in this run; no further source edit needed.
- **Task 2** — APNs `APNsManager.swift` + `AppDelegate.swift` already wire
  every piece the Build 31 brief asks for. Verified in this run (see §1
  below). Capabilities and entitlements still require the Xcode UI steps
  below.
- **Task 3** — `bridge.mjs` on ThunderBase now emits Mack-format `typing`
  events to the federation relay on both dispatch (`typing: true`) and
  reply land (`typing: false`). Server-side only; no iOS change.

A handful of items can only be done in the Xcode UI — they cannot be
expressed in source. Please walk through this checklist before cutting
Build 31.

## 1. APNs source verification (already done, FYI)

`APNsManager.swift` already does all of:

- Requests authorization (`requestUserAuthorization`) — gated behind the
  onboarding primer; never on cold launch.
- Posts `.notificationsDeclined` when the user denies, so ContentView's
  in-app banner with the **Open Settings** deep link fires.
- Registers for remote notifications in `bootstrap()` so APNs hands us a
  device token regardless of alert permission (silent push works without
  user authorization).
- Implements `handleDeviceToken(_:)` which POSTs the hex device token to
  `account.httpURL + "/api/devices/token"` with the bearer auth token,
  bundle id, account id, and platform fields.

`AppDelegate.swift` already does all of:

- Sets `UNUserNotificationCenter.current().delegate = self`.
- Calls `APNsManager.shared.bootstrap()` on launch.
- Wires `didRegisterForRemoteNotificationsWithDeviceToken` →
  `APNsManager.handleDeviceToken(_:)`.
- Wires `didFailToRegisterForRemoteNotificationsWithError` →
  `APNsManager.handleRegistrationFailure(_:)`.
- Wires `didReceiveRemoteNotification` → `APNsManager.handleSilentPush(...)`.
- Implements `UNUserNotificationCenterDelegate.willPresent` for foreground
  banner presentation.
- Implements `UNUserNotificationCenterDelegate.didReceive` to post
  `.openChannel` with the payload `channel` for ContentView routing.

**Registration endpoint resolution.** The brief lists two possible URLs:

```
https://relay.thunderai.us/api/devices/token
http://3.232.106.78:18794/register
```

The current code keeps the historical `account.httpURL + "/api/devices/token"`
path because the relay is already wired there and the existing APNs server
on ThunderBase serves that route. If you want to switch the iOS client
to talk directly to port 18794 on `3.232.106.78` instead, flag it and we
will swap the hostname constant.

## 2. Push Notifications capability

1. Open `apps/ios/ThunderCommIOS.xcodeproj` in Xcode.
2. Select the **ThunderCommIOS** target → **Signing & Capabilities** tab.
3. Click **+ Capability** and add **Push Notifications**.
4. Confirm the entitlements file (`ThunderCommIOSDebug.entitlements` /
   `ThunderCommIOSRelease.entitlements`) now includes
   `<key>aps-environment</key><string>development</string>` (or `production`
   on the Release configuration). The Debug entitlements should stay on
   `development`; the Release entitlements should be `production` before the
   App Store build.

## 3. Background Modes → Remote notifications

1. Same **Signing & Capabilities** tab.
2. Click **+ Capability** → **Background Modes**.
3. Check both:
   - **Remote notifications** (required — APNs silent push wakes the app to
     drain the inbox).
   - **Background fetch** (already used by `BGAppRefreshTask` in
     `APNsManager.scheduleNextBackgroundRefresh()`).

## 4. Info.plist sanity check

`APNsManager.swift` documents two keys that must exist in `Info.plist`:

```xml
<key>UIBackgroundModes</key>
<array>
  <string>remote-notification</string>
  <string>fetch</string>
</array>

<key>BGTaskSchedulerPermittedIdentifiers</key>
<array>
  <string>us.thunderai.thunderagent.refresh</string>
</array>
```

Adding the Background Modes capability in step 3 will write the
`UIBackgroundModes` array for you, but verify the BGTask identifier line is
also present.

## 5. APNs key on the relay / ThunderBase

The .p8 push key, key ID, and team ID live on ThunderBase (`apns_server.py`,
port 18794) and never in the iOS project. No client-side action required —
just confirm with Jon that the relay has the matching key before you ship
a build that asks for the system push prompt.

## 6. Smoke test after building

- Cold launch on a clean install → onboarding step **Notifications** should
  trigger the iOS permission alert.
- Tap **Allow** → check Console for `[APNs] token upload non-2xx` or
  failures. A 2xx upload means the relay accepted the device token.
- Tap **Don't Allow** → the chat root should show the in-app banner
  "Notifications off" with an **Open Settings** button.
- Backgrounded silent push → `APNsManager.handleSilentPush` should call
  `DeliveryCore.shared.drainInbox()`.
- Tapping a notification carrying `{"channel": "tnt"}` (or any custom
  channel) should switch the route via the `.openChannel` notification
  pathway in `ContentView`.
- DM thread switching → with Mack and Rex visible in the agent picker,
  open a DM thread with Mack, then have Jon DM you. The bubble should
  arrive without needing to swap threads (subscribedChannels covers all
  three direct channels).
- Jon thinking dots → send a `#tnt` message addressed to Jon. iOS should
  show the typing indicator for Jon within ~1s of dispatch and clear it
  the moment Jon's reply lands. (This is the bridge-side `typing` event
  the Build 31 brief added — server-side change, but the indicator path
  is exercised end-to-end by this test.)

---

## Notes on choices CLI Jon made

These were ambiguous in the Build 31 brief; documenting the conservative
calls here so you and Jon can override if needed:

1. **APNs endpoint kept as `/api/devices/token` via `account.httpURL`** —
   the brief listed `http://3.232.106.78:18794/register` as an alternative,
   but the existing path already targets the relay's APNs handler and
   carries account id + bearer auth + bundle id, which the raw `/register`
   route on the standalone APNs server does not require. Easier to add a
   route alias on the server than to rewrite the iOS path. Flag if Jon
   prefers the new path.
2. **`typing` event channel default** — the bridge falls back to
   `lastDispatchChannel || 'tnt'` for the typing event channel, mirroring
   the reply path. This means a DM dispatch sends `typing` on
   `direct:<peer>` and a `#tnt` dispatch sends it on `tnt`. Stop-typing
   uses the same value, so the start/stop pair always agrees.
3. **`originPeer` mirrors the federation auth peerId** —
   `thunderbase-${AGENT_ID_SELF}` (i.e., `thunderbase-jon` in normal
   operation). This matches the relay's peer registration so the event
   round-trips cleanly.
