// SignUpView.swift
//
// Four-step sign-up flow. State lives on the view; the UserStore is the only
// thing that persists. Each step blocks Continue until it has what it needs,
// so we never push partial users through.

import SwiftUI

public struct SignUpView: View {

    public enum Step: Int { case credentials, profile, biometrics, notifications, done }

    @StateObject private var store = UserStore.shared
    @State private var step: Step = .credentials

    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""
    @State private var displayName = ""
    @State private var phone = ""
    @State private var bioEnabled = false
    @State private var notificationsRequested = false
    @State private var error: String?
    @State private var showAddAgent = false

    public var onFinished: (() -> Void)?

    public init(onFinished: (() -> Void)? = nil) {
        self.onFinished = onFinished
    }

    public var body: some View {
        VStack {
            ProgressView(value: Double(step.rawValue + 1), total: 5)
                .padding(.horizontal)
                .padding(.top, 8)

            switch step {
            case .credentials:   credentialsStep
            case .profile:       profileStep
            case .biometrics:    biometricsStep
            case .notifications: notificationsStep
            case .done:          doneStep
            }
        }
        .animation(.easeInOut, value: step)
        .sheet(isPresented: $showAddAgent) {
            AddAgentView { _ in
                showAddAgent = false
                onFinished?()
            }
        }
    }

    // MARK: - Step 1: credentials

