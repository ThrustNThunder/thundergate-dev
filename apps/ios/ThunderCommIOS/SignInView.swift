// SignInView.swift
//
// Email + password sign-in. Face ID button shows up only if the persisted
// user has biometricsEnabled — there's no point offering it otherwise, and
// we won't claim it works just to bounce them.

import SwiftUI

public struct SignInView: View {

    @StateObject private var store = UserStore.shared

    @State private var email = ""
    @State private var password = ""
    @State private var error: String?
    @State private var showSignUp = false

    public var onSignedIn: (() -> Void)?

    public init(onSignedIn: (() -> Void)? = nil) {
        self.onSignedIn = onSignedIn
    }

    private var biometricsAvailable: Bool {
        store.currentUser?.biometricsEnabled ?? false
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Spacer().frame(height: 24)

            Text("⚡ ThunderCommo")
                .font(.largeTitle.bold())

            Text("Sign in to your account")
                .font(.title3)
                .foregroundStyle(.secondary)
                .padding(.bottom, 8)

            TextField("Email", text: $email)
                .keyboardType(.emailAddress)
                .textContentType(.emailAddress)
                .autocapitalization(.none)
                .disableAutocorrection(true)
                .textFieldStyle(.roundedBorder)

            SecureField("Password", text: $password)
                .textContentType(.password)
                .textFieldStyle(.roundedBorder)

            if let error {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .padding(.vertical, 4)
            }

            Button("Sign In") { signInTapped() }
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity)
                .disabled(email.isEmpty || password.isEmpty)

            if biometricsAvailable {
                Button {
                    biometricsTapped()
                } label: {
                    Label("Sign in with Face ID", systemImage: "faceid")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }

            Spacer()

            HStack {
                Text("New to ThunderCommo?")
                    .foregroundStyle(.secondary)
                Button("Create account") { showSignUp = true }
            }
            .frame(maxWidth: .infinity)
        }
        .padding()
        .sheet(isPresented: $showSignUp) {
            SignUpView { showSignUp = false; onSignedIn?() }
        }
    }

    private func signInTapped() {
        error = nil
        Task {
            do {
                try await store.signIn(email: email, password: password)
                seedRelayAccountAfterAuth()
                onSignedIn?()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func biometricsTapped() {
        error = nil
        Task {
            do {
                let ok = try await store.authenticateWithBiometrics()
                if ok { onSignedIn?() }
                else  { error = "Face ID didn't recognize you." }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    // Build 58 (brief Gap B): mirror SignUpView's seeding so a sign-out →
    // sign-in cycle restores a working AccountStore + reconnects DeliveryCore.
    // SignOut wipes AccountStore via SettingsView, so by the time this runs
    // there's nothing left to dedup against — but we still guard against an
    // already-present Account in case the signin path is hit without a prior
    // signout (e.g. token-refresh re-prompt).
    private func seedRelayAccountAfterAuth() {
        guard let token = AuthManager.shared.peekToken(), !token.isEmpty else { return }
        let display = store.currentUser?.displayName ?? ""
        if let existing = AccountStore.shared.current {
            AccountStore.shared.updateToken(token, for: existing.id)
        } else {
            let account = Account(
                name: display,
                wsURL: Account.defaultRelayWSURL,
                httpURL: Account.defaultRelayHTTPURL,
                token: token
            )
            AccountStore.shared.add(account, makeCurrent: true)
        }
        DeliveryCore.shared.handleScenePhase(.active)
        APNsManager.shared.retryTokenUploadIfNeeded()
        APNsManager.shared.bootstrap()
    }
}
