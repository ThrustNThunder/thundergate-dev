
    import Foundation
import SQLite3
import Observation

    @Observable
    final class ThunderCommStore {
        private static let endpointDefaultsKey = "ThunderComm.endpointOverride"
        private static let tokenDefaultsKey = "ThunderComm.tokenOverride"
        private static let senderDefaultsKey = "ThunderComm.senderOverride"
        private static let routeDefaultsKey = "ThunderComm.route"
        private static let directAgentDefaultsKey = "ThunderComm.directAgent"
        private static let initialVisibleMessageCount = 20
        private static let historyPageSize = 20
        private static let maxPersistedMessages = 300
        private static let activityExpiryMs: Int64 = 8_000

        var connectionState: ThunderCommConnectionState = .disconnected
        var messages: [ThunderCommMessage] = []
        var peers: [String] = []
        var endpointText: String = ThunderCommStore.loadEndpoint()
        var token: String = ThunderCommStore.loadToken()
        var senderName: String = ThunderCommStore.loadSenderName()
        var currentRoute: ThunderCommRoute = ThunderCommStore.loadRoute()
        var directAgentId: String = ThunderCommStore.loadDirectAgentId()
        let peerId: String = ThunderCommIdentity.loadOrCreatePeerId()

        var activeIndicators: [ThunderCommActivityIndicator] = []
        var streamingPreviews: [ThunderCommStreamingPreview] = []
        var hasOlderMessages: Bool = false

        let availableDirectAgents: [String] = ["jon", "mack", "rex", "burt", "sasha"]

        private var messageIDs = Set<String>()
        private var allMessages: [ThunderCommMessage] = []
        private var activityByParticipantID: [String: ThunderCommActivityIndicator] = [:]
        private var streamByParticipantID: [String: ThunderCommStreamingPreview] = [:]
        private var rosterByParticipantID: [String: ThunderCommParticipant] = [:]
        private var rosterOrder: [String] = []
        private var knownParticipantIDs = Set<String>(["michael", "jon", "mack", "rex", "burt", "sasha"])
        private let client = ThunderCommWebSocketClient()
        private let persistence = ThunderCommSQLiteStore()
        private let autoSendText = ProcessInfo.processInfo.environment["THUNDERCOMM_AUTOSEND_TEXT"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        private let autoSendDelaySeconds = Double(ProcessInfo.processInfo.environment["THUNDERCOMM_AUTOSEND_DELAY_SECONDS"] ?? "0") ?? 0
        private var didAutoSend = false
        private var activityPruneTimer: Timer?
        private var localTypingStopWorkItem: DispatchWorkItem?
        private var isSendingLocalTyping = false

        private func debug(_ message: String) {
            print("[ThunderCommStore] \(message)")
        }

        init() {
            loadPersistedMessages()
            refreshVisibleMessages()
            startActivityPruneTimer()

            client.onStateChange = { [weak self] state in
                DispatchQueue.main.async {
                    self?.connectionState = state
                    if case .connected = state {
                        self?.requestRecentHistoryIfAvailable()
                        self?.sendAutoProbeIfNeeded()
                    }
                }
            }

            client.onEvent = { [weak self] event in
                DispatchQueue.main.async {
                    self?.handle(event)
                }
            }
        }

        deinit {
            activityPruneTimer?.invalidate()
        }

        var routeLabel: String {
            switch currentRoute {
            case .tnt:
                return "#tnt"
            case .jmab:
                return "#jmab"
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

        func connect() {
            guard let endpoint = URL(string: endpointText) else {
                connectionState = .failed("Bad relay URL")
                return
            }
            client.connect(endpoint: endpoint, token: token, peerId: peerId, channel: subscriptionChannel)
        }

        func disconnect() {
            clearLocalTypingIndicator(sendEvent: true)
            client.disconnect()
        }

        func setRoute(_ route: ThunderCommRoute, agentId: String? = nil) {
            currentRoute = route
            if let agentId, !agentId.isEmpty {
                directAgentId = agentId
            }
            persistRoute()
            refreshVisibleMessages()
            refreshIndicators()
            refreshStreamingPreviews()
            if case .connected = connectionState {
                requestRecentHistoryIfAvailable()
            }
        }

        func updateConnectionSettings(endpoint: String, token: String, senderName: String) {
            let trimmedEndpoint = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedSender = senderName.trimmingCharacters(in: .whitespacesAndNewlines)

            self.endpointText = trimmedEndpoint.isEmpty ? ThunderCommConfig.defaultRelayURL.absoluteString : trimmedEndpoint
            self.token = trimmedToken.isEmpty ? ThunderCommConfig.defaultToken : trimmedToken
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
            let message = ThunderCommMessage(
                id: UUID().uuidString,
                channel: outboundChannel,
                sender: ThunderCommParticipantIdentity.displayName(sender: senderName, agentId: nil, participantId: nil, senderType: .human),
                senderType: .human,
                agentId: outboundAgentId,
                text: trimmed,
                timestamp: Self.nowMs,
                originPeer: peerId,
                relayedAt: nil,
                relayedBy: nil,
                contentKind: .text,
                attachment: nil
            )
            append(message)
            client.send(message: message)
            clearLocalTypingIndicator(sendEvent: true)
            draft = ""
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
            case .ack:
                break
            case .systemEvent(let payload):
                handleSystemEvent(payload)
            case .error(let payload):
                handleError(payload)
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

            setActivity(participantID: participantID, displayName: displayName, senderType: senderType, isActive: payload.typing, timestamp: payload.timestamp)
        }

        private func handleThinking(_ payload: ThunderCommThinkingPayload) {
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

            setActivity(participantID: participantID, displayName: displayName, senderType: senderType, isActive: true, timestamp: payload.timestamp)
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
            setActivity(participantID: participantID, displayName: displayName, senderType: senderType, isActive: true, timestamp: payload.timestamp)
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

        private func setActivity(participantID: String, displayName: String, senderType: ThunderCommSenderType, isActive: Bool, timestamp: Int64?) {
            guard !participantID.isEmpty else { return }
            knownParticipantIDs.insert(participantID)

            if isActive {
                activityByParticipantID[participantID] = ThunderCommActivityIndicator(
                    id: participantID,
                    displayName: displayName,
                    senderType: senderType,
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

        func senderType(forParticipantID participantID: String) -> ThunderCommSenderType {
            ThunderCommParticipantIdentity.senderType(sender: nil, agentId: participantID, participantId: participantID, explicitRawValue: nil)
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
            client.sendHistoryRequest(channel: subscriptionChannel, limit: Self.initialVisibleMessageCount)
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
                .filter { _ in true }
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
            messages.filter { routeShows(channel: normalizeChannel($0.channel)) }
        }

        private func routeShows(channel: String) -> Bool {
            switch currentRoute {
            case .jmab:
                return channel == "jmab"
            case .tnt, .direct:
                return channel != "jmab"
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
            currentRoute == .jmab ? "jmab" : "tnt"
        }

        private var outboundChannel: String {
            switch currentRoute {
            case .tnt:
                return "tnt"
            case .jmab:
                return "jmab"
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
            return ThunderCommConfig.defaultToken
        }

        private static func loadSenderName() -> String {
            if let environment = ProcessInfo.processInfo.environment["THUNDERCOMM_SENDER"], !environment.isEmpty {
                return environment
            }
            if let stored = UserDefaults.standard.string(forKey: senderDefaultsKey), !stored.isEmpty {
                return stored
            }
            return ThunderCommConfig.defaultSender
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
            return "jon"
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