    private var credentialsStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                Image(systemName: "bolt.fill")
                    .font(.title.weight(.bold))
                    .foregroundStyle(brandGradient)
                Text("ThunderCommo")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(brandGradient)
            }
            .padding(.top, 24)

            VStack(alignment: .leading, spacing: 4) {
                Text("Create your account")
                    .font(.largeTitle.bold())
                Text("A workspace where you and your agents can sync up.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            TextField("Email", text: $email)
                .keyboardType(.emailAddress)
                .textContentType(.emailAddress)
                .autocapitalization(.none)
                .disableAutocorrection(true)
                .textFieldStyle(.roundedBorder)

            SecureField("Password (min 8 chars)", text: $password)
                .textContentType(.newPassword)
                .textFieldStyle(.roundedBorder)

            SecureField("Confirm password", text: $confirmPassword)
                .textContentType(.newPassword)
                .textFieldStyle(.roundedBorder)

            if let error { errorRow(error) }

            Button("Continue") { advanceFromCredentials() }
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity)
                .disabled(email.isEmpty || password.isEmpty)

            Spacer()
        }
        .padding()
    }

    private func advanceFromCredentials() {
        error = nil
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let pattern = "^[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}$"
        guard trimmed.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil else {
            error = "That email doesn't look right."
            return
        }
        guard password.count >= 8 else {
            error = "Password must be at least 8 characters."
            return
        }
        guard password == confirmPassword else {
            error = "Passwords don't match."
            return
        }
        step = .profile
    }

    // MARK: - Step 2: profile

    private var profileStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("What should we call you?")
                .font(.largeTitle.bold())
                .padding(.top, 24)

            TextField("Display name", text: $displayName)
                .textContentType(.name)
                .textFieldStyle(.roundedBorder)

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("+1").foregroundStyle(.secondary)
                    TextField("Phone", text: $phone)
                        .keyboardType(.numberPad)
                        .textContentType(.telephoneNumber)
                        .onChange(of: phone) { _, newValue in
                            let digits = newValue.filter { $0.isNumber }
                            if digits != newValue { phone = digits }
                        }
                }
                .padding(10)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(.gray.opacity(0.3)))

                Text("Required for account recovery. Numbers only, 10+ digits.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let error { errorRow(error) }

            Button("Continue") { advanceFromProfile() }
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity)
                .disabled(!profileFieldsValid)

            Spacer()
        }
        .padding()
    }

    // Validation gate for the Continue button on the profile step. Phone is
    // REQUIRED in Build 55 final — numeric, 10+ digits.
    private var profileFieldsValid: Bool {
        let nameOk = !displayName.trimmingCharacters(in: .whitespaces).isEmpty
        let phoneOk = phone.count >= 10 && phone.allSatisfy { $0.isNumber }
        return nameOk && phoneOk
    }

    private func advanceFromProfile() {
        error = nil
        let trimmedName = displayName.trimmingCharacters(in: .whitespaces)
        let digitsOnly = phone.filter { $0.isNumber }
        guard digitsOnly.count >= 10 else {
            error = "Phone number must be at least 10 digits, numbers only."
            return
        }
        guard !trimmedName.isEmpty else {
            error = "Display name is required."
            return
        }
        Task {
            do {
                try await store.signUp(
                    email: email,
                    password: password,
                    displayName: trimmedName,
                    phone: "+1" + digitsOnly
                )
                // Build 58: seed the relay Account so DeliveryCore can
                // connect — UserStore.syncAccountStore only fires when the
                // server returns agents, and on first signup there are none.
                seedRelayAccountAfterAuth(displayName: trimmedName)
                // A fresh signup re-arms the post-signup wizard (Your Token →
                // Add Agent). ContentView reads this flag from a fullScreenCover
                // and clears it when the user closes the wizard.
                OnboardingFlag.reset()
                step = .biometrics
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    // Build 58 SHIP BLOCKER (brief change #2 + Gap A): after signup the
    // `tc-h-` token is in the Keychain but AccountStore is empty unless the
    // server returned agents. DeliveryCore.connectWS() short-circuits when
    // AccountStore.current is nil — no relay, no roster, no messages. Seed
    // the default relay Account here and fire the three connection calls in
    // the order the brief specifies. Idempotent: if an Account already exists
    // (e.g. a signup retry after a transient error) we update its token in
    // place rather than appending duplicates.
    private func seedRelayAccountAfterAuth(displayName: String) {
        guard let token = AuthManager.shared.peekToken(), !token.isEmpty else { return }
        if let existing = AccountStore.shared.current {
            AccountStore.shared.updateToken(token, for: existing.id)
        } else {
            let account = Account(
                name: displayName,
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

    // MARK: - Step 3: biometrics

    private var biometricsStep: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "faceid")
                .font(.system(size: 80))
                .foregroundStyle(.tint)

            Text(bioEnabled ? "Face ID enabled" : "Use Face ID to unlock ThunderCommo")
                .font(.title2.bold())
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            if bioEnabled {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 56))
                    .foregroundStyle(.green)
            } else {
                Text("Faster sign-in. Your password stays safely on this device.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)
            }

            if let error { errorRow(error) }

            Spacer()

            VStack(spacing: 10) {
                Button(bioEnabled ? "Continue" : "Enable Face ID") {
                    bioEnabled ? (step = .notifications) : enableBio()
                }
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity)

                if !bioEnabled {
                    Button("Skip for now") { step = .notifications }
                        .buttonStyle(.borderless)
                }
            }
        }
        .padding()
    }

    private func enableBio() {
        error = nil
        Task {
            do {
                bioEnabled = try await store.enableBiometrics()
                if !bioEnabled { error = "Face ID couldn't be enabled." }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    // MARK: - Step 4: notifications primer
    //
    // Apple only lets us show the system permission alert once per install. If
    // the user dismisses it without thinking, every subsequent reminder has to
    // route them through Settings.app. The primer explains *why* we need
    // notifications before iOS asks, so the prompt arrives expected.

    private var notificationsStep: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "bell.badge.fill")
                .font(.system(size: 80))
                .foregroundStyle(.tint)

            Text("Stay in the loop")
                .font(.title2.bold())
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            Text("ThunderCommo needs notifications to deliver messages when the app is in the background. Without this, you'll only see new messages the next time you open the app.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .padding(.horizontal)

            if notificationsRequested {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(.green)
            }

            Spacer()

            VStack(spacing: 10) {
                Button(notificationsRequested ? "Continue" : "Enable Notifications") {
                    notificationsRequested ? (step = .done) : requestNotifications()
                }
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity)

                if !notificationsRequested {
                    Button("Not now") { step = .done }
                        .buttonStyle(.borderless)
                }
            }
        }
        .padding()
    }

    private func requestNotifications() {
        Task {
            // The return value tells us if the user granted alerts; either way
            // the OS prompt has now been shown, so move on.
            _ = await APNsManager.shared.requestUserAuthorization()
            notificationsRequested = true
            step = .done
        }
    }

    // MARK: - Step 5: done

    private var doneStep: some View {
        VStack(spacing: 22) {
            Spacer()
            Image(systemName: "bolt.fill")
                .font(.system(size: 72, weight: .bold))
                .foregroundStyle(brandGradient)

            VStack(spacing: 10) {
                Text("Welcome, \(store.currentUser?.displayName ?? "")")
                    .font(.largeTitle.bold())
                    .multilineTextAlignment(.center)

                Text("Connect an agent to finish setup.")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                Text("Once connected, agents and other humans share your channels — that's the whole point.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }

            Spacer()

            Button {
                showAddAgent = true
            } label: {
                Label("Add your first agent", systemImage: "bolt.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)

            Button("I'll do it later") { onFinished?() }
                .buttonStyle(.borderless)
        }
        .padding()
    }

    private var brandGradient: LinearGradient {
        LinearGradient(
            colors: [
                Color(red: 0.66, green: 0.42, blue: 0.98),
                Color(red: 0.92, green: 0.55, blue: 1.0)
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    // MARK: - Helpers

    private func errorRow(_ msg: String) -> some View {
        Text(msg)
            .font(.callout)
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
