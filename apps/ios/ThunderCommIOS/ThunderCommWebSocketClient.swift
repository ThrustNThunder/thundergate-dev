
import Foundation

// Build 55 final: the federation token and the default channel were both
// hardcoded here in earlier builds. Both are gone — the relay token now
// comes from the user's `tc-h-` session (see AuthManager / AccountStore),
// and a fresh install carries no default channel. Constants that survive
// are limited to the managed-relay URL (used by Settings → About + the
// connect path) and the marketing site URL.
enum ThunderCommConfig {
    static let defaultRelayURL = URL(string: "wss://relay.thunderai.us")!
    static let defaultSender = "Guest"
    static let defaultWebsiteURL = URL(string: "https://thunderai.us")!
}

private struct ActiveConnection {
    let endpoint: URL
    let token: String
    let peerId: String
    let channels: [String]
}

final class ThunderCommWebSocketClient: NSObject {
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var connectionEpoch = 0
    private var reconnectAttempt = 0
    private var activeConnection: ActiveConnection?
    private var reconnectWorkItem: DispatchWorkItem?
    private var pingWorkItem: DispatchWorkItem?
    private var authTimeoutWorkItem: DispatchWorkItem?
    private var isManualDisconnect = false
    private var shouldRetry = true
    private var endpointCandidates: [URL] = []
    private var currentEndpointIndex = 0

    var onStateChange: ((ThunderCommConnectionState) -> Void)?
    var onEvent: ((ThunderCommInboundEvent) -> Void)?
    var onMessageSent: ((String) -> Void)?
    var onMessageFailed: ((String, String) -> Void)?
    // Asked at (re)connect time so the auth handshake can carry the
    // highest timestamp the store already has for the active channel.
    // The relay uses this to skip messages the client has already seen
    // and prevent the burst replay seen in Build 28.
    var onResolveAfterTimestamp: ((String) -> Int64)?

    private func debug(_ message: String) {
        print("[ThunderComm] \(message)")
    }

    func connect(endpoint: URL, token: String, peerId: String, channels: [String] = []) {
        endpointCandidates = Self.makeEndpointCandidates(from: endpoint)
        debug("connect requested with candidates: \(endpointCandidates.map { $0.absoluteString }.joined(separator: ", ")) channels=\(channels.joined(separator: ","))")
        currentEndpointIndex = 0
        activeConnection = ActiveConnection(endpoint: endpointCandidates[0], token: token, peerId: peerId, channels: channels)
        reconnectAttempt = 0
        isManualDisconnect = false
        shouldRetry = true
        reconnectWorkItem?.cancel()
        openConnection()
    }

    func disconnect() {
        isManualDisconnect = true
        shouldRetry = false
        connectionEpoch += 1
        reconnectWorkItem?.cancel()
        pingWorkItem?.cancel()
        authTimeoutWorkItem?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session = nil
        onStateChange?(.disconnected)
    }

    func send(message: ThunderCommMessage) {
        let payload = FederationMessagePayload(
            channel: message.channel,
            sender: message.sender,
            senderType: message.senderType.rawValue,
            text: message.text,
            timestamp: message.timestamp,
            originPeer: message.originPeer ?? "",
            id: message.id,
            agentId: message.agentId,
            idempotencyKey: message.id
        )
        send(
            payload,
            onSuccess: { [weak self] in
                self?.onMessageSent?(message.id)
            },
            onFailure: { [weak self] reason in
                self?.onMessageFailed?(message.id, reason)
            }
        )
    }

    func sendTyping(participantId: String, senderType: ThunderCommSenderType, typing: Bool, channel: String) {
        let payload = ThunderCommTypingOutboundPayload(
            participantId: participantId,
            senderType: senderType.rawValue,
            typing: typing,
            channel: channel,
            timestamp: Int64(Date().timeIntervalSince1970 * 1000),
            agentId: senderType == .agent ? participantId : nil
        )
        send(payload)
    }

    func sendHistoryRequest(channel: String, limit: Int) {
        let afterTimestamp = onResolveAfterTimestamp?(channel) ?? 0
        send(ThunderCommHistoryRequestPayload(
            channel: channel,
            limit: limit,
            afterTimestamp: afterTimestamp > 0 ? afterTimestamp : nil
        ))
    }

    /// Broadcasts a channel_created frame so other members can mirror the
    /// channel locally. Presentation-layer privacy only (v1) — receivers
    /// filter by membership; the relay does not.
    func sendChannelCreated(channel: ThunderChannel, by peerId: String) {
        let payload = ChannelCreatedOutboundPayload(
            channelId: channel.id,
            name: channel.name,
            members: channel.members,
            createdBy: peerId,
            createdAt: Int64(Date().timeIntervalSince1970 * 1000)
        )
        send(payload)
    }

