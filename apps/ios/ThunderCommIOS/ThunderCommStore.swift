
    import Foundation
    import Observation

    @Observable
    final class ThunderCommStore {
        private static let endpointDefaultsKey = "ThunderComm.endpointOverride"
        private static let tokenDefaultsKey = "ThunderComm.tokenOverride"
        private static let senderDefaultsKey = "ThunderComm.senderOverride"
        private static let routeDefaultsKey = "ThunderComm.route"
        private static let directAgentDefaultsKey = "ThunderComm.directAgent"
        private static let persistedMessagesKey = "ThunderComm.persistedMessages.v4"
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
        private var knownParticipantIDs = Set<String>(["michael", "jon", "mack", "rex", "burt", "sasha"])
        private let client = ThunderCommWebSocketClient()
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
                peers = payload.agents.map(\.id).sorted()
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
            let activePeerIDs = Set(peers.map { peerColorKey(for: $0) })
            let messagePeerIDs = Set(allMessages.map {
                ThunderCommParticipantIdentity.canonicalID(
                    sender: $0.sender,
                    agentId: $0.agentId,
                    participantId: $0.originPeer,
                    senderType: $0.senderType
                )
            })
            return Array(knownParticipantIDs.union(activePeerIDs).union(messagePeerIDs)).sorted()
        }

        func displayName(forParticipantID participantID: String) -> String {
            ThunderCommParticipantIdentity.displayName(sender: nil, agentId: participantID, participantId: participantID, senderType: senderType(forParticipantID: participantID))
        }

        func senderType(forParticipantID participantID: String) -> ThunderCommSenderType {
            ThunderCommParticipantIdentity.senderType(sender: nil, agentId: participantID, participantId: participantID, explicitRawValue: nil)
        }

        func statusForParticipantID(_ participantID: String) -> ThunderCommPresenceStatus {
            if activityByParticipantID[participantID] != nil {
                return .busy
            }
            let activePeerIDs = Set(peers.map { peerColorKey(for: $0) })
            if activePeerIDs.contains(participantID) || participantID == localParticipantID {
                return .online
            }
            return .offline
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
            guard let data = UserDefaults.standard.data(forKey: Self.persistedMessagesKey) else { return }
            do {
                let persisted = try JSONDecoder().decode([ThunderCommMessage].self, from: data)
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
                debug("failed to decode persisted messages: \(error.localizedDescription)")
            }
        }

        private func persistMessages() {
            do {
                let data = try JSONEncoder().encode(Array(allMessages.suffix(Self.maxPersistedMessages)))
                UserDefaults.standard.set(data, forKey: Self.persistedMessagesKey)
            } catch {
                debug("failed to persist messages: \(error.localizedDescription)")
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
    }
