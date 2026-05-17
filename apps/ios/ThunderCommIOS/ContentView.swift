
import SwiftUI

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var store = ThunderCommStore()
    @State private var draft = ""
    @State private var composerResetID = UUID()
    @State private var showingOnlinePeers = false
    @State private var showingSettings = false
    @State private var showingAddAgent = false
    @State private var showingAddHuman = false
    @State private var showingAddChannel = false
    @State private var headerCollapsed = true

    // Build 55 final: the post-signup wizard (Your Token → Add Agent) runs as
    // a fullScreenCover the first time we land here after a fresh signup.
    // `OnboardingFlag.reset()` is called by SignUpView.advanceFromProfile when
    // the new tc-h- token is minted, which arms this cover; the wizard's
    // onFinished sets the flag and dismisses.
    @State private var showingPostSignupWizard: Bool = !OnboardingFlag.isCompleted

    var body: some View {
        ZStack {
            Color(uiColor: .systemGroupedBackground)
                .ignoresSafeArea()

            VStack(spacing: 14) {
                header

                Group {
                    if store.messages.isEmpty && store.streamingPreviews.isEmpty {
                        ContentUnavailableView(
                            "No messages yet",
                            systemImage: "bubble.left.and.bubble.right",
                            description: Text(emptyStateLabel)
                        )
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(
                            RoundedRectangle(cornerRadius: 24, style: .continuous)
                                .fill(Color(uiColor: .secondarySystemBackground))
                        )
                    } else {
                        MessageListView(
                            messages: store.messages,
                            localSender: store.senderName,
                            localPeerId: store.peerId,
                            activeIndicators: store.activeIndicators,
                            streamingPreviews: store.streamingPreviews,
                            hasOlderMessages: store.hasOlderMessages,
                            loadOlderMessages: store.loadOlderMessages,
                            deleteMessage: store.deleteMessage,
                            retryMessage: { store.retrySend(messageID: $0.id) },
                            deliveryState: store.deliveryState
                        )
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(
                            RoundedRectangle(cornerRadius: 24, style: .continuous)
                                .fill(Color(uiColor: .secondarySystemBackground))
                        )
                    }
                }

                ComposerBar(draft: $draft, placeholder: store.composePlaceholder) {
                    let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty else { return }
                    store.sendDraft(&draft)
                    draft = ""
                    composerResetID = UUID()
                }
                .id(composerResetID)
            }
            .padding()
        }
        .task {
            store.connectIfNeeded()
        }
        .onChange(of: draft) { _, newValue in
            store.draftDidChange(newValue)
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                store.connectIfNeeded()
            }
        }
        .sheet(isPresented: $showingSettings) {
            SettingsView(connectionStore: store)
        }
        .sheet(isPresented: $showingAddAgent) {
            AddAgentView { _ in showingAddAgent = false }
        }
        .sheet(isPresented: $showingAddHuman) {
            AddHumanInviteView()
        }
        .sheet(isPresented: $showingAddChannel) {
            AddChannelView(connectionStore: store)
        }
        .fullScreenCover(isPresented: $showingPostSignupWizard) {
            OnboardingView {
                OnboardingFlag.markCompleted()
                showingPostSignupWizard = false
            }
        }
        .sheet(isPresented: $showingOnlinePeers) {
            NavigationStack {
                List {
                    ForEach(store.orderedPeerIDs(), id: \.self) { participantID in
                        let status = store.statusForParticipantID(participantID)
                        let senderType = store.senderType(forParticipantID: participantID)
                        HStack(spacing: 12) {
                            Circle()
                                .fill(statusColor(for: status))
                                .frame(width: 10, height: 10)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(store.displayName(forParticipantID: participantID))
                                    .foregroundStyle(peerColor(for: participantID, senderType: senderType))
                                Text(statusLabel(for: status))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            HStack(spacing: 6) {
                                Text(store.roleLabel(forParticipantID: participantID))
                                if let model = store.modelForParticipantID(participantID) {
                                    Text(model)
                                }
                            }
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        }
                    }
                }
                .navigationTitle("Who’s Online")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") {
                            showingOnlinePeers = false
                        }
                    }
                }
            }
        }
    }

    private var emptyStateLabel: String {
        // Build 55 final: no hardcoded channel/route copy. Single generic
        // empty-state string, regardless of route — the chat is intentionally
        // blank until the user adds channels or agents themselves.
        "Messages will appear here."
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: headerCollapsed ? 8 : 12) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: "bolt.fill")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(brandGradient)
                VStack(alignment: .leading, spacing: 2) {
                    Text("ThunderCommo")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(brandGradient)
                    if !headerCollapsed {
                        Text("Humans + agents, in sync")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        headerCollapsed.toggle()
                    }
                } label: {
                    Image(systemName: headerCollapsed ? "chevron.down" : "chevron.up")
                        .font(.caption.weight(.bold))
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .accessibilityLabel(headerCollapsed ? "Expand header" : "Collapse header")

                Button {
                    showingSettings = true
                } label: {
                    Image(systemName: "gearshape.fill")
                        .font(.subheadline.weight(.semibold))
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .accessibilityLabel("Settings")
            }

            HStack(spacing: 8) {
                routeMenu

                headerActionButton(systemName: "bolt.badge.automatic", accessibilityLabel: "Add agent") {
                    showingAddAgent = true
                }

                headerActionButton(systemName: "person.badge.plus", accessibilityLabel: "Add human") {
                    showingAddHuman = true
                }

                headerActionButton(systemName: "number.square", accessibilityLabel: "Add channel") {
                    showingAddChannel = true
                }

                Spacer()

                Button {
                    showingOnlinePeers = true
                } label: {
                    Label("\(store.onlineParticipantCount)", systemImage: "person.2.fill")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .accessibilityLabel("Online peers")
            }

            if !headerCollapsed {
                HStack(spacing: 10) {
                    Label(store.senderName, systemImage: "person.crop.circle.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(peerColor(for: store.senderName, senderType: .human))

                    ConnectionStatusView(state: store.connectionState, routeLabel: store.routeLabel)

                    Spacer()

                    Link("thunderai.us", destination: ThunderCommConfig.defaultWebsiteURL)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(headerCollapsed ? 12 : 13)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color(uiColor: .secondarySystemBackground))
        )
        .gesture(
            DragGesture(minimumDistance: 14)
                .onEnded { value in
                    if value.translation.height < -18 {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            headerCollapsed = true
                        }
                    } else if value.translation.height > 18 {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            headerCollapsed = false
                        }
                    }
                }
        )
    }

    private var routeMenu: some View {
        Menu {
            // Build 55 final: no hardcoded #tnt / #jmab seed entries. The
            // user creates channels via the "+" button and direct chats
            // appear here only when they've added an agent.
            if !store.customChannels.isEmpty {
                Section("Channels") {
                    ForEach(store.customChannels, id: \.self) { channel in
                        Button("#\(channel)") {
                            store.setRoute(.channel, channelName: channel)
                        }
                    }
                }
            }
            if !store.availableDirectAgents.isEmpty {
                Section("Direct") {
                    ForEach(store.availableDirectAgents, id: \.self) { agentId in
                        Button("@\(store.displayName(forParticipantID: agentId))") {
                            store.setRoute(.direct, agentId: agentId)
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: routeIconName)
                    .font(.subheadline.weight(.semibold))
                Text(store.routeLabel)
                    .font(.subheadline.weight(.semibold))
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }

    private var routeIconName: String {
        switch store.currentRoute {
        case .tnt, .jmab, .channel:
            return "number"
        case .direct:
            return "at"
        }
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

    private func statusColor(for status: ThunderCommPresenceStatus) -> Color {
        switch status {
        case .online:
            return .green
        case .busy:
            return .orange
        case .offline:
            return .gray
        }
    }

    private func statusLabel(for status: ThunderCommPresenceStatus) -> String {
        switch status {
        case .online:
            return "Online"
        case .busy:
            return "Busy"
        case .offline:
            return "Offline"
        }
    }

    private func peerColor(for sender: String, senderType: ThunderCommSenderType?) -> Color {
        let key = ThunderCommParticipantIdentity.canonicalID(sender: sender, agentId: nil, participantId: sender, senderType: senderType)
        switch key {
        case "jon":
            return Color(red: 0.96, green: 0.82, blue: 0.24)
        case "michael":
            return Color(red: 0.73, green: 0.58, blue: 0.98)
        case "mack":
            return Color(red: 0.47, green: 0.80, blue: 1.0)
        default:
            return .green
        }
    }

    private func headerActionButton(systemName: String, accessibilityLabel: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.subheadline.weight(.bold))
                .frame(width: 22, height: 22)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .accessibilityLabel(accessibilityLabel)
    }
}

private struct AddHumanInviteView: View {
    @Environment(\.dismiss) private var dismiss

    @State private var displayName = ""
    @State private var phoneNumber = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Human") {
                    TextField("Name", text: $displayName)
                        .textInputAutocapitalization(.words)
                    TextField("Phone number", text: $phoneNumber)
                        .keyboardType(.phonePad)
                        .textContentType(.telephoneNumber)
                }

                Section {
                    Button("Save invite draft") {
                        HumanInviteDraftStore.append(
                            displayName: displayName,
                            phoneNumber: phoneNumber
                        )
                        dismiss()
                    }
                    .disabled(phoneNumber.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } footer: {
                    Text("Phone number is the first-pass human identifier, not the trust model. This saves a local draft now while full human onboarding lands alongside the BYOAA/KYA agent flow.")
                }
            }
            .navigationTitle("Add Human")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
            }
        }
    }
}

