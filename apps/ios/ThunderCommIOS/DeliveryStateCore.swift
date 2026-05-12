import Foundation

actor DeliveryStateCore {
    private var states: [String: ThunderCommDeliveryState] = [:]

    func arm(messageId: String) {
        states[messageId] = .sending
    }

    func markSent(messageId: String) {
        guard let current = states[messageId] else {
            states[messageId] = .sent
            return
        }
        switch current {
        case .delivered, .failed:
            return
        case .sending, .sent:
            states[messageId] = .sent
        }
    }

    func markDelivered(messageId: String) {
        states[messageId] = .delivered
    }

    func markFailed(messageId: String) {
        guard let current = states[messageId] else {
            states[messageId] = .failed
            return
        }
        switch current {
        case .sending, .failed:
            states[messageId] = .failed
        case .sent, .delivered:
            return
        }
    }

    func state(for messageId: String) -> ThunderCommDeliveryState {
        states[messageId] ?? .sending
    }

    func retryPending() -> [String] {
        states.compactMap { id, state in state == .failed ? id : nil }
    }

    func clear(messageId: String) {
        states.removeValue(forKey: messageId)
    }

    func snapshot() -> [String: ThunderCommDeliveryState] {
        states
    }
}
