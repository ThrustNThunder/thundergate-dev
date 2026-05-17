
    import Foundation
import SQLite3
import Observation
import Combine

    @Observable
    final class ThunderCommStore {
        private static let endpointDefaultsKey = "ThunderComm.endpointOverride"
        private static let tokenDefaultsKey = "ThunderComm.tokenOverride"
        private static let senderDefaultsKey = "ThunderComm.senderOverride"
        private static let routeDefaultsKey = "ThunderComm.route"
        private static let directAgentDefaultsKey = "ThunderComm.directAgent"
        private static let selectedChannelDefaultsKey = "ThunderComm.selectedChannel"
        private static let customChannelsDefaultsKey = "ThunderComm.customChannels"
        private static let channelsDefaultsKey = "ThunderComm.channels"
        private static let userAccountDefaultsKey = "thunder.user.account.v1"
        private static let initialVisibleMessageCount = 100
        private static let historyPageSize = 100
        private static let maxPersistedMessages = 300
        private static let activityExpiryMs: Int64 = 60_000
        private static let sendTimeoutSeconds: TimeInterval = 60

        var connectionState: ThunderCommConnectionState = .disconnected
        var messages: [ThunderCommMessage] = []
        var peers: [String] = []
        var endpointText: String = ThunderCommStore.loadEndpoint()
        var token: String = ThunderCommStore.loadToken()
        var senderName: String = ThunderCommStore.loadSenderName()
        var currentRoute: ThunderCommRoute = ThunderCommStore.loadRoute()
        var directAgentId: String = ThunderCommStore.loadDirectAgentId()
        var selectedChannelName: String = ThunderCommStore.loadSelectedChannel()
        var customChannels: [String] = ThunderCommStore.loadCustomChannels()
        var channels: [ThunderChannel] = ThunderCommStore.loadChannels()
        let peerId: String = ThunderCommIdentity.loadOrCreatePeerId(forUserKey: ThunderCommStore.signedInUserKey())

        var activeIndicators: [ThunderCommActivityIndicator] = []
        var streamingPreviews: [ThunderCommStreamingPreview] = []
        var hasOlderMessages: Bool = false
        var deliveryStateByMessageID: [String: ThunderCommDeliveryState] = [:]

        // Build 55 final: no hardcoded direct-chat agent roster. Populated by
        // the relay's roster frames once the user has added at least one
        // agent.
        let availableDirectAgents: [String] = []

        private var messageIDs = Set<String>()
        private var allMessages: [ThunderCommMessage] = []
        private var activityByParticipantID: [String: ThunderCommActivityIndicator] = [:]
        private var streamByParticipantID: [String: ThunderCommStreamingPreview] = [:]
        private var rosterByParticipantID: [String: ThunderCommParticipant] = [:]
        private var rosterOrder: [String] = []
        // Build 55 final: no hardcoded participant ID seeds. Populated as the
        // relay reports roster entries and as messages arrive.
        private var knownParticipantIDs = Set<String>()
        private let client = ThunderCommWebSocketClient()
        private let delivery = DeliveryStateCore()
        private let persistence = ThunderCommSQLiteStore()
        private let autoSendText = ProcessInfo.processInfo.environment["THUNDERCOMM_AUTOSEND_TEXT"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        private let autoSendDelaySeconds = Double(ProcessInfo.processInfo.environment["THUNDERCOMM_AUTOSEND_DELAY_SECONDS"] ?? "0") ?? 0
        private var didAutoSend = false
        private var activityPruneTimer: Timer?
        private var localTypingStopWorkItem: DispatchWorkItem?
        private var isSendingLocalTyping = false
        private var deliveryWatchdogs: [String: DispatchWorkItem] = [:]
        private var pendingMessages: [String: ThunderCommMessage] = [:]
        private var lastDispatchChannelByAgent: [String: String] = [:]
        private var cancellables = Set<AnyCancellable>()

        private func debug(_ message: String) {
            print("[ThunderCommStore] \(message)")
        }

        init() {
            if currentRoute == .channel {
                if selectedChannelName.isEmpty {
                    selectedChannelName = customChannels.first ?? "ops"
                }
                if !selectedChannelName.isEmpty, !customChannels.contains(selectedChannelName) {
                    customChannels.insert(selectedChannelName, at: 0)
                }
            }

            seedDefaultChannelsIfNeeded()

            loadPersistedMessages()
            refreshVisibleMessages()
            startActivityPruneTimer()

            client.onStateChange = { [weak self] state in
                DispatchQueue.main.async {
                    self?.connectionState = state
                    switch state {
                    case .connecting:
                        // BUILD_54_P7_BRIEF: on every reconnect, drop the
                        // local roster so stale entries from the prior
                        // session never bleed into the fresh view. The
                        // relay re-sends a full roster frame as part of
                        // the auth handshake, which repopulates state.
                        self?.rosterByParticipantID.removeAll()
                        self?.rosterOrder.removeAll()
                    case .connected:
                        self?.requestRecentHistoryIfAvailable()
                        self?.resendFailedMessagesIfNeeded()
                        self?.sendAutoProbeIfNeeded()
                    case .disconnected, .authenticating, .reconnecting, .failed:
                        break
                    }
                }
            }

            client.onEvent = { [weak self] event in
                DispatchQueue.main.async {
                    self?.handle(event)
                }
            }

            client.onMessageSent = { [weak self] messageID in
                DispatchQueue.main.async {
                    self?.markMessageSent(messageID)
                }
            }

            client.onMessageFailed = { [weak self] messageID, _ in
                DispatchQueue.main.async {
                    self?.markMessageFailed(messageID)
                }
            }

            client.onResolveAfterTimestamp = { [weak self] channel in
                self?.lastMessageTimestamp(for: channel) ?? 0
            }

            DeliveryCore.shared.$inbound
                .receive(on: DispatchQueue.main)
                .sink { [weak self] newInbound in
                    self?.handleInboundUpdate(newInbound)
                }
                .store(in: &cancellables)
        }

        deinit {
            activityPruneTimer?.invalidate()
        }

        var routeLabel: String {
            // Build 55 final: the internal `.tnt` / `.jmab` route IDs survive
            // as routing identifiers — too much downstream code depends on
            // them — but the user-facing labels do not. A user on the
            // default route just sees "Messages"; named channels and direct
            // chats keep their explicit labels because the user picked them.
            switch currentRoute {
            case .tnt, .jmab:
                return "Messages"
            case .channel:
                let channel = selectedChannelName.trimmingCharacters(in: .whitespacesAndNewlines)
                return channel.isEmpty ? "Messages" : "#\(channel)"
            case .direct:
                return "direct: \(ThunderCommParticipantIdentity.displayName(sender: nil, agentId: directAgentId, participantId: directAgentId, senderType: .agent))"
            }
        }

        var composePlaceholder: String {
            "Message \(routeLabel)"
        }

        var onlineParticipantCount: Int {
            orderedPeerIDs().filter { statusForParticipantID($0) != .offline }.count
        }

        func connectIfNeeded() {
            switch connectionState {
            case .connecting, .authenticating, .connected:
                return
            case .reconnecting, .disconnected, .failed:
                connect()
            }
        }

        /// Force a fresh roster from the relay. The local roster is cleared
        /// automatically on the `.connecting` transition, so a reconnect is
        /// the canonical refresh path. Called from the scene-phase observer
        /// on a genuine background→foreground transition; see ContentView.
        func refreshRoster() {
            switch connectionState {
            case .connected, .authenticating:
                disconnect()
                connect()
            case .connecting, .reconnecting:
                // A connect cycle is already in flight; let it finish and
                // deliver the fresh roster.
                return
            case .disconnected, .failed:
                connect()
            }
        }

        func connect() {
            guard let endpoint = URL(string: endpointText) else {
                connectionState = .failed("Bad relay URL")
                return
            }
            client.connect(endpoint: endpoint, token: token, peerId: peerId, channels: subscribedChannels)
        }

        func disconnect() {
            clearLocalTypingIndicator(sendEvent: true)
            client.disconnect()
        }

        func setRoute(_ route: ThunderCommRoute, agentId: String? = nil, channelName: String? = nil) {
            let previousSubscribedChannels = Set(subscribedChannels)

            if let agentId, !agentId.isEmpty {
                directAgentId = agentId
            }

            if route == .channel,
               let normalizedChannel = normalizeCustomChannel(channelName ?? selectedChannelName) {
                selectedChannelName = normalizedChannel
                if !customChannels.contains(normalizedChannel) {
                    customChannels.append(normalizedChannel)
                    customChannels.sort()
                }
            }

            currentRoute = route
            persistRoute()
            refreshVisibleMessages()
            refreshIndicators()
            refreshStreamingPreviews()

            if case .connected = connectionState {
                if Set(subscribedChannels) != previousSubscribedChannels {
                    reconnectForSettingsChange()
                } else {
                    requestRecentHistoryIfAvailable()
                }
            }
        }

        func addChannel(named name: String) {
            guard let normalizedChannel = normalizeCustomChannel(name) else { return }
            setRoute(.channel, channelName: normalizedChannel)
        }

        // MARK: - Channels (P5c)
        //
        // Member-scoped channel list parallel to the existing route system.
        // tnt + jmab are seeded as default channels (visible to everyone).
        // Created channels are mirrored into customChannels so the existing
        // .channel route handles wire-level subscription unchanged.

        /// Channels the local user should see in the Channels list. tnt and
        /// jmab are isDefault → always visible. Custom channels show only
        /// when the local peerId is in the members list.
        var visibleChannels: [ThunderChannel] {
            channels.filter { $0.isDefault || $0.members.contains(peerId) }
        }

        /// Creates a channel locally and broadcasts a channel_created frame so
        /// other members can mirror it. v1 privacy is presentation-layer only —
        /// the wire frame is broadcast to all peers and clients self-filter.
        func createChannel(name: String, members: [String]) {
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: "#", with: "")
                .lowercased()
            guard !trimmed.isEmpty else { return }
            guard trimmed != "tnt", trimmed != "jmab", trimmed != "direct",
                  !trimmed.hasPrefix("direct:") else { return }
            guard !channels.contains(where: { $0.id == trimmed }) else { return }

            var memberSet = Set(members)
            memberSet.insert(peerId) // creator is always a member
            let channel = ThunderChannel(
                id: trimmed,
                name: trimmed,
                members: Array(memberSet).sorted(),
                isDefault: false
            )
            channels.append(channel)
            persistChannels()

            // Mirror into the existing customChannels list so .channel route
            // wiring (subscription, route menu, filtering) works unchanged.
            if !customChannels.contains(trimmed) {
                customChannels.append(trimmed)
                customChannels.sort()
                UserDefaults.standard.set(customChannels, forKey: Self.customChannelsDefaultsKey)
            }

            client.sendChannelCreated(channel: channel, by: peerId)
        }

        private func seedDefaultChannelsIfNeeded() {
            // Build 55 final: no hardcoded tnt / jmab seeds. The chat ships
            // with zero channels; user-created channels are backfilled from
            // the customChannels list (UserDefaults-backed) so the Channels UI
            // shows what the user already has.
            var changed = false
            for custom in customChannels where !channels.contains(where: { $0.id == custom }) {
                channels.append(
                    ThunderChannel(id: custom, name: custom, members: [peerId], isDefault: false)
                )
                changed = true
            }
            if changed { persistChannels() }
        }

        private func handleChannelCreated(_ payload: ChannelCreatedPayload) {
            let trimmedId = payload.channelId
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            guard !trimmedId.isEmpty else { return }
            // Presentation-layer privacy — only adopt channels we're a member of.
            guard payload.members.contains(peerId) else { return }
            guard !channels.contains(where: { $0.id == trimmedId }) else { return }

            let displayName = payload.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? trimmedId
                : payload.name
            let channel = ThunderChannel(
                id: trimmedId,
                name: displayName,
                members: payload.members,
                isDefault: false
            )
            channels.append(channel)
            persistChannels()

            if !customChannels.contains(trimmedId) {
                customChannels.append(trimmedId)
                customChannels.sort()
                UserDefaults.standard.set(customChannels, forKey: Self.customChannelsDefaultsKey)
            }
        }

        private func persistChannels() {
            if let data = try? JSONEncoder().encode(channels) {
                UserDefaults.standard.set(data, forKey: Self.channelsDefaultsKey)
            }
        }

        private static func loadChannels() -> [ThunderChannel] {
            guard let data = UserDefaults.standard.data(forKey: channelsDefaultsKey),
                  let channels = try? JSONDecoder().decode([ThunderChannel].self, from: data) else {
                return []
            }
            return channels
        }

        /// Adopt a new account-level display name as the wire-level sender so
        /// the change shows up on outgoing messages without waiting for the
        /// next cold launch. No-op when an explicit Connection-section
        /// override exists — that override is a deliberate chat-only choice.
        func applyProfileDisplayName(_ name: String) {
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            let stored = UserDefaults.standard.string(forKey: Self.senderDefaultsKey)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard stored.isEmpty else { return }
            if senderName != trimmed {
                senderName = trimmed
            }
        }

        func updateConnectionSettings(endpoint: String, token: String, senderName: String) {
            let trimmedEndpoint = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedSender = senderName.trimmingCharacters(in: .whitespacesAndNewlines)

            self.endpointText = trimmedEndpoint.isEmpty ? ThunderCommConfig.defaultRelayURL.absoluteString : trimmedEndpoint
            // Build 55 final: no hardcoded fallback token. Empty stays empty —
            // the connection layer will refuse to authenticate until the user
            // supplies a real token (via AccountStore on signup).
            self.token = trimmedToken
            self.senderName = trimmedSender.isEmpty ? ThunderCommConfig.defaultSender : trimmedSender

            UserDefaults.standard.set(self.endpointText, forKey: Self.endpointDefaultsKey)
            UserDefaults.standard.set(self.token, forKey: Self.tokenDefaultsKey)
            UserDefaults.standard.set(self.senderName, forKey: Self.senderDefaultsKey)
            reconnectForSettingsChange()
        }

        func resetEndpoint() {
            endpointText = ThunderCommConfig.defaultRelayURL.absoluteString
            UserDefaults.standard.removeObject(forKey: Self.endpointDefaultsKey)
            reconnectForSettingsChange()
        }

        var isUsingCustomEndpoint: Bool {
            endpointText != ThunderCommConfig.defaultRelayURL.absoluteString
        }

        func sendDraft(_ draft: inout String) {
            let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }

            let inferredAgentId = inferDirectAgentIDIfNeeded(for: trimmed)
            let targetAgentId = outboundAgentId ?? inferredAgentId
            let visibleChannel = activeThreadChannel(targetAgentId: targetAgentId)

            let message = ThunderCommMessage(
                id: UUID().uuidString,
                channel: visibleChannel,
                sender: ThunderCommParticipantIdentity.displayName(sender: senderName, agentId: nil, participantId: nil, senderType: .human),
                senderType: .human,
                agentId: targetAgentId,
                text: trimmed,
                timestamp: Self.nowMs,
                originPeer: peerId,
                relayedAt: nil,
                relayedBy: nil,
                contentKind: .text,
                attachment: nil
            )
            let wireMessage = ThunderCommMessage(
                id: message.id,
                channel: outboundChannel,
                sender: message.sender,
                senderType: message.senderType,
                agentId: message.agentId,
                text: message.text,
                timestamp: message.timestamp,
                originPeer: message.originPeer,
                relayedAt: message.relayedAt,
                relayedBy: message.relayedBy,
                contentKind: message.contentKind,
                attachment: message.attachment
            )
            deliveryStateByMessageID[message.id] = .sending
            pendingMessages[message.id] = wireMessage
            Task { await delivery.arm(messageId: message.id) }
            append(message)
            if let trackingAgentID = targetAgentId ?? explicitMentionedAgentID(in: trimmed) {
                lastDispatchChannelByAgent[trackingAgentID] = visibleChannel
            }
            client.send(message: wireMessage)
            armDeliveryWatchdog(messageID: message.id)
            clearLocalTypingIndicator(sendEvent: true)
            draft = ""
        }

        func retrySend(messageID: String) {
            guard let message = pendingMessages[messageID] ?? messageCacheLookup(id: messageID) else { return }
            deliveryStateByMessageID[messageID] = .sending
            pendingMessages[messageID] = message
            Task { await delivery.arm(messageId: messageID) }
            client.send(message: message)
            armDeliveryWatchdog(messageID: messageID)
        }

        private func messageCacheLookup(id: String) -> ThunderCommMessage? {
            allMessages.first { $0.id == id }
        }

        func draftDidChange(_ draft: String) {
            let hasText = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            if hasText {
                if !isSendingLocalTyping {
                    client.sendTyping(participantId: localParticipantID, senderType: .human, typing: true, channel: outboundChannel)
                    isSendingLocalTyping = true
                }
                scheduleLocalTypingStop()
            } else {
                clearLocalTypingIndicator(sendEvent: true)
            }
        }

        func deleteMessage(_ message: ThunderCommMessage) {
            allMessages.removeAll { $0.id == message.id }
            messageIDs.remove(message.id)
            deliveryStateByMessageID.removeValue(forKey: message.id)
            pendingMessages.removeValue(forKey: message.id)
            cancelDeliveryWatchdog(messageID: message.id)
            Task { await delivery.clear(messageId: message.id) }
            persistMessages()
            refreshVisibleMessages()
        }

        func deliveryState(for message: ThunderCommMessage) -> ThunderCommDeliveryState? {
            guard message.senderType == .human else { return nil }
            let participantID = ThunderCommParticipantIdentity.canonicalID(
                sender: message.sender,
                agentId: message.agentId,
                participantId: message.originPeer,
                senderType: message.senderType
            )
            guard participantID == localParticipantID else { return nil }
            return deliveryStateByMessageID[message.id]
        }

        func loadOlderMessages() {
            guard hasOlderMessages else { return }
            let filteredAll = filteredMessages(from: allMessages)
            let newCount = min(filteredAll.count, messages.count + Self.historyPageSize)
            messages = Array(filteredAll.suffix(newCount))
            hasOlderMessages = messages.count < filteredAll.count
        }

        func peerDisplayName(for peer: String) -> String {
            ThunderCommParticipantIdentity.displayName(
                sender: nil,
                agentId: nil,
                participantId: peer,
                senderType: peer.hasPrefix("ios-") ? .human : nil
            )
        }

        func peerColorKey(for peer: String) -> String {
            ThunderCommParticipantIdentity.canonicalID(sender: nil, agentId: nil, participantId: peer, senderType: peer.hasPrefix("ios-") ? .human : nil)
        }

        private func handle(_ event: ThunderCommInboundEvent) {
            switch event {
            case .status(let payload):
                if let peers = payload.peers {
                    self.peers = peers.sorted()
                }
            case .peers(let payload):
                peers = payload.peers.sorted()
                debug("peer roster: \(payload.peers.joined(separator: ", "))")
            case .roster(let payload):
                var nextRoster: [String: ThunderCommParticipant] = [:]
                var nextOrder: [String] = []
                for agent in payload.agents {
                    let participantID = normalizedRosterParticipantID(agent.id)
                    guard participantID != "burt" else { continue }
                    nextRoster[participantID] = agent
                    nextOrder.append(participantID)
                    knownParticipantIDs.insert(participantID)
                }
                rosterByParticipantID = nextRoster
                rosterOrder = nextOrder
                debug("bridge roster: \(payload.agents.map(\.name).joined(separator: ", "))")
            case .history(let payload):
                debug("history payload: \(payload.messages.count) message(s)")
                merge(payload.messages)
            case .message(let message):
                debug("inbound message from \(message.sender): \(message.text)")
                append(message)
            case .typing(let payload):
                handleTyping(payload)
            case .thinking(let payload):
                handleThinking(payload)
            case .stream(let payload):
                handleStream(payload)
            case .ack(let payload):
                handleAck(payload)
            case .systemEvent(let payload):
                handleSystemEvent(payload)
            case .error(let payload):
                handleError(payload)
            case .channelCreated(let payload):
                handleChannelCreated(payload)
            case .unknown(let text):
                debug("event: \(text)")
            }
        }

        private func handleTyping(_ payload: ThunderCommTypingPayload) {
            let eventChannel = normalizedEventChannel(payload.channel)
            guard routeShows(channel: eventChannel) else { return }

            let senderType = ThunderCommParticipantIdentity.senderType(
                sender: nil,
                agentId: payload.agentId,
                participantId: payload.participantId,
                explicitRawValue: payload.senderType
            )
            let participantID = ThunderCommParticipantIdentity.canonicalID(
                sender: nil,
                agentId: payload.agentId,
                participantId: payload.participantId,
                senderType: senderType
            )
            let displayName = ThunderCommParticipantIdentity.displayName(
                sender: nil,
                agentId: payload.agentId,
                participantId: payload.participantId,
                senderType: senderType
            )

            setActivity(participantID: participantID, displayName: displayName, senderType: senderType, channel: eventChannel, isActive: payload.typing, timestamp: payload.timestamp)
        }

        private func handleThinking(_ payload: ThunderCommThinkingPayload) {
            let eventChannel = thinkingChannel(for: payload.agentId, explicitChannel: payload.channel)
            guard routeShows(channel: eventChannel) else { return }

            let senderType: ThunderCommSenderType = .agent
            let participantID = ThunderCommParticipantIdentity.canonicalID(
                sender: nil,
                agentId: payload.agentId,
                participantId: payload.participantId,
                senderType: senderType
            )
            let displayName = ThunderCommParticipantIdentity.displayName(
                sender: nil,
                agentId: payload.agentId,
                participantId: payload.participantId,
                senderType: senderType
            )

            if !participantID.isEmpty {
                lastDispatchChannelByAgent[participantID] = eventChannel
            }
            setActivity(participantID: participantID, displayName: displayName, senderType: senderType, channel: eventChannel, isActive: true, timestamp: payload.timestamp)
        }

        private func handleStream(_ payload: ThunderCommStreamPayload) {
            let eventChannel = normalizedEventChannel(payload.channel)
            guard routeShows(channel: eventChannel) else { return }

            let senderType: ThunderCommSenderType = .agent
            let participantID = ThunderCommParticipantIdentity.canonicalID(
                sender: nil,
                agentId: payload.agentId,
                participantId: payload.participantId,
                senderType: senderType
            )
            let displayName = ThunderCommParticipantIdentity.displayName(
                sender: nil,
                agentId: payload.agentId,
                participantId: payload.participantId,
                senderType: senderType
            )
            let prior = streamByParticipantID[participantID]?.text ?? ""
            streamByParticipantID[participantID] = ThunderCommStreamingPreview(
                id: participantID,
                displayName: displayName,
                senderType: senderType,
                channel: eventChannel,
                text: prior + payload.delta,
                updatedAt: payload.timestamp ?? Self.nowMs
            )
            refreshStreamingPreviews()
            setActivity(participantID: participantID, displayName: displayName, senderType: senderType, channel: eventChannel, isActive: true, timestamp: payload.timestamp)
        }

        private func handleAck(_ payload: ThunderCommAckPayload) {
            let messageID = [payload.idempotencyKey, payload.messageId]
                .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .first { !$0.isEmpty }
            if let messageID {
                deliveryStateByMessageID[messageID] = .sent
                cancelDeliveryWatchdog(messageID: messageID)
                pendingMessages.removeValue(forKey: messageID)
                Task { await delivery.markSent(messageId: messageID) }
            }
        }

        private func markMessageSent(_ messageID: String) {
            guard deliveryStateByMessageID[messageID] == .sending else { return }
            deliveryStateByMessageID[messageID] = .sent
            cancelDeliveryWatchdog(messageID: messageID)
            Task { await delivery.markSent(messageId: messageID) }
        }

        private func markMessageFailed(_ messageID: String) {
            guard deliveryStateByMessageID[messageID] != .delivered else { return }
            deliveryStateByMessageID[messageID] = .failed
            cancelDeliveryWatchdog(messageID: messageID)
            Task { await delivery.markFailed(messageId: messageID) }
        }

        private func armDeliveryWatchdog(messageID: String) {
            cancelDeliveryWatchdog(messageID: messageID)
            let work = DispatchWorkItem { [weak self] in
                guard let self else { return }
                Task { [weak self] in
                    guard let self else { return }
                    let current = await self.delivery.state(for: messageID)
                    guard current == .sending else {
                        await MainActor.run {
                            self.deliveryWatchdogs.removeValue(forKey: messageID)
                        }
                        return
                    }
                    await self.delivery.markFailed(messageId: messageID)
                    await MainActor.run {
                        if self.deliveryStateByMessageID[messageID] != .delivered {
                            self.deliveryStateByMessageID[messageID] = .failed
                        }
                        self.deliveryWatchdogs.removeValue(forKey: messageID)
                    }
                }
            }
            deliveryWatchdogs[messageID] = work
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.sendTimeoutSeconds, execute: work)
        }

        private func cancelDeliveryWatchdog(messageID: String) {
            deliveryWatchdogs[messageID]?.cancel()
            deliveryWatchdogs.removeValue(forKey: messageID)
        }

        private func handleSystemEvent(_ payload: ThunderCommSystemEventPayload) {
            let channel = normalizedEventChannel(payload.channel)
            let message = ThunderCommMessage(
                id: "system-\(UUID().uuidString)",
                channel: channel,
                sender: "System",
                senderType: .agent,
                agentId: "system",
                text: payload.text,
                timestamp: payload.timestamp ?? Self.nowMs,
                originPeer: nil,
                relayedAt: nil,
                relayedBy: nil,
                contentKind: .text,
                attachment: nil
            )
            append(message)
        }

        private func handleError(_ payload: ThunderCommErrorPayload) {
            let message = ThunderCommMessage(
                id: "error-\(UUID().uuidString)",
                channel: subscriptionChannel,
                sender: "System",
                senderType: .agent,
                agentId: "system",
                text: payload.code.map { "\($0): \(payload.message)" } ?? payload.message,
                timestamp: Self.nowMs,
                originPeer: nil,
                relayedAt: nil,
                relayedBy: nil,
                contentKind: .text,
                attachment: nil
            )
            append(message)
            if payload.code == "AUTH_FAILED" {
                connectionState = .failed(payload.message)
            }
        }

        private func setActivity(participantID: String, displayName: String, senderType: ThunderCommSenderType, channel: String, isActive: Bool, timestamp: Int64?) {
            guard !participantID.isEmpty else { return }
            knownParticipantIDs.insert(participantID)

            if isActive {
                activityByParticipantID[participantID] = ThunderCommActivityIndicator(
                    id: participantID,
                    displayName: displayName,
                    senderType: senderType,
                    channel: channel,
                    updatedAt: timestamp ?? Self.nowMs
                )
            } else {
                activityByParticipantID.removeValue(forKey: participantID)
            }

            refreshIndicators()
        }

        private func sendAutoProbeIfNeeded() {
            guard !didAutoSend, let autoSendText, !autoSendText.isEmpty else { return }
            didAutoSend = true

            let sendBlock = { [weak self] in
                guard let self else { return }
                var draft = autoSendText
                self.debug("auto-sending probe: \(autoSendText)")
                self.sendDraft(&draft)
            }

            if autoSendDelaySeconds > 0 {
                debug("auto-send scheduled in \(autoSendDelaySeconds)s")
                DispatchQueue.main.asyncAfter(deadline: .now() + autoSendDelaySeconds, execute: sendBlock)
            } else {
                sendBlock()
            }
        }

        private func append(_ message: ThunderCommMessage) {
            merge([message])
            clearActivity(for: message)
            autoRouteIfDirect(message)
        }

        // When a live `direct:<agent>` message arrives and the user isn't
        // already parked in that DM thread, flip the route so the reply
        // is visible immediately. Without this, Michael sends a DM from
        // #tnt and the reply silently drops into allMessages while he
        // keeps staring at the channel he was on. Only fires for the
        // single-message event path — bulk history replay does NOT call
        // append(), so old DMs in the replay won't yank the UI around.
        private func autoRouteIfDirect(_ message: ThunderCommMessage) {
            let channel = normalizeChannel(message.channel)
            guard channel.hasPrefix("direct:") else { return }
            let agentId = String(channel.dropFirst("direct:".count))
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            guard !agentId.isEmpty, agentId != localParticipantID else { return }
            // Skip messages we sent ourselves — we don't want sending a
            // DM from elsewhere to also yank the route, because the
            // composer flow already handles that explicitly when needed.
            let senderID = ThunderCommParticipantIdentity.canonicalID(
                sender: message.sender,
                agentId: message.agentId,
                participantId: message.originPeer,
                senderType: message.senderType
            )
            guard senderID != localParticipantID else { return }
            // Already in this DM thread? Nothing to do.
            guard currentRoute != .direct || directAgentId != agentId else { return }
            setRoute(.direct, agentId: agentId)
        }

        func orderedPeerIDs() -> [String] {
            let rosterIDs = rosterOrder.filter { rosterByParticipantID[$0] != nil }
            let activePeerIDs = Set(peers.map { peerColorKey(for: $0) })
            let messagePeerIDs = Set(allMessages.map {
                ThunderCommParticipantIdentity.canonicalID(
                    sender: $0.sender,
                    agentId: $0.agentId,
                    participantId: $0.originPeer,
                    senderType: $0.senderType
                )
            })
            let fallbackIDs = knownParticipantIDs.union(activePeerIDs).union(messagePeerIDs)
            let filteredFallback = fallbackIDs
                .filter { !Self.placeholderParticipantIDs.contains($0) }
                .sorted()
            let extras = filteredFallback.filter { !rosterIDs.contains($0) }
            return rosterIDs + extras
        }

        func displayName(forParticipantID participantID: String) -> String {
            let rosterName = rosterByParticipantID[participantID]?.name.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !rosterName.isEmpty {
                return rosterName
            }
            return ThunderCommParticipantIdentity.displayName(sender: nil, agentId: participantID, participantId: participantID, senderType: senderType(forParticipantID: participantID))
        }

        /// Returns the raw `role` string the relay attached to this peer in
        /// its most recent roster frame, if any. Surfaced for the roster
        /// sectioning helper in ContentView, which weighs explicit role
        /// after token-prefix but before canonical name fallback.
        func rosterRole(forParticipantID participantID: String) -> String? {
            rosterByParticipantID[participantID]?.role
        }

        func roleLabel(forParticipantID participantID: String) -> String {
            senderType(forParticipantID: participantID) == .agent ? "agent" : "human"
        }

        func modelForParticipantID(_ participantID: String) -> String? {
            guard senderType(forParticipantID: participantID) == .agent else { return nil }
            let trimmed = rosterByParticipantID[participantID]?.model?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? nil : trimmed
        }

        func senderType(forParticipantID participantID: String) -> ThunderCommSenderType {
            let rosterRole = rosterByParticipantID[participantID]?.role?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            if rosterRole == "agent" {
                return .agent
            }
            if rosterRole == "human" {
                return .human
            }
            return ThunderCommParticipantIdentity.senderType(sender: nil, agentId: participantID, participantId: participantID, explicitRawValue: nil)
        }

        func statusForParticipantID(_ participantID: String) -> ThunderCommPresenceStatus {
            if activityByParticipantID[participantID] != nil {
                return .busy
            }
            let rosterStatus = rosterByParticipantID[participantID]?.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
            if !rosterStatus.isEmpty {
                switch rosterStatus {
                case "online":
                    return .online
                case "busy", "thinking", "typing":
                    return .busy
                default:
                    return .offline
                }
            }
            let activePeerIDs = Set(peers.map { peerColorKey(for: $0) })
            if activePeerIDs.contains(participantID) || participantID == localParticipantID {
                return .online
            }
            return .offline
        }

        private func normalizedRosterParticipantID(_ participantID: String) -> String {
            let canonical = ThunderCommParticipantIdentity.canonicalID(
                sender: nil,
                agentId: participantID,
                participantId: participantID,
                senderType: nil
            )
            let raw = participantID.trimmingCharacters(in: .whitespacesAndNewlines)
            if Self.placeholderParticipantIDs.contains(canonical), !raw.isEmpty {
                return raw.lowercased()
            }
            return canonical
        }

        // Drains DeliveryCore.inbound into the store. Brief BUILD_54_P1 wires
    // silent-push → DeliveryCore.drainInbox → DeliveryCore.inbound → here.
    // Dedup is by id against messageIDs (the store's authoritative id set
    // tracking allMessages, not the filtered `messages` view). merge(_:)
    // handles normalize, sort, cap, persistence, and visible-refresh.
    private func handleInboundUpdate(_ inbound: [InboxMessage]) {
        let newMessages = inbound
            .filter { !messageIDs.contains($0.id) }
            .map { ThunderCommMessage(from: $0) }
        guard !newMessages.isEmpty else { return }
        merge(newMessages)
    }

    private func merge(_ incomingMessages: [ThunderCommMessage]) {
            guard !incomingMessages.isEmpty else { return }

            var didChange = false
            for incoming in incomingMessages {
                let normalized = normalize(incoming)
                guard !normalized.text.isEmpty else { continue }
                knownParticipantIDs.insert(
                    ThunderCommParticipantIdentity.canonicalID(
                        sender: normalized.sender,
                        agentId: normalized.agentId,
                        participantId: normalized.originPeer,
                        senderType: normalized.senderType
                    )
                )
                if messageIDs.contains(normalized.id) { continue }
                messageIDs.insert(normalized.id)
                allMessages.append(normalized)
                didChange = true
            }

            guard didChange else { return }

            allMessages.sort { lhs, rhs in
                if lhs.timestamp == rhs.timestamp {
                    return lhs.id < rhs.id
                }
                return lhs.timestamp < rhs.timestamp
            }

            if allMessages.count > Self.maxPersistedMessages {
                let trimmed = Array(allMessages.suffix(Self.maxPersistedMessages))
                allMessages = trimmed
                messageIDs = Set(trimmed.map(\.id))
            }

            refreshVisibleMessages()
            persistMessages()
            persistLastSeenTimestamps()
        }

        // Returns the highest timestamp the store has observed for `channel`.
        // Used as `afterTimestamp` on (re)subscribe so the relay only ships
        // messages newer than what we already have, preventing the burst
        // replay seen in Build 28 when reconnecting after a brief drop.
        // Falls back to the persisted UserDefaults snapshot if memory is
        // empty (e.g. SQLite was trimmed but UserDefaults survived).
        func lastMessageTimestamp(for channel: String) -> Int64 {
            let target = normalizeChannel(channel)
            let inMemory = allMessages
                .filter { normalizeChannel($0.channel) == target }
                .map { $0.timestamp }
                .max() ?? 0
            let persisted = Int64(UserDefaults.standard.integer(forKey: lastSeenDefaultsKey(for: target)))
            return max(inMemory, persisted)
        }

        private func lastSeenDefaultsKey(for channel: String) -> String {
            "thunder.lastTs.\(normalizeChannel(channel))"
        }

        private func persistLastSeenTimestamps() {
            // Snapshot the channels we actively subscribe to. Other channels
            // are still queryable via lastMessageTimestamp(for:) at runtime.
            var channels: Set<String> = [
                normalizeChannel("tnt"),
                normalizeChannel("jmab"),
                normalizeChannel("direct")
            ]
            for channel in customChannels {
                channels.insert(normalizeChannel(channel))
            }

            for channel in channels {
                let ts = lastMessageTimestamp(for: channel)
                if ts > 0 {
                    UserDefaults.standard.set(Int(ts), forKey: lastSeenDefaultsKey(for: channel))
                }
            }
        }

        private func normalize(_ message: ThunderCommMessage) -> ThunderCommMessage {
            let senderType = ThunderCommParticipantIdentity.senderType(
                sender: message.sender,
                agentId: message.agentId,
                participantId: message.originPeer,
                explicitRawValue: message.senderType.rawValue
            )
            let displayName = ThunderCommParticipantIdentity.displayName(
                sender: message.sender,
                agentId: message.agentId,
                participantId: message.originPeer,
                senderType: senderType
            )
            let normalizedChannel = normalizeChannel(message.channel)

            return ThunderCommMessage(
                id: message.id,
                channel: normalizedChannel,
                sender: displayName,
                senderType: senderType,
                agentId: message.agentId,
                text: sanitize(message.text),
                timestamp: message.timestamp,
                originPeer: message.originPeer,
                relayedAt: message.relayedAt,
                relayedBy: message.relayedBy,
                contentKind: message.contentKind,
                attachment: message.attachment
            )
        }

        private func sanitize(_ text: String) -> String {
            var cleaned = text.replacingOccurrences(of: "\r\n", with: "\n")
            let patterns = [
                #"(?s)^Sender \(untrusted metadata\):\s*```json\s*\{.*?\}\s*```\s*"#,
                #"(?s)^Sender \(trusted metadata\):\s*```json\s*\{.*?\}\s*```\s*"#,
                #"(?s)^User\s+\d{1,2}:\d{2}\s*[AP]M\s*Sender \(untrusted metadata\):\s*json\s*\{.*?\}\s*Copy\s*"#
            ]

            for pattern in patterns {
                cleaned = cleaned.replacingOccurrences(of: pattern, with: "", options: .regularExpression)
            }

            return cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        private func clearActivity(for message: ThunderCommMessage) {
            let senderType = ThunderCommParticipantIdentity.senderType(
                sender: message.sender,
                agentId: message.agentId,
                participantId: message.originPeer,
                explicitRawValue: message.senderType.rawValue
            )
            let participantID = ThunderCommParticipantIdentity.canonicalID(
                sender: message.sender,
                agentId: message.agentId,
                participantId: message.originPeer,
                senderType: senderType
            )
            activityByParticipantID.removeValue(forKey: participantID)
            streamByParticipantID.removeValue(forKey: participantID)
            refreshIndicators()
            refreshStreamingPreviews()
        }

        private func inferDirectAgentIDIfNeeded(for text: String) -> String? {
            guard outboundAgentId == nil else { return nil }

            let normalizedTokens = Set(
                text.lowercased()
                    .components(separatedBy: CharacterSet.alphanumerics.inverted)
                    .filter { !$0.isEmpty }
            )
            if availableDirectAgents.contains(where: { normalizedTokens.contains($0.lowercased()) }) {
                return nil
            }

            let channel: String
            switch currentRoute {
            case .tnt:
                channel = "tnt"
            case .jmab:
                channel = "jmab"
            case .channel:
                channel = subscriptionChannel
            case .direct:
                channel = "direct:\(directAgentId)"
            }

            guard let inferred = MessageListView.inferTargetAgent(from: allMessages, channel: channel) else {
                return nil
            }
            return availableDirectAgents.contains(inferred) ? inferred : nil
        }

        private func resendFailedMessagesIfNeeded() {
            Task { [weak self] in
                guard let self else { return }
                let messageIDs = await delivery.retryPending()
                guard !messageIDs.isEmpty else { return }
                await MainActor.run {
                    for messageID in messageIDs {
                        guard let message = self.pendingMessages[messageID] ?? self.messageCacheLookup(id: messageID) else { continue }
                        self.deliveryStateByMessageID[messageID] = .sending
                        self.pendingMessages[messageID] = message
                        Task { await self.delivery.arm(messageId: messageID) }
                        self.client.send(message: message)
                        self.armDeliveryWatchdog(messageID: messageID)
                    }
                }
            }
        }

        private func loadPersistedMessages() {
            do {
                let persisted = try persistence.loadMessages()
                    .map(normalize)
                    .sorted { lhs, rhs in
                        if lhs.timestamp == rhs.timestamp {
                            return lhs.id < rhs.id
                        }
                        return lhs.timestamp < rhs.timestamp
                    }
                allMessages = Array(persisted.suffix(Self.maxPersistedMessages))
                messageIDs = Set(allMessages.map(\.id))
            } catch {
                debug("failed to load persisted messages from sqlite: \(error.localizedDescription)")
            }
        }

        private func persistMessages() {
            do {
                try persistence.replaceMessages(Array(allMessages.suffix(Self.maxPersistedMessages)))
            } catch {
                debug("failed to persist messages to sqlite: \(error.localizedDescription)")
            }
        }

        private func reconnectForSettingsChange() {
            peers.removeAll()
            clearLocalTypingIndicator(sendEvent: true)
            disconnect()
            connect()
        }

        private func requestRecentHistoryIfAvailable() {
            let channel: String
            switch currentRoute {
            case .direct:
                channel = activeThreadChannel(targetAgentId: directAgentId)
            case .channel:
                channel = subscriptionChannel
            case .tnt:
                channel = "tnt"
            case .jmab:
                channel = "jmab"
            }
            client.sendHistoryRequest(channel: channel, limit: Self.initialVisibleMessageCount)
        }

        private func startActivityPruneTimer() {
            activityPruneTimer?.invalidate()
            let timer = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
                self?.pruneExpiredIndicators()
            }
            activityPruneTimer = timer
            RunLoop.main.add(timer, forMode: .common)
        }

        private func pruneExpiredIndicators() {
            let cutoff = Self.nowMs - Self.activityExpiryMs
            let beforeCount = activityByParticipantID.count
            activityByParticipantID = activityByParticipantID.filter { _, indicator in
                indicator.updatedAt >= cutoff
            }
            streamByParticipantID = streamByParticipantID.filter { _, preview in
                preview.updatedAt >= cutoff
            }
            if activityByParticipantID.count != beforeCount {
                refreshIndicators()
            }
            refreshStreamingPreviews()
        }

        private func refreshIndicators() {
            activeIndicators = activityByParticipantID.values
                .filter { routeShows(channel: $0.channel) }
                .sorted { lhs, rhs in
                    if lhs.updatedAt == rhs.updatedAt {
                        return lhs.displayName < rhs.displayName
                    }
                    return lhs.updatedAt < rhs.updatedAt
                }
        }

        private func refreshStreamingPreviews() {
            streamingPreviews = streamByParticipantID.values
                .filter { routeShows(channel: $0.channel) }
                .sorted { lhs, rhs in
                    if lhs.updatedAt == rhs.updatedAt {
                        return lhs.displayName < rhs.displayName
                    }
                    return lhs.updatedAt < rhs.updatedAt
                }
        }

        private func refreshVisibleMessages() {
            let filteredAll = filteredMessages(from: allMessages)
            let targetVisibleCount = max(messages.count, Self.initialVisibleMessageCount)
            messages = Array(filteredAll.suffix(targetVisibleCount))
            hasOlderMessages = messages.count < filteredAll.count
        }

        private func filteredMessages(from messages: [ThunderCommMessage]) -> [ThunderCommMessage] {
            messages.filter { routeShows(message: $0) }
        }

        private func routeShows(message: ThunderCommMessage) -> Bool {
            let channel = normalizeChannel(message.channel)
            switch currentRoute {
            case .tnt:
                return channel == "tnt"
            case .jmab:
                return channel == "jmab"
            case .channel:
                return channel == subscriptionChannel
            case .direct:
                let target = directAgentId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                guard !target.isEmpty else { return false }
                let senderParticipantID = ThunderCommParticipantIdentity.canonicalID(
                    sender: message.sender,
                    agentId: message.agentId,
                    participantId: message.originPeer,
                    senderType: message.senderType
                )
                let isFromLocalUser = message.senderType == .human &&
                    (senderParticipantID == localParticipantID || message.sender == senderName)
                let messageAgentId = message.agentId?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
                let isFromTargetAgent = message.senderType == .agent &&
                    (messageAgentId == target || senderParticipantID == target)
                return isFromLocalUser || isFromTargetAgent
            }
        }

        private func routeShows(channel: String) -> Bool {
            switch currentRoute {
            case .tnt:
                return channel == "tnt"
            case .jmab:
                return channel == "jmab"
            case .channel:
                return channel == subscriptionChannel
            case .direct:
                let target = directAgentId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                guard !target.isEmpty else { return channel == "direct" }
                return channel == "direct" || channel == "direct:\(target)"
            }
        }

        private func normalizeChannel(_ channel: String?) -> String {
            guard let channel = channel?.trimmingCharacters(in: .whitespacesAndNewlines), !channel.isEmpty else {
                return "tnt"
            }
            if channel == "team" { return "tnt" }
            if channel.hasPrefix("#") { return String(channel.dropFirst()).lowercased() }
            return channel.lowercased()
        }

        private func normalizedEventChannel(_ channel: String?) -> String {
            normalizeChannel(channel)
        }

        private func thinkingChannel(for agentId: String?, explicitChannel: String?) -> String {
            if let explicitChannel,
               explicitChannel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
                return normalizedEventChannel(explicitChannel)
            }

            let normalizedAgentID = ThunderCommParticipantIdentity.canonicalID(
                sender: nil,
                agentId: agentId,
                participantId: agentId,
                senderType: .agent
            )
            if let remembered = lastDispatchChannelByAgent[normalizedAgentID], !remembered.isEmpty {
                return remembered
            }
            return "tnt"
        }

        private func activeThreadChannel(targetAgentId: String?) -> String {
            switch currentRoute {
            case .tnt:
                return "tnt"
            case .jmab:
                return "jmab"
            case .channel:
                return subscriptionChannel
            case .direct:
                let target = (targetAgentId ?? directAgentId).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                return target.isEmpty ? "direct" : "direct:\(target)"
            }
        }

        private func explicitMentionedAgentID(in text: String) -> String? {
            let lowered = text.lowercased()
            for agentID in availableDirectAgents {
                if lowered.contains("@\(agentID)") {
                    return agentID
                }
            }
            return nil
        }

        private func scheduleLocalTypingStop() {
            localTypingStopWorkItem?.cancel()
            let workItem = DispatchWorkItem { [weak self] in
                self?.clearLocalTypingIndicator(sendEvent: true)
            }
            localTypingStopWorkItem = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: workItem)
        }

        private func clearLocalTypingIndicator(sendEvent: Bool) {
            localTypingStopWorkItem?.cancel()
            guard isSendingLocalTyping else { return }
            if sendEvent {
                client.sendTyping(participantId: localParticipantID, senderType: .human, typing: false, channel: outboundChannel)
            }
            isSendingLocalTyping = false
        }

        private var localParticipantID: String {
            ThunderCommParticipantIdentity.canonicalID(sender: senderName, agentId: nil, participantId: peerId, senderType: .human)
        }

        private var subscriptionChannel: String {
            switch currentRoute {
            case .tnt:
                return "tnt"
            case .jmab:
                return "jmab"
            case .channel:
                return normalizeCustomChannel(selectedChannelName) ?? "tnt"
            case .direct:
                return "tnt"
            }
        }

        // Channels the relay should deliver on this connection:
        //   • the two shared rooms (tnt, jmab)
        //   • the active custom channel when route is .channel
        //   • all supported direct:<peer> channels so DM peer swaps do not
        //     require a narrow one-peer subscription window
        private var subscribedChannels: [String] {
            var list: [String] = ["tnt", "jmab"]
            if currentRoute == .channel,
               let custom = normalizeCustomChannel(selectedChannelName) {
                list.append(custom)
            }
            for agent in availableDirectAgents {
                let a = agent.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                if !a.isEmpty { list.append("direct:\(a)") }
            }
            var seen = Set<String>()
            return list.filter { seen.insert($0).inserted }
        }

        private var outboundChannel: String {
            switch currentRoute {
            case .tnt:
                return "tnt"
            case .jmab:
                return "jmab"
            case .channel:
                return subscriptionChannel
            case .direct:
                return "direct"
            }
        }

        private var outboundAgentId: String? {
            currentRoute == .direct ? directAgentId : nil
        }

        private func persistRoute() {
            UserDefaults.standard.set(currentRoute.rawValue, forKey: Self.routeDefaultsKey)
            UserDefaults.standard.set(directAgentId, forKey: Self.directAgentDefaultsKey)
            UserDefaults.standard.set(selectedChannelName, forKey: Self.selectedChannelDefaultsKey)
            UserDefaults.standard.set(customChannels, forKey: Self.customChannelsDefaultsKey)
        }

        private static func loadEndpoint() -> String {
            if let environment = ProcessInfo.processInfo.environment["THUNDERCOMM_ENDPOINT"], !environment.isEmpty {
                return environment
            }
            if let stored = UserDefaults.standard.string(forKey: endpointDefaultsKey), !stored.isEmpty {
                return stored
            }
            return ThunderCommConfig.defaultRelayURL.absoluteString
        }

        private static func loadToken() -> String {
            if let environment = ProcessInfo.processInfo.environment["THUNDERCOMM_TOKEN"], !environment.isEmpty {
                return environment
            }
            if let stored = UserDefaults.standard.string(forKey: tokenDefaultsKey), !stored.isEmpty {
                return stored
            }
            // Build 55 final: no hardcoded fallback. A fresh install ships with
            // no token; the connection layer waits for the user to sign in.
            return ""
        }

        private static func loadSenderName() -> String {
            if let environment = ProcessInfo.processInfo.environment["THUNDERCOMM_SENDER"], !environment.isEmpty {
                return environment
            }
            if let stored = UserDefaults.standard.string(forKey: senderDefaultsKey), !stored.isEmpty {
                return stored
            }
            if let signedIn = signedInUserDisplayName(), !signedIn.isEmpty {
                return signedIn
            }
            return ThunderCommConfig.defaultSender
        }

        // Pulled from the persisted UserStore blob so we don't have to hop onto
        // the MainActor at init time. Falls back to nil when no account is yet
        // saved (first-launch race) — the hard-coded default catches that case.
        private static func signedInUserDisplayName() -> String? {
            decodedSignedInUser()?.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        static func signedInUserKey() -> String? {
            let user = decodedSignedInUser()
            if let name = user?.displayName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
                return name
            }
            if let email = user?.email,
               let local = email.split(separator: "@").first {
                return String(local)
            }
            return nil
        }

        private struct PersistedUserInfo: Decodable {
            let displayName: String?
            let email: String?
        }

        private static func decodedSignedInUser() -> PersistedUserInfo? {
            guard let data = UserDefaults.standard.data(forKey: userAccountDefaultsKey) else {
                return nil
            }
            return try? JSONDecoder().decode(PersistedUserInfo.self, from: data)
        }

        private static func loadRoute() -> ThunderCommRoute {
            if let stored = UserDefaults.standard.string(forKey: routeDefaultsKey), let route = ThunderCommRoute(rawValue: stored) {
                return route
            }
            return .tnt
        }

        private static func loadDirectAgentId() -> String {
            if let stored = UserDefaults.standard.string(forKey: directAgentDefaultsKey), !stored.isEmpty {
                return stored
            }
            // Build 55 final: no hardcoded default direct-chat target.
            return ""
        }

        private static func loadSelectedChannel() -> String {
            if let stored = UserDefaults.standard.string(forKey: selectedChannelDefaultsKey), !stored.isEmpty {
                return stored
            }
            return ""
        }

        private static func loadCustomChannels() -> [String] {
            guard let stored = UserDefaults.standard.array(forKey: customChannelsDefaultsKey) as? [String] else {
                return []
            }
            return Array(Set(
                stored
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
                    .filter { !$0.isEmpty && $0 != "tnt" && $0 != "jmab" && $0 != "direct" && !$0.hasPrefix("direct:") }
            )).sorted()
        }

        private func normalizeCustomChannel(_ channel: String) -> String? {
            let normalized = normalizeChannel(channel)
            guard !normalized.isEmpty else { return nil }
            guard normalized != "tnt", normalized != "jmab", normalized != "direct", !normalized.hasPrefix("direct:") else {
                return nil
            }
            return normalized
        }

        private static var nowMs: Int64 {
            Int64(Date().timeIntervalSince1970 * 1000)
        }

        private static let placeholderParticipantIDs = Set(["agent", "human"])
    }