private struct AddChannelView: View {
    @Environment(\.dismiss) private var dismiss

    let connectionStore: ThunderCommStore

    @State private var channelName = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Channel") {
                    TextField("channel-name", text: $channelName)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Text("Creates a local ThunderCommo route and reconnects chat to that channel immediately.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if !connectionStore.customChannels.isEmpty {
                    Section("Existing") {
                        ForEach(connectionStore.customChannels, id: \.self) { channel in
                            Button("#\(channel)") {
                                connectionStore.setRoute(.channel, channelName: channel)
                                dismiss()
                            }
                        }
                    }
                }

                Section {
                    Button("Add channel") {
                        connectionStore.addChannel(named: channelName)
                        dismiss()
                    }
                    .disabled(normalizedChannelName.isEmpty)
                }
            }
            .navigationTitle("Add Channel")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
            }
        }
    }

    private var normalizedChannelName: String {
        channelName
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "#", with: "")
            .lowercased()
    }
}

private struct HumanInviteDraft: Codable, Identifiable {
    let id: UUID
    let displayName: String
    let phoneNumber: String
    let createdAt: Date
}

private enum HumanInviteDraftStore {
    private static let key = "thunder.humanInviteDrafts.v1"

    static func append(displayName: String, phoneNumber: String) {
        let trimmedName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedPhone = phoneNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPhone.isEmpty else { return }

        var drafts = load()
        drafts.insert(
            HumanInviteDraft(
                id: UUID(),
                displayName: trimmedName.isEmpty ? trimmedPhone : trimmedName,
                phoneNumber: trimmedPhone,
                createdAt: Date()
            ),
            at: 0
        )

        if let data = try? JSONEncoder().encode(drafts) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    private static func load() -> [HumanInviteDraft] {
        guard let data = UserDefaults.standard.data(forKey: key),
              let drafts = try? JSONDecoder().decode([HumanInviteDraft].self, from: data) else {
            return []
        }
        return drafts
    }
}