    private func openConnection() {
        guard var activeConnection else {
            onStateChange?(.failed("Missing connection config"))
            return
        }

        let endpoint = endpointCandidates.indices.contains(currentEndpointIndex)
            ? endpointCandidates[currentEndpointIndex]
            : activeConnection.endpoint
        activeConnection = ActiveConnection(endpoint: endpoint, token: activeConnection.token, peerId: activeConnection.peerId, channels: activeConnection.channels)
        self.activeConnection = activeConnection

        pingWorkItem?.cancel()
        authTimeoutWorkItem?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session = nil

        onStateChange?(.connecting)
        debug("opening socket to \(activeConnection.endpoint.absoluteString)")

        let config = URLSessionConfiguration.default
        session = URLSession(configuration: config)
        task = session?.webSocketTask(with: activeConnection.endpoint)
        task?.resume()

        connectionEpoch += 1
        let epoch = connectionEpoch
        let currentTask = task

        onStateChange?(.authenticating)
        sendAuth(token: activeConnection.token, peerId: activeConnection.peerId, channels: activeConnection.channels)
        scheduleAuthTimeout(for: epoch)
        if let currentTask {
            receiveLoop(task: currentTask, epoch: epoch)
        }
        scheduleNextPing(after: 30, for: epoch)
    }

    private func sendAuth(token: String, peerId: String, channels: [String]) {
        // When one socket subscribes to multiple channels, using the newest
        // timestamp as the replay floor can starve quieter threads, especially
        // direct:agent DMs behind a noisy #tnt. Use the oldest positive floor
        // instead. That can replay a few already-seen room messages after a
        // reconnect, but the store de-dupes by message id and it keeps DMs
        // from disappearing.
        let floors = channels.compactMap { channel -> Int64? in
            guard let ts = onResolveAfterTimestamp?(channel), ts > 0 else { return nil }
            return ts
        }
        let payload = FederationAuthPayload(
            token: token,
            peerId: peerId,
            channels: channels,
            afterTimestamp: floors.min()
        )
        send(payload)
    }

    private func send<T: Encodable>(_ payload: T, onSuccess: (() -> Void)? = nil, onFailure: ((String) -> Void)? = nil) {
        do {
            let data = try JSONEncoder().encode(payload)
            guard let text = String(data: data, encoding: .utf8) else {
                onFailure?("payload not utf8")
                return
            }
            // If the socket isn't up yet, don't surface failure immediately —
            // the store's send watchdog will flip the row to .failed after a
            // grace window if no ack arrives, which gives a fast reconnect a
            // chance to deliver normally instead of flashing red on every
            // route switch.
            guard let task else {
                debug("send skipped, socket not ready")
                return
            }
            let epoch = connectionEpoch
            task.send(.string(text)) { [weak self] error in
                guard let self else { return }
                guard epoch == self.connectionEpoch, task === self.task else { return }
                if let error {
                    self.debug("send failure: \(error.localizedDescription)")
                    self.scheduleReconnect(because: error.localizedDescription, for: epoch)
                    onFailure?(error.localizedDescription)
                } else {
                    self.debug("send ok: \(text)")
                    onSuccess?()
                }
            }
        } catch {
            onStateChange?(.failed(error.localizedDescription))
            onFailure?(error.localizedDescription)
        }
    }

