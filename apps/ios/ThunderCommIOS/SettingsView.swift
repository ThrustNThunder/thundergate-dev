// SettingsView.swift
//
// Auth-related settings only — account, security, agents. Other app
// preferences live elsewhere; this file is the surface for everything that
// touches identity or credentials.

import SwiftUI

public struct SettingsView: View {

    @StateObject private var store = UserStore.shared

    @State private var displayName = ""
    @State private var phone = ""
    @State private var showSignOutConfirm = false
    @State private var showAddAgent = false
    @State private var showChangePassword = false
    @State private var biometricsError: String?

    public var onSignedOut: (() -> Void)?

    public init(onSignedOut: (() -> Void)? = nil) {
        self.onSignedOut = onSignedOut
    }

    public var body: some View {
        NavigationStack {
            Form {
                accountSection
                securitySection
                agentsSection
            }
            .navigationTitle("Settings")
            .onAppear { syncFromStore() }
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
                    store.signOut()
                    onSignedOut?()
                }
                Button("Cancel", role: .cancel) { }
            }
        }
    }

    private func syncFromStore() {
        displayName = store.currentUser?.displayName ?? ""
        phone = store.currentUser?.phoneNumber ?? ""
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

            TextField("Phone (optional)", text: $phone)
                .keyboardType(.phonePad)
                .onSubmit { saveProfileEdits() }

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
        guard var user = store.currentUser else { return }
        user.displayName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        user.phoneNumber = phone.isEmpty ? nil : phone
        // Mutating UserStore from here is fine — currentUser's setter is private,
        // so we re-add the user via the same code path sign-up uses.
        UserDefaults.standard.set(
            try? JSONEncoder().encode(user),
            forKey: "thunder.user.account.v1"
        )
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
            // Disabling is a local-only flip; we don't need to re-prompt for it.
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
