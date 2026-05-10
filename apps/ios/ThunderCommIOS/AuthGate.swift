// AuthGate.swift
//
// Root view that decides what the user sees:
//   - No persisted account            → SignUpView (with link to SignInView).
//   - Account exists, biometrics on,
//     cold launch or stale session    → biometrics prompt.
//   - Authenticated, fresh            → Content (chat root).
//
// "Stale" is defined as more than 5 minutes since lastAuthenticatedAt. We
// re-evaluate whenever scenePhase becomes .active so a backgrounded app that
// sat in someone else's hands has to re-prove identity before it shows the
// thread list. Anything shorter would feel hostile; anything longer wouldn't
// match what users expect from a messaging app.

import SwiftUI

private let kReAuthAfterSeconds: TimeInterval = 5 * 60

public struct AuthGate<Content: View>: View {

    @StateObject private var store = UserStore.shared
    @Environment(\.scenePhase) private var scenePhase

    @State private var biometricInProgress = false
    @State private var biometricError: String?
    @State private var showSignIn = false

    private let content: () -> Content

    public init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    public var body: some View {
        Group {
            if store.currentUser == nil {
                noAccountView
            } else if !store.isAuthenticated {
                if needsBiometricUnlock {
                    biometricLockView
                } else {
                    signInPrompt
                }
            } else {
                content()
            }
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active { handleBecameActive() }
        }
        .sheet(isPresented: $showSignIn) {
            SignInView { showSignIn = false }
        }
    }

    private var needsBiometricUnlock: Bool {
        store.currentUser?.biometricsEnabled ?? false
    }

    // MARK: - No account

    private var noAccountView: some View {
        SignUpView { /* signup flow handles its own state */ }
    }

    // MARK: - Biometric lock

    private var biometricLockView: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "lock.fill")
                .font(.system(size: 72))
                .foregroundStyle(.tint)
            Text("ThunderCommo is locked")
                .font(.title.bold())
            if let user = store.currentUser {
                Text(user.displayName)
                    .foregroundStyle(.secondary)
            }
            if let biometricError {
                Text(biometricError)
                    .foregroundStyle(.red)
                    .font(.callout)
                    .padding(.horizontal)
                    .multilineTextAlignment(.center)
            }
            Spacer()
            Button {
                runBiometricUnlock()
            } label: {
                Label("Unlock with Face ID", systemImage: "faceid")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(biometricInProgress)

            Button("Use password instead") { showSignIn = true }
                .buttonStyle(.borderless)
        }
        .padding()
        .onAppear { runBiometricUnlock() }
    }

    private func runBiometricUnlock() {
        guard !biometricInProgress else { return }
        biometricInProgress = true
        biometricError = nil
        Task {
            defer { biometricInProgress = false }
            do {
                let ok = try await store.authenticateWithBiometrics()
                if !ok { biometricError = "Face ID didn't recognize you." }
            } catch {
                biometricError = error.localizedDescription
            }
        }
    }

    // MARK: - Password prompt (no biometrics)

    private var signInPrompt: some View {
        SignInView { /* SignInView updates the store directly */ }
    }

    // MARK: - Foreground re-auth

    private func handleBecameActive() {
        guard store.currentUser != nil, store.isAuthenticated else { return }
        let last = store.lastAuthenticatedAt ?? .distantPast
        if Date().timeIntervalSince(last) > kReAuthAfterSeconds {
            store.signOut()
        }
    }
}
