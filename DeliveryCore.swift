//
//  DeliveryCore.swift
//  ThunderCommIOS
//
//  Pure delivery-state core. No UIKit/SwiftUI dependency.
//  Owned by Jon. ThunderCommStore holds an instance and forwards events.
//

import Foundation

public enum DeliveryState: String, Codable, Sendable, Equatable {
    case sending
    case sent
    case delivered
    case failed
}

/// Actor-isolated map of messageId → DeliveryState.
///
/// Transition rules enforce monotonicity so a late-fire callback (e.g. the
/// 12s send watchdog firing after a delayed ack) cannot clobber a good state
/// with `.failed`. See B3/W1 in the Build 24 gate report — without this
/// guard, watchdog races would visibly flap delivered messages back to
/// failed during streaming churn.
public actor DeliveryCore {

    private var states: [String: DeliveryState] = [:]

    public init() {}

    public func arm(messageId: String) {
        states[messageId] = .sending
    }

    public func markSent(messageId: String) {
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

    /// Once delivered, stays delivered. A delayed ack arriving after the
    /// watchdog flipped to .failed is still authoritative — the message
    /// demonstrably reached the server, so the .failed was a false alarm.
    public func markDelivered(messageId: String) {
        states[messageId] = .delivered
    }

    /// Only .sending can transition to .failed. .sent and .delivered are
    /// terminal-positive and refuse the downgrade.
    public func markFailed(messageId: String) {
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

    /// Returns `.sending` for unknown IDs so the UI treats unfamiliar messages
    /// as in-flight rather than failed. Callers that need to distinguish
    /// "never armed" from "armed and pending" should use `snapshot()`.
    public func state(for messageId: String) -> DeliveryState {
        states[messageId] ?? .sending
    }

    public func retryPending() -> [String] {
        states.compactMap { id, state in state == .failed ? id : nil }
    }

    public func clear(messageId: String) {
        states.removeValue(forKey: messageId)
    }

    public func snapshot() -> [String: DeliveryState] {
        states
    }
}
