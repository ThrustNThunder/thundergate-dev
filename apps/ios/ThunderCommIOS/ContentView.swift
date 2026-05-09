
import SwiftUI

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var store = ThunderCommStore()
    @State private var draft = ""
    @State private var showingConnectionSettings = false
    @State private var showingOnlinePeers = false
    @State private var endpointDraft = ""
    @State private var tokenDraft = ""
    @State private var senderDraft = ""

    var body: some View {
        VStack(spacing: 12) {
            header

            if store.messages.isEmpty && store.streamingPreviews.isEmpty {
                ContentUnavailableView(
                    "No messages yet",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text(emptyStateLabel)
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                MessageListView(
                    messages: store.messages,
                    localSender: store.senderName,
                    activeIndicators: store.activeIndicators,
                    streamingPreviews: store.streamingPreviews,
                    hasOlderMessages: store.hasOlderMessages,
                    loadOlderMessages: store.loadOlderMessages
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            ComposerBar(draft: $draft, placeholder: store.composePlaceholder) {
                let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { return }
                store.sendDraft(&draft)
                draft = ""
            }
        }
        .padding()
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
        .sheet(isPresented: $showingConnectionSettings) {
            NavigationStack {
                Form {
                    Section("Add Agent") {
                        TextField("Display name", text: $senderDraft)
                            .textInputAutocapitalization(.words)
                            .autocorrectionDisabled()

                        SecureField("Gateway token", text: $tokenDraft)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }

                    Section("Point at Instance") {
                        TextField("wss://relay.thunderai.us", text: $endpointDraft)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .font(.callout.monospaced())

                        Text("Current default: \(ThunderCommConfig.defaultRelayURL.absoluteString)")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        Link("Open thunderai.us", destination: ThunderCommConfig.defaultWebsiteURL)
                            .font(.callout)
                    }

                    if store.isUsingCustomEndpoint {
                        Section {
                            Button("Reset endpoint to default") {
                                store.resetEndpoint()
                                endpointDraft = store.endpointText
                            }
                            .foregroundStyle(.red)
                        }
                    }
                }
                .navigationTitle("ThunderCommo Setup")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            showingConnectionSettings = false
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            store.updateConnectionSettings(endpoint: endpointDraft, token: tokenDraft, senderName: senderDraft)
                            showingConnectionSettings = false
                        }
                    }
                }
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
        switch store.currentRoute {
        case .tnt:
            return "Messages for #tnt and direct chats will appear here."
        case .jmab:
            return "JMAB messages will appear here."
        case .direct:
            return "Direct replies share the main thread and route to \(store.routeLabel)."
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("ThunderCommo")
                        .font(.title2.bold())
                    Text(store.routeLabel)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()

                routeMenu

                Button {
                    showingOnlinePeers = true
                } label: {
                    Label("\(store.onlineParticipantCount)", systemImage: "person.3.fill")
                        .font(.headline)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.bordered)

                Button {
                    endpointDraft = store.endpointText
                    tokenDraft = store.token
                    senderDraft = store.senderName
                    showingConnectionSettings = true
                } label: {
                    Image(systemName: "plus.circle")
                        .font(.headline)
                        .padding(8)
                }
                .buttonStyle(.plain)

                ConnectionStatusView(state: store.connectionState)
            }

            HStack(spacing: 12) {
                Label(store.senderName, systemImage: "person.crop.circle")
                    .font(.caption)
                    .foregroundStyle(peerColor(for: store.senderName, senderType: .human))

                Link("thunderai.us", destination: ThunderCommConfig.defaultWebsiteURL)
                    .font(.caption)

                Text("SwiftUI route follows web UI rules")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var routeMenu: some View {
        Menu {
            Button("#tnt") {
                store.setRoute(.tnt)
            }
            Button("#jmab") {
                store.setRoute(.jmab)
            }
            Divider()
            ForEach(store.availableDirectAgents, id: \.self) { agentId in
                Button("direct: \(store.displayName(forParticipantID: agentId))") {
                    store.setRoute(.direct, agentId: agentId)
                }
            }
        } label: {
            Label(store.routeLabel, systemImage: "line.3.horizontal.decrease.circle")
                .font(.headline)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
        }
        .buttonStyle(.bordered)
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
}
