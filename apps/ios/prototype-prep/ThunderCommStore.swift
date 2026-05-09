import Foundation
import Observation

@Observable
final class ThunderCommStore {
    var connectionState: ThunderCommConnectionState = .disconnected
    var messages: [ThunderCommMessage] = []
    var peers: [String] = []

    let client = ThunderCommWebSocketClient()

    init() {
        client.onStateChange = { [weak self] state in
            DispatchQueue.main.async {
                self?.connectionState = state
            }
        }

        client.onEvent = { [weak self] event in
            DispatchQueue.main.async {
                switch event {
                case .status:
                    break
                case .peers(let payload):
                    self?.peers = payload.peers
                case .message(let message):
                    self?.messages.append(message)
                case .unknown:
                    break
                }
            }
        }
    }
}