private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

private final class ThunderCommSQLiteStore {
    private let db: OpaquePointer?
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init() {
        let fm = FileManager.default
        let base = try? fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let dir = (base ?? URL(fileURLWithPath: NSTemporaryDirectory())).appendingPathComponent("ThunderComm", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let dbURL = dir.appendingPathComponent("ThunderComm.sqlite")

        var handle: OpaquePointer?
        if sqlite3_open(dbURL.path, &handle) != SQLITE_OK {
            self.db = nil
            if let handle {
                sqlite3_close(handle)
            }
            return
        }
        self.db = handle

        let createSQL = """
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY NOT NULL,
            channel TEXT NOT NULL,
            sender TEXT NOT NULL,
            sender_type TEXT NOT NULL,
            agent_id TEXT,
            text TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            origin_peer TEXT,
            relayed_at INTEGER,
            relayed_by TEXT,
            content_kind TEXT,
            attachment_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp, id);
        """
        _ = sqlite3_exec(handle, createSQL, nil, nil, nil)
    }

    deinit {
        if let db {
            sqlite3_close(db)
        }
    }

    func loadMessages() throws -> [ThunderCommMessage] {
        guard let db else { return [] }
        let sql = "SELECT id, channel, sender, sender_type, agent_id, text, timestamp, origin_peer, relayed_at, relayed_by, content_kind, attachment_json FROM messages ORDER BY timestamp ASC, id ASC;"
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            throw sqliteError(db)
        }
        defer { sqlite3_finalize(statement) }

        var messages: [ThunderCommMessage] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            let id = string(statement, 0) ?? UUID().uuidString
            let channel = string(statement, 1) ?? "tnt"
            let sender = string(statement, 2) ?? "Unknown"
            let senderType = ThunderCommSenderType(rawValue: (string(statement, 3) ?? "human").lowercased()) ?? .human
            let agentId = string(statement, 4)
            let text = string(statement, 5) ?? ""
            let timestamp = sqlite3_column_int64(statement, 6)
            let originPeer = string(statement, 7)
            let relayedAt = sqlite3_column_type(statement, 8) == SQLITE_NULL ? nil : sqlite3_column_int64(statement, 8)
            let relayedBy = string(statement, 9)
            let contentKind = string(statement, 10).flatMap { ThunderCommContentKind(rawValue: $0) }
            let attachment: ThunderCommAttachmentMetadata?
            if let attachmentJSON = string(statement, 11), let data = attachmentJSON.data(using: .utf8) {
                attachment = try? decoder.decode(ThunderCommAttachmentMetadata.self, from: data)
            } else {
                attachment = nil
            }

            messages.append(
                ThunderCommMessage(
                    id: id,
                    channel: channel,
                    sender: sender,
                    senderType: senderType,
                    agentId: agentId,
                    text: text,
                    timestamp: timestamp,
                    originPeer: originPeer,
                    relayedAt: relayedAt,
                    relayedBy: relayedBy,
                    contentKind: contentKind,
                    attachment: attachment
                )
            )
        }

