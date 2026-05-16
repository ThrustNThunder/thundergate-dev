import Foundation

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

public protocol LookAboveMessage {
    var id: String { get }
    var agentId: String? { get }
    var sender: String { get }
    var channel: String { get }
}

public struct LightweightContextEngine {
    public static let lookAboveDepth = 3

    public init() {}

    public static func channelType(from channel: String) -> InferredChannelType {
        if channel.hasPrefix("direct:") {
            let agentId = String(channel.dropFirst("direct:".count))
            return .direct(agentId: agentId)
        }
        return .channel
    }

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
            if let agentId = message.agentId?.trimmingCharacters(in: .whitespacesAndNewlines), !agentId.isEmpty {
                let confidence = max(0.4, 1.0 - Double(offset) * 0.25)
                return .inferred(agentId: agentId, confidence: confidence)
            }
        }

        return .none
    }

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
