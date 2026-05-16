import SwiftUI

@main
struct ThunderCommApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            AuthGate {
                OnboardingGate {
                    ContentView()
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
            }
            if phase == .background {
                APNsManager.shared.scheduleNextBackgroundRefresh()
            }
        }
    }
}
