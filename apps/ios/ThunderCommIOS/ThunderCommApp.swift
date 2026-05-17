import SwiftUI
import UserNotifications

@main
struct ThunderCommApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    init() {
        NSLog("[APNs] ThunderCommApp init")
    }

    var body: some Scene {
        WindowGroup {
            SplashGate {
                AuthGate {
                    OnboardingGate {
                        ContentView()
                    }
                }
            }
            .environmentObject(DeliveryCore.shared)
            .environmentObject(AuthManager.shared)
            .environmentObject(AccountStore.shared)
        }
        .onChange(of: scenePhase) { _, phase in
            DeliveryCore.shared.handleScenePhase(phase)
            if phase == .active {
                AuthManager.shared.handleScenePhaseActive()
                UNUserNotificationCenter.current().setBadgeCount(0) { error in
                    if let error { NSLog("[Badge] clear failed: \(error)") }
                }
            }
            if phase == .background {
                APNsManager.shared.scheduleNextBackgroundRefresh()
            }
        }
    }
}

private struct SplashGate<Content: View>: View {
    @State private var showSplash = true
    @ViewBuilder var content: () -> Content

    var body: some View {
        ZStack {
            if showSplash {
                SplashView(onComplete: {
                    withAnimation(.easeInOut(duration: 0.25)) {
                        showSplash = false
                    }
                })
                .transition(.opacity)
            } else {
                content()
                    .transition(.opacity)
            }
        }
    }
}

// Build 55 final: ContentView reads this flag and presents the post-signup
// wizard (OnboardingView — Your Token + Add Agent) as a fullScreenCover on
// first launch after a fresh signup. SignUpView resets it on a successful
// account creation; OnboardingView's "Open ThunderCommo" sets it; sign-out
// resets it so the next user lands fresh.

public enum OnboardingFlag {
    public static let key = "thunder.onboarding.completed.v1"

    public static func markCompleted() {
        UserDefaults.standard.set(true, forKey: key)
    }

    public static func reset() {
        UserDefaults.standard.set(false, forKey: key)
    }

    public static var isCompleted: Bool {
        UserDefaults.standard.bool(forKey: key)
    }
}
