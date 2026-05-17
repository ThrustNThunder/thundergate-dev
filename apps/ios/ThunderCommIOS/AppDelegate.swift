import UIKit
import UserNotifications

extension Notification.Name {
    // Posted when the user denies (or has previously denied) notification
    // authorization. ContentView listens and shows an in-app banner with a
    // jump to Settings.
    static let notificationsDeclined = Notification.Name("notificationsDeclined")
    // Posted when the user taps a notification. userInfo carries the
    // "channel" key when the push payload included one, so the UI can route
    // to that channel on open.
    static let openChannel = Notification.Name("openChannel")
}

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        NSLog("[APNs] AppDelegate didFinishLaunching")
        UNUserNotificationCenter.current().delegate = self
        // BGTaskScheduler.register (inside bootstrap) MUST run before this
        // method returns. The previous Task { @MainActor in ... } wrapper
        // deferred it past launch, so registration and registerForRemote
        // never fired.
        APNsManager.shared.bootstrap()
        return true
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NSLog("[APNs] didRegisterForRemote called")
        APNsManager.shared.handleDeviceToken(deviceToken)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NSLog("[APNs] didFailToRegister: \(error)")
        APNsManager.shared.handleRegistrationFailure(error)
    }

    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable : Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        APNsManager.shared.handleSilentPush(userInfo, completion: completionHandler)
    }
}

extension AppDelegate: UNUserNotificationCenterDelegate {
    // Show notifications as banners even when the app is in the foreground —
    // matches user expectation for chat apps.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }

    // User tapped a notification (or its action). If the push payload
    // carried a `channel` we surface it to the UI through the
    // `.openChannel` notification so ContentView can switch routes.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        if let channel = userInfo["channel"] as? String, !channel.isEmpty {
            NotificationCenter.default.post(
                name: .openChannel,
                object: nil,
                userInfo: ["channel": channel]
            )
        }
        completionHandler()
    }
}
