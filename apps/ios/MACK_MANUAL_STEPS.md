# Build 29 — Manual Xcode Steps for Mack

CLI Jon completed the Build 29 source changes (9 bug fixes + APNs wiring +
afterTimestamp replay fix). A handful of items can only be done in the Xcode
UI — they cannot be expressed in source. Please walk through this checklist
before cutting Build 29.

## 1. Push Notifications capability

1. Open `apps/ios/ThunderCommIOS.xcodeproj` in Xcode.
2. Select the **ThunderCommIOS** target → **Signing & Capabilities** tab.
3. Click **+ Capability** and add **Push Notifications**.
4. Confirm the entitlements file (`ThunderCommIOSDebug.entitlements` /
   `ThunderCommIOSRelease.entitlements`) now includes
   `<key>aps-environment</key><string>development</string>` (or `production`
   on the Release configuration). The Debug entitlements should stay on
   `development`; the Release entitlements should be `production` before the
   App Store build.

## 2. Background Modes → Remote notifications

1. Same **Signing & Capabilities** tab.
2. Click **+ Capability** → **Background Modes**.
3. Check both:
   - **Remote notifications** (required — APNs silent push wakes the app to
     drain the inbox).
   - **Background fetch** (already used by `BGAppRefreshTask` in
     `APNsManager.scheduleNextBackgroundRefresh()`).

## 3. Info.plist sanity check

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

Adding the Background Modes capability in step 2 will write the
`UIBackgroundModes` array for you, but verify the BGTask identifier line is
also present.

## 4. APNs key on the relay / ThunderBase

The .p8 push key, key ID, and team ID live on ThunderBase (`apns_server.py`)
and never in the iOS project. No client-side action required — just confirm
with Jon that the relay has the matching key before you ship a build that
asks for the system push prompt.

## 5. Smoke test after building

- Cold launch on a clean install → onboarding step **Notifications** should
  trigger the iOS permission alert.
- Tap **Allow** → check Console for `[APNs] token upload non-2xx` or
  failures. A 2xx upload means the relay accepted the device token.
- Tap **Don't Allow** → the chat root should show the in-app banner
  "Notifications off" with an **Open Settings** button.
- Backgrounded silent push → `APNsManager.handleSilentPush` should call
  `DeliveryCore.shared.drainInbox()`.
- Tapping a notification carrying `{"channel": "tnt"}` (or any custom
  channel) should switch the route via the new `.openChannel` notification
  pathway in `ContentView`.

---

## Notes on choices CLI Jon made

These were ambiguous in the Build 29 brief; documenting the conservative
calls here so you and Jon can override if needed:

1. **Endpoint name kept as `/api/devices/token`** — the brief used
   `/api/apns/register`, but the existing `APNsManager.uploadToken`
   already targets `/api/devices/token` and the relay/ThunderBase already
   honors it. Switching endpoints would be a backend coordination problem
   for no gain. Flag if Jon prefers the new path.
2. **afterTimestamp added to both `federation_auth` and `subscribe`
   payloads** — relay can read either. Both fields are optional
   (`Int64?`), so a relay that hasn't been updated will just ignore them.
3. **`.openChannel` payload key is `channel` (singular string)** — matches
   the brief example. The relay should send pushes with
   `userInfo["channel"] == "tnt"` (or `"jmab"`, `"direct"`, or any custom
   channel name without a leading `#`).
4. **Foreground push presentation** — the new
   `UNUserNotificationCenterDelegate` implementation presents notifications
   as banners even when the app is in the foreground, which is the chat-app
   norm. Toggle in `AppDelegate.userNotificationCenter(_:willPresent:_:)`
   if you want a different behavior.