        return messages
    }

    func replaceMessages(_ messages: [ThunderCommMessage]) throws {
        guard let db else { return }
        guard sqlite3_exec(db, "BEGIN IMMEDIATE TRANSACTION", nil, nil, nil) == SQLITE_OK else {
            throw sqliteError(db)
        }

        do {
            try execute(db, sql: "DELETE FROM messages;")
            let insertSQL = "INSERT INTO messages (id, channel, sender, sender_type, agent_id, text, timestamp, origin_peer, relayed_at, relayed_by, content_kind, attachment_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);"
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(db, insertSQL, -1, &statement, nil) == SQLITE_OK else {
                throw sqliteError(db)
            }
            defer { sqlite3_finalize(statement) }

            for message in messages {
                sqlite3_reset(statement)
                sqlite3_clear_bindings(statement)

                bind(statement, index: 1, text: message.id)
                bind(statement, index: 2, text: message.channel)
                bind(statement, index: 3, text: message.sender)
                bind(statement, index: 4, text: message.senderType.rawValue)
                bind(statement, index: 5, text: message.agentId)
                bind(statement, index: 6, text: message.text)
                sqlite3_bind_int64(statement, 7, message.timestamp)
                bind(statement, index: 8, text: message.originPeer)
                if let relayedAt = message.relayedAt {
                    sqlite3_bind_int64(statement, 9, relayedAt)
                } else {
                    sqlite3_bind_null(statement, 9)
                }
                bind(statement, index: 10, text: message.relayedBy)
                bind(statement, index: 11, text: message.contentKind?.rawValue)
                if let attachment = message.attachment {
                    let data = try encoder.encode(attachment)
                    bind(statement, index: 12, text: String(decoding: data, as: UTF8.self))
                } else {
                    sqlite3_bind_null(statement, 12)
                }

                guard sqlite3_step(statement) == SQLITE_DONE else {
                    throw sqliteError(db)
                }
            }

            guard sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK else {
                throw sqliteError(db)
            }
        } catch {
            sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            throw error
        }
    }

    private func execute(_ db: OpaquePointer, sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else {
            throw sqliteError(db)
        }
    }

    private func bind(_ statement: OpaquePointer?, index: Int32, text: String?) {
        if let text {
            sqlite3_bind_text(statement, index, text, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(statement, index)
        }
    }

    private func string(_ statement: OpaquePointer?, _ index: Int32) -> String? {
        guard let cString = sqlite3_column_text(statement, index) else { return nil }
        return String(cString: cString)
    }

    private func sqliteError(_ db: OpaquePointer?) -> NSError {
        let code = Int(sqlite3_errcode(db))
        let message = db.flatMap { sqlite3_errmsg($0) }.map { String(cString: $0) } ?? "Unknown SQLite error"
        return NSError(domain: "ThunderCommSQLiteStore", code: code, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
