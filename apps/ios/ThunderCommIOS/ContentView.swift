
import SwiftUI
import UserNotifications

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme
    @State private var store = ThunderCommStore()
    @State private var draft = ""
    @State private var composerResetID = UUID()
    @State private var showingOnlinePeers = false
    @State private var showingSettings = false
    @State private var showingAddAgent = false
    @State private var showingAddHuman = false
    @State private var showingAddChannel = false
    @State private var headerCollapsed = true
    @State private var showingNotificationsBanner = false

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .center) {
                Color(uiColor: .systemGroupedBackground)
                    .ignoresSafeArea()

                Image("TNTWatermark")
                    .resizable()
                    .scaledToFit()
                    .frame(width: UIScreen.main.bounds.width * 0.80)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                    .opacity(0.18)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                    .offset(y: 28)

                VStack(spacing: 10) {
                    topChrome(topInset: geometry.safeAreaInsets.top)

                    VStack(spacing: 14) {
                        Group {
                            if store.messages.isEmpty && store.streamingPreviews.isEmpty {
                                ContentUnavailableView(
                                    "No messages yet",
                                    systemImage: "bubble.left.and.bubble.right",
                                    description: Text(emptyStateLabel)
                                )
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                                .background(chatSurfaceBackground)
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
                                .background(chatSurfaceBackground)
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
                    .padding(.horizontal)
                    .padding(.bottom)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .ignoresSafeArea(.container, edges: .bottom)
            }
        }
        .task {
            store.connectIfNeeded()
            await refreshNotificationsBanner()
            await ensureNotificationAuthorization()
            APNsManager.shared.retryTokenUploadIfNeeded()
        }
        .onChange(of: draft) { _, newValue in
            store.draftDidChange(newValue)
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                store.connectIfNeeded()
                Task {
                    await refreshNotificationsBanner()
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .notificationsDeclined)) { _ in
            withAnimation(.easeInOut(duration: 0.2)) {
                showingNotificationsBanner = true
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .openChannel)) { note in
            guard let channel = note.userInfo?["channel"] as? String else { return }
            applyOpenChannel(channel)
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
            ChannelListView(connectionStore: store)
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

    @ViewBuilder
    private func topChrome(topInset: CGFloat) -> some View {
        VStack(spacing: 0) {
            if showingNotificationsBanner {
                notificationsDeclinedBanner
            }

            header
        }
        .padding(.horizontal)
        .padding(.top, max(topInset - 92, 0))
        .padding(.bottom, 0)
        .frame(maxWidth: .infinity)
        .background(topChromeBackground)
    }

    private var topChromeBackground: some View {
        UnevenRoundedRectangle(
            topLeadingRadius: 0,
            bottomLeadingRadius: 28,
            bottomTrailingRadius: 28,
            topTrailingRadius: 0,
            style: .continuous
        )
        .fill(Color(uiColor: .secondarySystemBackground))
        .ignoresSafeArea(edges: .top)
    }

    private var chatSurfaceBackground: some View {
        RoundedRectangle(cornerRadius: 24, style: .continuous)
            .fill(Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    private var notificationsDeclinedBanner: some View {
        HStack(spacing: 10) {
            Image(systemName: "bell.slash.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Notifications off")
                    .font(.subheadline.weight(.semibold))
                Text("Enable notifications to get alerts when Jon replies.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            .font(.caption.weight(.semibold))
            .buttonStyle(.bordered)
            .controlSize(.small)

            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    showingNotificationsBanner = false
                }
            } label: {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
                    .frame(width: 22, height: 22)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .accessibilityLabel("Dismiss")
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color(uiColor: .secondarySystemBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.orange.opacity(0.35), lineWidth: 1)
        )
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    private func refreshNotificationsBanner() async {
        let status = await APNsManager.shared.currentAuthorizationStatus()
        await MainActor.run {
            withAnimation(.easeInOut(duration: 0.2)) {
                showingNotificationsBanner = status == .denied
            }
        }
    }

    // First-launch-after-sign-in primer. Onboarding's notifications step
    // also requests authorization, but a user who signed into an existing
    // account on a new device skips onboarding entirely and would otherwise
    // never see the system prompt. .notDetermined ensures we only ask once
    // per install — if the user has already accepted or denied, iOS won't
    // re-prompt anyway.
    private func ensureNotificationAuthorization() async {
        let status = await APNsManager.shared.currentAuthorizationStatus()
        if status == .notDetermined {
            _ = await APNsManager.shared.requestUserAuthorization()
        }
    }

    private func applyOpenChannel(_ raw: String) {
        let normalized = raw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "#", with: "")
            .lowercased()
        guard !normalized.isEmpty else { return }

        switch normalized {
        case "tnt":
            store.setRoute(.tnt)
        case "jmab":
            store.setRoute(.jmab)
        case "direct":
            // No agentId — leave the existing direct target intact.
            store.setRoute(.direct)
        default:
            store.setRoute(.channel, channelName: normalized)
        }
    }

    private var emptyStateLabel: String {
        switch store.currentRoute {
        case .tnt:
            return "Messages for #tnt and direct chats will appear here."
        case .jmab:
            return "JMAB messages will appear here."
        case .channel:
            return "Messages for \(store.routeLabel) will appear here."
        case .direct:
            return "Direct replies share the main thread and route to \(store.routeLabel)."
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: headerCollapsed ? 2 : 6) {
            ZStack {
                headerBrandLockup

                HStack(alignment: .center, spacing: 6) {
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

                    Spacer()

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
            }

            HStack(spacing: 6) {
                routeMenu

                headerActionButton(systemName: "bolt.badge.automatic", accessibilityLabel: "Add agent") {
                    showingAddAgent = true
                }

                headerActionButton(systemName: "person.badge.plus", accessibilityLabel: "Add human") {
                    showingAddHuman = true
                }

                headerActionButton(systemName: "number.square", accessibilityLabel: "Channels") {
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
        .padding(.horizontal, 12)
        .padding(.vertical, 0)
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

    private var headerBrandLockup: some View {
        Text("ThunderCommo")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(headerTitleGradient)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
    }

    private var routeMenu: some View {
        Menu {
            Section("Channels") {
                Button("#tnt") {
                    store.setRoute(.tnt)
                }
                Button("#jmab") {
                    store.setRoute(.jmab)
                }
                ForEach(store.customChannels, id: \.self) { channel in
                    Button(channel.channelDisplayName) {
                        store.setRoute(.channel, channelName: channel)
                    }
                }
            }
            Section("Direct") {
                ForEach(store.availableDirectAgents, id: \.self) { agentId in
                    Button("@\(store.displayName(forParticipantID: agentId))") {
                        store.setRoute(.direct, agentId: agentId)
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: routeIconName)
                    .font(.subheadline.weight(.semibold))
                Text(routeMenuLabel)
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
            return "bubble.left.and.bubble.right.fill"
        case .direct:
            return "person.crop.circle"
        }
    }

    private var routeMenuLabel: String {
        switch store.currentRoute {
        case .tnt:
            return "tnt".channelDisplayName
        case .jmab:
            return "jmab".channelDisplayName
        case .channel:
            return store.selectedChannelName.channelDisplayName
        case .direct:
            return store.displayName(forParticipantID: store.directAgentId)
        }
    }

    private var headerTitleGradient: LinearGradient {
        LinearGradient(
            colors: [
                Color(red: 0.0, green: 0.80, blue: 1.0),
                Color(red: 1.0, green: 0.45, blue: 0.10),
                Color(red: 1.0, green: 0.85, blue: 0.0)
            ],
            startPoint: .leading,
            endPoint: .trailing
        )
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

private extension String {
    var channelDisplayName: String {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        let bare = trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed
        return "#\(bare)"
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
