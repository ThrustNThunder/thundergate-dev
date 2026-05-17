// SettingsView.swift
//
// Auth-related settings only — account, security, agents. Other app
// preferences live elsewhere; this file is the surface for everything that
// touches identity or credentials.

import SwiftUI

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
    @State private var endpointDraft = ""
    @State private var tokenDraft = ""
    @State private var senderDraft = ""
    @State private var connectionDraftsLoaded = false
    @State private var isSavingConnection = false
    @State private var isTokenVisible = false

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
                connectionSection
                sharingSection
                securitySection
                agentsSection
            }
            .navigationTitle("Settings")
            .onAppear {
                syncFromStore()
                syncConnectionDraftsIfNeeded()
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
        phoneDisplay = formatPhone(phone)
    }

    private func syncConnectionDraftsIfNeeded() {
        guard !connectionDraftsLoaded, let connectionStore else { return }
        endpointDraft = connectionStore.endpointText
        tokenDraft = connectionStore.token
        senderDraft = connectionStore.senderName
        connectionDraftsLoaded = true
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

            TextField("Phone (optional)", text: $phoneDisplay)
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
        // messages don't keep using the stale name until a cold launch. The
        // helper no-ops if the user has set an explicit Connection-section
        // override, so this can't clobber a conscious chat-sender choice.
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

    // MARK: - Connection
    //
    // Same endpoint/token/sender knobs that used to live in the header's
    // ellipsis menu. Folding them in here means there's exactly one
    // settings surface — the gear — instead of two near-identical entry
    // points. Only present when SettingsView is given a connectionStore;
    // the public init (sign-up flow) skips this section because the chat
    // shell hasn't booted yet.

    @ViewBuilder
    private var connectionSection: some View {
        if let connectionStore {
            Section {
                TextField("wss://relay.thunderai.us", text: $endpointDraft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .font(.callout.monospaced())

                Group {
                    if isTokenVisible {
                        TextField("Gateway token", text: $tokenDraft)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.callout.monospaced())
                    } else {
                        SecureField("Gateway token", text: $tokenDraft)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                }

                Button(isTokenVisible ? "Hide token" : "Show token") {
                    isTokenVisible.toggle()
                }
                .font(.caption.weight(.semibold))

                TextField("Display name", text: $senderDraft)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()

                Button {
                    isSavingConnection = true
                    connectionStore.updateConnectionSettings(
                        endpoint: endpointDraft,
                        token: tokenDraft,
                        senderName: senderDraft
                    )
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                        isSavingConnection = false
                        dismiss()
                    }
                } label: {
                    Label(isSavingConnection ? "Saving..." : "Save & reconnect",
                          systemImage: isSavingConnection ? "checkmark.circle.fill" : "arrow.triangle.2.circlepath")
                }
                .disabled(isSavingConnection)

                if connectionStore.isUsingCustomEndpoint {
                    Button(role: .destructive) {
                        connectionStore.resetEndpoint()
                        endpointDraft = connectionStore.endpointText
                    } label: {
                        Label("Reset endpoint to default", systemImage: "arrow.uturn.backward")
                    }
                }
            } header: {
                Text("Connection")
            } footer: {
                Text("Live chat endpoint, token, and the display name other peers see.")
            }
        }
    }

    // MARK: - Sharing & Tokens

    @ViewBuilder
    private var sharingSection: some View {
        Section {
            NavigationLink {
                AgentTokenView()
            } label: {
                Label("Connect an Agent", systemImage: "key.horizontal.fill")
            }

            if let connectionStore {
                NavigationLink {
                    MyConnectionInfoView(connectionStore: connectionStore)
                } label: {
                    Label("My Connection Info", systemImage: "person.crop.circle.badge.questionmark")
                }
            }
        } header: {
            Text("Sharing & Tokens")
        } footer: {
            Text("Generate a token for an agent to connect with, or view your own connection info.")
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
