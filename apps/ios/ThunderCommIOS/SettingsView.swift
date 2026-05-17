// SettingsView.swift
//
// Auth-related settings only — account, security, agents. Other app
// preferences live elsewhere; this file is the surface for everything that
// touches identity or credentials.

import SwiftUI
import UIKit

public struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss

    @StateObject private var store = UserStore.shared
    private let connectionStore: ThunderCommStore?

    @State private var displayName = ""
    @State private var phone = ""
    @State private var phoneDisplay = ""
    @State private var showSignOutConfirm = false
    @State private var showAddAgent = false
    @State private var showChangePassword = false
    @State private var biometricsError: String?
    @State private var profileSaved = false

    public var onSignedOut: (() -> Void)?

    public init(onSignedOut: (() -> Void)? = nil) {
        self.connectionStore = nil
        self.onSignedOut = onSignedOut
    }

    init(connectionStore: ThunderCommStore?, onSignedOut: (() -> Void)? = nil) {
        self.connectionStore = connectionStore
        self.onSignedOut = onSignedOut
    }

    public var body: some View {
        NavigationStack {
            Form {
                accountSection
                connectionInfoSection
                securitySection
                agentsSection
                aboutSection
            }
            .navigationTitle("Settings")
            .onAppear {
                syncFromStore()
            }
            .onChange(of: store.currentUser?.displayName) { _, _ in
                syncFromStore()
            }
            .onChange(of: store.currentUser?.phoneNumber) { _, _ in
                syncFromStore()
            }
            .sheet(isPresented: $showAddAgent) {
                AddAgentView { _ in showAddAgent = false }
            }
            .sheet(isPresented: $showChangePassword) {
                ChangePasswordView()
            }
            .confirmationDialog("Sign out of ThunderCommo?",
                                isPresented: $showSignOutConfirm,
                                titleVisibility: .visible) {
                Button("Sign Out", role: .destructive) {
                    // Build 55 final: sign-out wipes ALL session-scoped state
                    // so the next user who lands on this device starts blank.
                    store.signOut()
                    AccountStore.shared.clearAll()
                    OnboardingFlag.reset()
                    onSignedOut?()
                }
                Button("Cancel", role: .cancel) { }
            }
        }
    }

    private func syncFromStore() {
        displayName = store.currentUser?.displayName ?? ""
        phone = store.currentUser?.phoneNumber ?? ""
        phoneDisplay = formatPhone(phone)
    }

    // MARK: - Account

    private var accountSection: some View {
        Section("Account") {
            HStack {
                Text("Email")
                Spacer()
                Text(store.currentUser?.email ?? "—")
                    .foregroundStyle(.secondary)
            }

            TextField("Display name", text: $displayName)
                .onSubmit { saveProfileEdits() }

            TextField("Phone", text: $phoneDisplay)
                .keyboardType(.phonePad)
                .textContentType(.telephoneNumber)
                .onChange(of: phoneDisplay) { _, newValue in
                    let digits = String(newValue.filter(\.isNumber).prefix(10))
                    phone = digits
                    let formatted = formatPhone(digits)
                    if formatted != newValue {
                        phoneDisplay = formatted
                    }
                }
                .onSubmit { saveProfileEdits() }

            Button(profileSaved ? "Profile saved" : "Save profile") {
                saveProfileEdits()
            }

            if let role = store.currentUser?.role {
                HStack {
                    Text("Role")
                    Spacer()
                    Text(role == .admin ? "Admin" : "User")
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func saveProfileEdits() {
        let trimmedName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        store.updateProfile(displayName: trimmedName, phoneNumber: phone)
        displayName = store.currentUser?.displayName ?? trimmedName
        phone = store.currentUser?.phoneNumber ?? phone
        phoneDisplay = formatPhone(phone)
        profileSaved = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            profileSaved = false
        }
        // Propagate the new display name to the live wire sender so outgoing
        // messages don't keep using the stale name until a cold launch.
        connectionStore?.applyProfileDisplayName(trimmedName)
    }

    private func formatPhone(_ digits: String) -> String {
        let clean = Array(digits.filter(\.isNumber).prefix(10))
        switch clean.count {
        case 0:
            return ""
        case 1...3:
            return "(" + String(clean)
        case 4...6:
            return "(" + String(clean[0..<3]) + ") " + String(clean[3..<clean.count])
        default:
            return "(" + String(clean[0..<3]) + ") " + String(clean[3..<6]) + "-" + String(clean[6..<clean.count])
        }
    }

    // MARK: - Connection info
    //
    // Build 55 final: the legacy custom-endpoint / gateway-token editor was
    // removed. There is exactly one user-facing surface for their personal
    // credential — MyConnectionInfoView — and exactly one place the relay
    // URL is visible — the About section at the bottom of Settings.

    private var connectionInfoSection: some View {
        Section {
            NavigationLink {
                MyConnectionInfoView()
            } label: {
                Label("My Connection Info", systemImage: "person.crop.circle.badge.questionmark")
            }
        } header: {
            Text("Connection")
        } footer: {
            Text("View and copy your personal token.")
        }
    }

    // MARK: - Security

    private var securitySection: some View {
        Section("Security") {
            Toggle(isOn: Binding(
                get: { store.currentUser?.biometricsEnabled ?? false },
                set: { newValue in toggleBiometrics(newValue) }
            )) {
                Label("Face ID / Touch ID", systemImage: "faceid")
            }

            if let biometricsError {
                Text(biometricsError)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            Button {
                showChangePassword = true
            } label: {
                Label("Change password", systemImage: "key.fill")
            }

            Button(role: .destructive) {
                showSignOutConfirm = true
            } label: {
                Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                    .foregroundStyle(.red)
            }
        }
    }

    private func toggleBiometrics(_ on: Bool) {
        biometricsError = nil
        if on {
            Task {
                do {
                    let ok = try await store.enableBiometrics()
                    if !ok { biometricsError = "Face ID enrollment was cancelled." }
                } catch {
                    biometricsError = error.localizedDescription
                }
            }
        } else {
            if var user = store.currentUser {
                user.biometricsEnabled = false
                UserDefaults.standard.set(
                    try? JSONEncoder().encode(user),
                    forKey: "thunder.user.account.v1"
                )
            }
        }
    }

    // MARK: - Agents

    private var agentsSection: some View {
        Section {
            ForEach(store.currentUser?.agents ?? []) { agent in
                HStack(spacing: 12) {
                    Text(agent.agentEmoji).font(.title2)
                    VStack(alignment: .leading) {
                        HStack {
                            Text(agent.agentName).font(.body.bold())
                            if agent.isDefault {
                                Text("DEFAULT")
                                    .font(.caption2.bold())
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(.tint.opacity(0.2))
                                    .clipShape(Capsule())
                            }
                        }
                        Text(agent.wsURL)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .onDelete { indexSet in
                guard let agents = store.currentUser?.agents else { return }
                for i in indexSet { store.removeAgent(id: agents[i].id) }
            }

            Button {
                showAddAgent = true
            } label: {
                Label("Add agent", systemImage: "plus.circle.fill")
            }
        } header: {
            Text("Agents")
        } footer: {
            Text("Swipe to remove. The default agent is used when you start a chat.")
        }
    }

    // MARK: - About
    //
    // Build 55 final: the relay URL is shown EXACTLY here and nowhere else in
    // the app. Version + build come from the bundle. Copy buttons let support
    // grab the relay endpoint without anyone hunting for it in the keychain.

    private var aboutSection: some View {
        Section {
            HStack {
                Text("ThunderCommo")
                Spacer()
                Text(Self.versionString)
                    .font(.callout.monospaced())
                    .foregroundStyle(.secondary)
            }
            HStack {
                Text("By")
                Spacer()
                Text("Boost and Bolt LLC")
                    .foregroundStyle(.secondary)
            }
            RelayURLRow()
        } header: {
            Text("About")
        }
    }

    private static var versionString: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "—"
        let build = info?["CFBundleVersion"] as? String ?? "—"
        return "\(short) (\(build))"
    }
}

// MARK: - About: relay URL row

private struct RelayURLRow: View {
    private static let relayURL = "relay.thunderai.us"
    @State private var didCopy: Bool = false

    var body: some View {
        HStack {
            Text("Relay")
            Spacer()
            Text(Self.relayURL)
                .font(.callout.monospaced())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            Button {
                UIPasteboard.general.string = Self.relayURL
                didCopy = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { didCopy = false }
            } label: {
                Image(systemName: didCopy ? "checkmark.circle.fill" : "doc.on.doc")
                    .font(.caption.weight(.semibold))
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(didCopy ? "Copied" : "Copy relay URL")
        }
    }
}

// MARK: - Change password (placeholder)

struct ChangePasswordView: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Spacer()
                Image(systemName: "key.fill").font(.system(size: 60))
                Text("Password change coming soon")
                    .font(.title3.bold())
                Text("This will land in the next build alongside email-link recovery.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)
                Spacer()
                Button("Close") { dismiss() }
                    .buttonStyle(.borderedProminent)
            }
            .padding()
            .navigationTitle("Change password")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
