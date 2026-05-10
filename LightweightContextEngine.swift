//
//  LightweightContextEngine.swift
//  ThunderCommIOS
//
//  Stateless functional engine for inferring outbound message routing in
//  multi-agent channels ("look-above"). No UIKit/SwiftUI dependency so it
//  drops cleanly into a unit-test target.
//
//  Owned by Jon. Pure logic — keep it free of store/view types so the
//  routing decision can be tested without spinning up SwiftUI or the store.
//

import Foundation

// MARK: - Public types

public enum LookAboveResult: Equatable {
    case explicit(agentId: String)
    case inferred(agentId: String, confidence: Double)
    case none
}

public enum RouteDecision: Equatable {
    case direct(agentId: String)
    case broadcast
    case inferred(agentId: String)
}

public enum InferredChannelType: Equatable {
    case direct(agentId: String)
    case channel
}

// MARK: - Minimal message contract

/// The engine reads only the fields it needs. Mack's `Message` adopts this
/// in a one-line extension at the top of MessageListView.swift, which keeps
/// the engine free of the full Message type and lets us test it standalone.
public protocol LookAboveMessage {
    var id: String { get }
    var agentId: String? { get }
    var sender: String? { get }
    var channel: String { get }
}

// MARK: - Engine

public struct LightweightContextEngine {

    /// How far back to scan when inferring a target agent.
    /// Beyond 3 messages the conversation has typically drifted enough that
    /// routing to a stale agent more often surprises than helps.
    public static let lookAboveDepth = 3

    public init() {}

    /// Wire-format channel parsing. `direct:<agentId>` is a DM; anything else
    /// is a multi-agent channel. Kept here (not in ThunderCommModels) so the
    /// engine has zero dependency on Mack's channel type.
    public static func channelType(from channel: String) -> InferredChannelType {
        if channel.hasPrefix("direct:") {
            let agentId = String(channel.dropFirst("direct:".count))
            return .direct(agentId: agentId)
        }
        return .channel
    }

    /// Infer the target agent for a new outbound message in a multi-agent
    /// channel. Returns `.explicit` for DMs (channel IS the target),
    /// `.inferred` if an agent spoke within `lookAboveDepth`, `.none` if
    /// only humans have spoken in that window.
    ///
    /// Edge cases handled:
    ///   - DM channel → `.explicit(agentId)` (channel is the target).
    ///   - Last message was from a human → keep walking up to depth 3.
    ///   - No agent in window → `.none` (composer should broadcast or prompt).
    public static func inferTargetAgent<M: LookAboveMessage>(
        from messages: [M],
        channel: String
    ) -> LookAboveResult {
        if case .direct(let agentId) = channelType(from: channel) {
            return .explicit(agentId: agentId)
        }

        let recent = Array(
            messages
                .filter { $0.channel == channel }
                .suffix(lookAboveDepth)
                .reversed()
        )

        for (offset, message) in recent.enumerated() {
            if let agentId = message.agentId, !agentId.isEmpty {
                // Confidence decays with distance: 1.0 at the immediate
                // previous message, ~0.5 at depth 3. Floored at 0.4 so a
                // valid match never crosses below the "weak signal" line.
                let confidence = max(0.4, 1.0 - Double(offset) * 0.25)
                return .inferred(agentId: agentId, confidence: confidence)
            }
        }
        return .none
    }

    /// Single-call routing decision for the composer. Wraps DM short-circuit
    /// and look-above into one switchable result so callers don't repeat the
    /// channel-type check.
    public static func inferRoute<M: LookAboveMessage>(
        messages: [M],
        currentChannel: String,
        channelType: InferredChannelType
    ) -> RouteDecision {
        switch channelType {
        case .direct(let agentId):
            return .direct(agentId: agentId)
        case .channel:
            switch inferTargetAgent(from: messages, channel: currentChannel) {
            case .explicit(let agentId):
                return .direct(agentId: agentId)
            case .inferred(let agentId, _):
                return .inferred(agentId: agentId)
            case .none:
                return .broadcast
            }
        }
    }
}