    private func receiveLoop(task: URLSessionWebSocketTask, epoch: Int) {
        task.receive { [weak self] result in
            guard let self else { return }
            guard epoch == self.connectionEpoch, task === self.task else { return }
            switch result {
            case .failure(let error):
                self.debug("receive failure: \(error.localizedDescription)")
                self.scheduleReconnect(because: error.localizedDescription, for: epoch)
            case .success(let message):
                self.handle(message)
                self.receiveLoop(task: task, epoch: epoch)
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let text: String
        switch message {
        case .string(let string):
            text = string
        case .data(let data):
            text = String(decoding: data, as: UTF8.self)
        @unknown default:
            return
        }

        guard let event = decodeEvent(text) else {
            onEvent?(.unknown(text))
            return
        }

        switch event {
        case .status(let status):
            if status.status == "connected" {
                reconnectAttempt = 0
                authTimeoutWorkItem?.cancel()
                debug("authenticated as \(status.peerId ?? "unknown")")
                onStateChange?(.connected)
            } else if status.status == "rejected" {
                authTimeoutWorkItem?.cancel()
                debug("authentication rejected: \(status.reason ?? "unknown")")
                shouldRetry = false
                onStateChange?(.failed("Authentication rejected: \(status.reason ?? "unknown")"))
                task?.cancel(with: .policyViolation, reason: nil)
            }
        case .error(let errorPayload):
            if errorPayload.code == "AUTH_FAILED" {
                shouldRetry = false
                onStateChange?(.failed(errorPayload.message))
            }
        default:
            break
        }

        onEvent?(event)
    }

    private func decodeEvent(_ text: String) -> ThunderCommInboundEvent? {
        guard let data = text.data(using: .utf8) else { return nil }
        guard let base = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = base["type"] as? String else {
            return nil
        }

        let decoder = JSONDecoder()
        switch type {
        case "federation_status", "status":
            if let value = try? decoder.decode(FederationStatusPayload.self, from: data) {
                return .status(value)
            }
        case "federation_peers":
            if let value = try? decoder.decode(FederationPeersPayload.self, from: data) {
                return .peers(value)
            }
        case "roster":
            if let value = try? decoder.decode(ThunderCommRosterPayload.self, from: data) {
                return .roster(value)
            }
        case "history":
            if let value = try? decoder.decode(ThunderCommHistoryPayload.self, from: data) {
                return .history(value)
            }
        case "federation_message", "message":
            if let value = try? decoder.decode(ThunderCommMessage.self, from: data) {
                return .message(value)
            }
        case "typing":
            if let value = try? decoder.decode(ThunderCommTypingPayload.self, from: data) {
                return .typing(value)
            }
        case "thinking":
            if let value = try? decoder.decode(ThunderCommThinkingPayload.self, from: data) {
                return .thinking(value)
            }
        case "stream":
            if let value = try? decoder.decode(ThunderCommStreamPayload.self, from: data) {
                return .stream(value)
            }
        case "ack":
            if let value = try? decoder.decode(ThunderCommAckPayload.self, from: data) {
                return .ack(value)
            }
        case "system_event":
            if let value = try? decoder.decode(ThunderCommSystemEventPayload.self, from: data) {
                return .systemEvent(value)
            }
        case "error":
            if let value = try? decoder.decode(ThunderCommErrorPayload.self, from: data) {
                return .error(value)
            }
        case "channel_created":
            if let value = try? decoder.decode(ChannelCreatedPayload.self, from: data) {
                return .channelCreated(value)
            }
        default:
            return .unknown(text)
        }
        return nil
    }

    private func scheduleAuthTimeout(for epoch: Int) {
        authTimeoutWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self, !self.isManualDisconnect, epoch == self.connectionEpoch else { return }
            self.debug("auth timeout waiting for federation_status connected")
            self.onStateChange?(.failed("Auth timeout. Check the ThunderCommo endpoint and confirm the relay is reachable."))
            self.scheduleReconnect(because: "auth timeout", for: epoch)
        }
        authTimeoutWorkItem = workItem
        DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: workItem)
    }

    private func scheduleNextPing(after delay: TimeInterval, for epoch: Int) {
        pingWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self, !self.isManualDisconnect, epoch == self.connectionEpoch else { return }
            self.task?.sendPing { [weak self] error in
                guard let self else { return }
                guard epoch == self.connectionEpoch else { return }
                if let error {
                    self.scheduleReconnect(because: error.localizedDescription, for: epoch)
                    return
                }
                self.scheduleNextPing(after: 30, for: epoch)
            }
        }
        pingWorkItem = workItem
        DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: workItem)
    }

    private func scheduleReconnect(because reason: String, for epoch: Int? = nil) {
        if let epoch, epoch != connectionEpoch {
            debug("ignoring stale reconnect from epoch \(epoch): \(reason)")
            return
        }
        guard !isManualDisconnect, shouldRetry, let _ = activeConnection else { return }

        // Downgrade wss → ws only on genuine TLS handshake failures. A
        // generic "socket is not connected" or any transient drop should
        // NOT poison the transport for the rest of the session — during a
        // degraded-relay incident that would silently force every reconnect
        // onto an insecure transport, which the relay then rejects, and we
        // never recover to wss. Errors we treat as TLS-specific are those
        // mentioning ssl / tls / secure / certificate explicitly.
        let normalizedReason = reason.lowercased()
        if currentEndpointIndex + 1 < endpointCandidates.count,
           normalizedReason.contains("ssl")
            || normalizedReason.contains("tls")
            || normalizedReason.contains("secure")
            || normalizedReason.contains("certificate") {
            currentEndpointIndex += 1
            reconnectAttempt = 0
            debug("switching transport to \(endpointCandidates[currentEndpointIndex].absoluteString) after TLS error: \(reason)")
            onEvent?(.unknown("switching transport to \(endpointCandidates[currentEndpointIndex].scheme ?? "unknown") after TLS error: \(reason)"))
        }

        debug("reconnect scheduled because: \(reason)")

        reconnectAttempt += 1
        let delay = min(pow(2.0, Double(max(0, reconnectAttempt - 1))), 30)
        onStateChange?(.reconnecting(delaySeconds: delay))
        onEvent?(.unknown("reconnect scheduled: \(reason)"))
        reconnectWorkItem?.cancel()
        pingWorkItem?.cancel()
        authTimeoutWorkItem?.cancel()

        let workItem = DispatchWorkItem { [weak self] in
            self?.openConnection()
        }
        reconnectWorkItem = workItem
        DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: workItem)
    }

    private static func makeEndpointCandidates(from endpoint: URL) -> [URL] {
        var results: [URL] = [endpoint]
        if endpoint.scheme == "wss", var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) {
            components.scheme = "ws"
            if let fallback = components.url {
                results.append(fallback)
            }
        }
        return results
    }
}
