// APNsManager.swift
//
// Required Info.plist additions:
//
//   <key>UIBackgroundModes</key>
//   <array>
//     <string>remote-notification</string>
//     <string>fetch</string>
//   </array>
//
//   <key>BGTaskSchedulerPermittedIdentifiers</key>
//   <array>
//     <string>us.thunderai.thunderagent.refresh</string>
//   </array>
//
// Required entitlements (ThunderAgent.entitlements):
//
//   <key>aps-environment</key>
//   <string>development</string>     <!-- or "production" for App Store -->
//
// Required Xcode capabilities:
//   - Push Notifications
//   - Background Modes → Remote notifications, Background fetch
//
// Wire-in points (see INTEGRATION_NOTES_V2.md for full sequence):
//   1. App launch → APNsManager.shared.bootstrap()
//   2. AppDelegate.didRegisterForRemoteNotificationsWithDeviceToken
//        → APNsManager.shared.handleDeviceToken(deviceToken)
//   3. AppDelegate.didReceiveRemoteNotification
//        → APNsManager.shared.handleSilentPush(userInfo, completion:)

import Foundation
import UIKit
import UserNotifications
import BackgroundTasks

@MainActor
public final class APNsManager: NSObject {

    public static let shared = APNsManager()

    public static let backgroundRefreshIdentifier = "us.thunderai.thunderagent.refresh"

    // The most recent device token APNs has handed us. Set as soon as we
    // receive it, regardless of whether we have an account yet.
    private var lastUploadedToken: String?

    // The token the server has confirmed (200/204) it accepted. Stays nil
    // until /api/devices/token returns 2xx, so we can detect "received from
    // APNs but never accepted by server" and retry after onboarding.
    private var lastConfirmedUpload: String?

    // Call this from your App's `init` or `applicationDidFinishLaunching`.
    //
    // Bootstrap registers the BG task and asks APNs for a device token so
    // silent push works as soon as the relay knows the token. It does NOT
    // show the visible-notification permission prompt — that's gated behind
    // the onboarding primer (see `requestUserAuthorization`). Silent pushes
    // do not require user authorization, so registering up-front is fine.
    public func bootstrap() {
        registerBackgroundTask()
        // Safe to call regardless of permission state; this gives us a
        // device token for silent push even if the user later denies alerts.
        UIApplication.shared.registerForRemoteNotifications()
    }

    // MARK: - Authorization & registration

    /// Returns the current visible-notification authorization status. Used by
    /// the onboarding primer to decide whether to show itself.
    public func currentAuthorizationStatus() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    /// Triggers the iOS system prompt for alert/sound/badge permission. Call
    /// this from the primer screen after the user taps "Enable Notifications";
    /// never call it on cold launch. Returns true if the user granted at
    /// least the alert option.
    @discardableResult
    public func requestUserAuthorization() async -> Bool {
        let center = UNUserNotificationCenter.current()
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .badge, .sound])
            // If the user just granted, re-register so APNs hands us a token
            // bound to the now-permitted environment.
            if granted {
                UIApplication.shared.registerForRemoteNotifications()
            } else {
                // Surface the decline so the chat root can show an in-app
                // banner inviting the user to enable later via Settings.
                NotificationCenter.default.post(name: .notificationsDeclined, object: nil)
            }
            return granted
        } catch {
            NSLog("[APNs] auth request failed: \(error)")
            return false
        }
    }

    // MARK: - Token upload

    public func handleDeviceToken(_ tokenData: Data) {
        let token = tokenData.map { String(format: "%02x", $0) }.joined()
        lastUploadedToken = token
        guard token != lastConfirmedUpload else { return }
        Task { await uploadToken(token) }
    }

    public func handleRegistrationFailure(_ error: Error) {
        NSLog("[APNs] registration failed: \(error)")
    }

    // Onboarding completes after APNs has already handed us a token, so the
    // initial uploadToken() call short-circuited on a nil AccountStore.current.
    // The OnboardingView calls this after a new account is committed.
    public func retryTokenUploadIfNeeded() {
        guard let token = lastUploadedToken else { return }
        if token == lastConfirmedUpload { return }
        Task { await uploadToken(token) }
    }

    private func uploadToken(_ hexToken: String) async {
        guard let account = AccountStore.shared.current else { return }
        // Register device token via the public relay so clients no longer
        // need direct access to ThunderBase. The relay exposes
        // /api/devices/token and will forward/store the registration.
        guard let url = URL(string: "https://relay.thunderai.us/api/devices/token") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            req.setValue("Bearer \(try await AuthManager.shared.currentToken())", forHTTPHeaderField: "Authorization")
        } catch {
            NSLog("[APNs] no auth token, deferring upload")
            return
        }
        let body: [String: Any] = [
            "device_token": hexToken,
            "platform": "ios",
            "bundle_id": Bundle.main.bundleIdentifier ?? "",
            "account_id": account.id
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                NSLog("[APNs] token upload non-2xx: \(http.statusCode)")
            } else {
                lastConfirmedUpload = hexToken
                AccountStore.shared.updateDeviceToken(hexToken, for: account.id)
            }
        } catch {
            NSLog("[APNs] token upload failed: \(error)")
        }
    }

    // MARK: - Silent push handler

    public func handleSilentPush(
        _ userInfo: [AnyHashable: Any],
        completion: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        // The push payload is intentionally tiny — it's a wakeup signal.
        // We always drain inbox; we do not trust the payload to carry the
        // message contents.
        Task {
            await DeliveryCore.shared.drainInbox()
            completion(.newData)
        }
    }

    // MARK: - BGAppRefreshTask

    private func registerBackgroundTask() {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.backgroundRefreshIdentifier,
            using: nil
        ) { [weak self] task in
            guard let task = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            self?.handleBackgroundRefresh(task)
        }
    }

    public func scheduleNextBackgroundRefresh() {
        let req = BGAppRefreshTaskRequest(identifier: Self.backgroundRefreshIdentifier)
        req.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60) // 15 min
        do {
            try BGTaskScheduler.shared.submit(req)
        } catch {
            NSLog("[APNs] BG schedule failed: \(error)")
        }
    }

    private func handleBackgroundRefresh(_ task: BGAppRefreshTask) {
        scheduleNextBackgroundRefresh() // chain the next one immediately

        let drainTask = Task {
            await DeliveryCore.shared.drainInbox()
            task.setTaskCompleted(success: true)
        }

        task.expirationHandler = {
            drainTask.cancel()
        }
    }
}
