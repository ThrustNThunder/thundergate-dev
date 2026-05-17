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
                RootView()
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

// Shows SplashView first, then swaps to the wrapped content once the launch
// sequence (logo hold + relay-connected banner + fade) completes. DeliveryCore's
// connect path runs off scenePhase, not off the view tree, so the splash
// doesn't gate the connection from starting.
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

// Hosts the auth + content stack and the agent-initiated vault unlock sheet.
// The sheet binding treats any nil transition (swipe-to-dismiss or
// programmatic clear) as a deny so an unresolved request never silently
// disappears from the relay's point of view.
private struct RootView: View {
    @EnvironmentObject private var deliveryCore: DeliveryCore

    var body: some View {
        AuthGate {
            OnboardingGate {
                ContentView()
            }
        }
        .sheet(item: Binding(
            get: { deliveryCore.pendingVaultRequest },
            set: { newValue in
                if newValue == nil, let current = deliveryCore.pendingVaultRequest {
                    deliveryCore.resolveVaultRequest(current.requestId, outcome: .denied)
                }
            }
        )) { request in
            VaultUnlockSheet(
                request: request,
                onApprove: {
                    deliveryCore.resolveVaultRequest(request.requestId, outcome: .approved)
                },
                onDeny: {
                    deliveryCore.resolveVaultRequest(request.requestId, outcome: .denied)
                }
            )
        }
    }
}
