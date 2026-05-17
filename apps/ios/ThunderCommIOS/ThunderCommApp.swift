// ThunderCommApp.swift
//
// Build 55 final: app root + gate composition.
//
// Flow:
//   SplashView (1.2s) → AuthGate (signup / signin / biometric lock) →
//   OnboardingGate (defensive tc-h- check) → ContentView
//
// ContentView itself presents the post-signup wizard (OnboardingView — "Your
// Token" + "Add Agent") as a fullScreenCover on first launch after signup,
// keyed on a UserDefaults flag. This keeps OnboardingGate to a single
// responsibility (the brief's "is the user signed in?" check) while still
// reliably showing the wizard the moment AuthGate transitions to authed
// state.
//
// What this file deliberately does NOT do:
//   - No AccountStore seeding. No `4ca1100a…` token. No default "Jon" agent.
//   - No hidden URL plumbing. AccountStore starts empty and stays empty
//     unless the user explicitly adds an agent.

import SwiftUI

@main
struct ThunderCommApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var showingSplash = true

    var body: some Scene {
        WindowGroup {
            Group {
                if showingSplash {
                    SplashView { showingSplash = false }
                } else {
                    AuthGate {
                        OnboardingGate {
                            ContentView()
                        }
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
            }
            if phase == .background {
                APNsManager.shared.scheduleNextBackgroundRefresh()
            }
        }
    }
}

// MARK: - OnboardingGate
//
// Build 55 final: this gate's ONLY job is to confirm the user has a
// `tc-h-` session token. If yes, hand off to ContentView. If no, surface
// SignUpView as a defensive fallback (in practice this branch is
// unreachable because AuthGate gates auth upstream; it's here so the gate
// can never silently render an authenticated-only view to a logged-out
// device).
//
// Crucially: there is no AccountStore seeding here. No default Jon. No
// hardcoded gateway token. AccountStore starts empty after signup and stays
// empty until the user explicitly adds an agent via the onboarding wizard's
// "Add Agent" screen or Settings later.

public struct OnboardingGate<Content: View>: View {
    @StateObject private var auth = AuthManager.shared
    @ViewBuilder var content: () -> Content

    public init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    public var body: some View {
        if auth.peekToken() != nil {
            content()
        } else {
            SignUpView()
        }
    }
}

// MARK: - Onboarding-completed flag
//
// Used by ContentView to decide whether to present the post-signup wizard.
// Set to true the first time OnboardingView's "Open ThunderCommo" fires;
// stays true across launches. Sign-out resets it to false so the next user
// who signs in on this device sees the wizard fresh.

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
