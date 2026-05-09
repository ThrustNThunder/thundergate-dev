import Foundation

enum ThunderCommConfig {
    static let defaultRelayURL = URL(string: "wss://100.113.210.59:8767")!
    static let defaultChannel = "tnt"
    static let defaultToken = "jmab-federation-2026"
}

final class ThunderCommWebSocketClient: NSObject {
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var reconnectAttempt = 0

    var onStateChange: ((ThunderCommConnectionState) -> Void)?
    var onEvent: ((ThunderCommInboundEvent) -> Void)?

    func connect(endpoint: URL, token: String, peerId: String, channel: String = "tnt") {
        disconnect()
        onStateChange?(.connecting)

        let config = URLSessionConfiguration.default
        session = URLSession(configuration: config)
        task = session?.webSocketTask(with: endpoint)
        task?.resume()

        onStateChange?(.authenticating)
        sendAuth(token: token, peerId: peerId, channels: [channel])
        receiveLoop()
        sendPingLoop()
    }

    func disconnect() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session = nil
        onStateChange?(.disconnected)
    }

    func sendMessage(text: String, sender: String, peerId: String, channel: String = "tnt") {
        let payload = FederationMessagePayload(
            channel: channel,
            sender: sender,
            senderType: "human",
            text: text,
            timestamp: Int64(Date().timeIntervalSince1970 * 1000),
            originPeer: peerId,
            id: UUID().uuidString
        )
        send(payload)
    }

    private func sendAuth(token: String, peerId: String, channels: [String]) {
        let payload = FederationAuthPayload(token: token, peerId: peerId, channels: channels)
        send(payload)
    }

    private func send<T: Encodable>(_ payload: T) {
        do {
            let data = try JSONEncoder().encode(payload)
            guard let text = String(data: data, encoding: .utf8) else { return }
            task?.send(.string(text)) { error in
                if let error {
                    self.onStateChange?(.failed(error.localizedDescription))
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

        if let event = decodeEvent(text) {
            if case .status(let status) = event, status.status == "connected" {
                reconnectAttempt = 0
                onStateChange?(.connected)
            }
            onEvent?(event)
        } else {
            onEvent?(.unknown(text))
        }
    }

    private func decodeEvent(_ text: String) -> ThunderCommInboundEvent? {
        guard let data = text.data(using: .utf8) else { return nil }
        guard let base = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = base["type"] as? String else {
            return nil
        }

        let decoder = JSONDecoder()
        switch type {
        case "federation_status":
            if let value = try? decoder.decode(FederationStatusPayload.self, from: data) {
                return .status(value)
            }
        case "federation_peers":
            if let value = try? decoder.decode(FederationPeersPayload.self, from: data) {
                return .peers(value)
            }
        case "federation_message":
            if let value = try? decoder.decode(ThunderCommMessage.self, from: data) {
                return .message(value)
            }
        default:
            return .unknown(text)
        }
        return nil
    }

    private func sendPingLoop() {
        task?.sendPing { [weak self] error in
            guard let self else { return }
            if let error {
                self.scheduleReconnect(because: error.localizedDescription)
                return
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 30) {
                self.sendPingLoop()
            }
        }
    }

    private func scheduleReconnect(because reason: String) {
        reconnectAttempt += 1
        let delay = min(pow(2.0, Double(max(0, reconnectAttempt - 1))), 30)
        onStateChange?(.reconnecting(delaySeconds: delay))
        onEvent?(.unknown("reconnect scheduled: \(reason)"))
    }
}
