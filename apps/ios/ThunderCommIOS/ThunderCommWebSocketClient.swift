
import Foundation

enum ThunderCommConfig {
    static let defaultRelayURL = URL(string: "wss://relay.thunderai.us")!
    static let defaultChannel = "tnt"
    static let defaultToken = "jmab-federation-2026"
    static let defaultSender = "Michael"
    static let defaultWebsiteURL = URL(string: "https://thunderai.us")!
}

private struct ActiveConnection {
    let endpoint: URL
    let token: String
    let peerId: String
    let channel: String
}

final class ThunderCommWebSocketClient: NSObject {
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
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

    private func debug(_ message: String) {
        print("[ThunderComm] \(message)")
    }

    func connect(endpoint: URL, token: String, peerId: String, channel: String = ThunderCommConfig.defaultChannel) {
        endpointCandidates = Self.makeEndpointCandidates(from: endpoint)
        debug("connect requested with candidates: \(endpointCandidates.map { $0.absoluteString }.joined(separator: ", "))")
        currentEndpointIndex = 0
        activeConnection = ActiveConnection(endpoint: endpointCandidates[0], token: token, peerId: peerId, channel: channel)
        reconnectAttempt = 0
        isManualDisconnect = false
        shouldRetry = true
        reconnectWorkItem?.cancel()
        openConnection()
    }

    func disconnect() {
        isManualDisconnect = true
        shouldRetry = false
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
        send(payload)
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
        send(ThunderCommHistoryRequestPayload(channel: channel, limit: limit))
    }

    private func openConnection() {
        guard var activeConnection else {
            onStateChange?(.failed("Missing connection config"))
            return
        }

        let endpoint = endpointCandidates.indices.contains(currentEndpointIndex)
            ? endpointCandidates[currentEndpointIndex]
            : activeConnection.endpoint
        activeConnection = ActiveConnection(endpoint: endpoint, token: activeConnection.token, peerId: activeConnection.peerId, channel: activeConnection.channel)
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

        onStateChange?(.authenticating)
        sendAuth(token: activeConnection.token, peerId: activeConnection.peerId, channels: [activeConnection.channel])
        scheduleAuthTimeout()
        receiveLoop()
        scheduleNextPing(after: 30)
    }

    private func sendAuth(token: String, peerId: String, channels: [String]) {
        let payload = FederationAuthPayload(token: token, peerId: peerId, channels: channels)
        send(payload)
    }

    private func send<T: Encodable>(_ payload: T) {
        do {
            let data = try JSONEncoder().encode(payload)
            guard let text = String(data: data, encoding: .utf8) else { return }
            task?.send(.string(text)) { [weak self] error in
                guard let self else { return }
                if let error {
                    self.debug("send failure: \(error.localizedDescription)")
                    self.scheduleReconnect(because: error.localizedDescription)
                } else {
                    self.debug("send ok: \(text)")
                }
            }
        } catch {
            onStateChange?(.failed(error.localizedDescription))
        }
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.debug("receive failure: \(error.localizedDescription)")
                self.scheduleReconnect(because: error.localizedDescription)
            case .success(let message):
                self.handle(message)
                self.receiveLoop()
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
        default:
            return .unknown(text)
        }
        return nil
    }

    private func scheduleAuthTimeout() {
        authTimeoutWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self, !self.isManualDisconnect else { return }
            self.debug("auth timeout waiting for federation_status connected")
            self.onStateChange?(.failed("Auth timeout. Check the ThunderCommo endpoint and confirm the relay is reachable."))
            self.scheduleReconnect(because: "auth timeout")
        }
        authTimeoutWorkItem = workItem
        DispatchQueue.global().asyncAfter(deadline: .now() + 12, execute: workItem)
    }

    private func scheduleNextPing(after delay: TimeInterval) {
        pingWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self, !self.isManualDisconnect else { return }
            self.task?.sendPing { [weak self] error in
                guard let self else { return }
                if let error {
                    self.scheduleReconnect(because: error.localizedDescription)
                    return
                }
                self.scheduleNextPing(after: 30)
            }
        }
        pingWorkItem = workItem
        DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: workItem)
    }

    private func scheduleReconnect(because reason: String) {
        guard !isManualDisconnect, shouldRetry, let _ = activeConnection else { return }

        let normalizedReason = reason.lowercased()
        if currentEndpointIndex + 1 < endpointCandidates.count,
           normalizedReason.contains("ssl") || normalizedReason.contains("tls") || normalizedReason.contains("secure") || normalizedReason.contains("socket is not connected") {
            currentEndpointIndex += 1
            reconnectAttempt = 0
            debug("switching transport to \(endpointCandidates[currentEndpointIndex].absoluteString) after error: \(reason)")
            onEvent?(.unknown("switching transport to \(endpointCandidates[currentEndpointIndex].scheme ?? "unknown") after: \(reason)"))
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
