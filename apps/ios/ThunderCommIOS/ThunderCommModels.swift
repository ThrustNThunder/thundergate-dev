
import Foundation

enum ThunderCommConnectionState: Equatable {
    case disconnected
    case connecting
    case authenticating
    case connected
    case reconnecting(delaySeconds: Double)
    case failed(String)
}

enum ThunderCommSenderType: String, Codable {
    case human
    case agent
}

enum ThunderCommContentKind: String, Codable {
    case text
    case audio
    case file
}

enum ThunderCommDeliveryState: String, Codable {
    case sending
    case sent
    case delivered
    case failed
}

enum ThunderCommRoute: String, CaseIterable, Identifiable {
    case tnt
    case jmab
    case channel
    case direct

    var id: String { rawValue }
}

struct ThunderCommAttachmentMetadata: Codable, Equatable {
    let fileName: String
    let mimeType: String
    let remoteURL: String?
}

enum ThunderCommParticipantIdentity {
    static func senderType(sender: String? = nil, agentId: String? = nil, participantId: String? = nil, explicitRawValue: String? = nil) -> ThunderCommSenderType {
        if let explicitRawValue,
           let explicit = ThunderCommSenderType(rawValue: explicitRawValue.lowercased()) {
            return explicit
        }

        let canonical = canonicalID(sender: sender, agentId: agentId, participantId: participantId, senderType: nil)
        switch canonical {
        case "michael", "alex":
            return .human
        case "jon", "mack", "rex", "burt", "sasha", "system":
            return .agent
        default:
            return agentId?.thunderCommTrimmed == nil ? .human : .agent
        }
    }

    static func canonicalID(sender: String? = nil, agentId: String? = nil, participantId: String? = nil, senderType: ThunderCommSenderType? = nil) -> String {
        let candidates: [String?]
        switch senderType {
        case .human:
            candidates = [participantId, sender, agentId]
        case .agent:
            candidates = [agentId, participantId, sender]
        case nil:
            candidates = [agentId, participantId, sender]
        }

        for candidate in candidates {
            if let mapped = mappedCanonicalID(for: candidate) {
                return mapped
            }
        }

        if let senderType {
            return senderType == .agent ? "agent" : "human"
        }

        return agentId?.thunderCommTrimmed == nil ? "human" : "agent"
    }

    static func displayName(sender: String? = nil, agentId: String? = nil, participantId: String? = nil, senderType: ThunderCommSenderType? = nil) -> String {
        if let sender = cleanedSenderName(sender, agentId: agentId), !sender.isEmpty {
            if let mapped = mappedDisplayName(for: sender) {
                return mapped
            }
            return sender
        }

        for candidate in [agentId, participantId] {
            if let mapped = mappedDisplayName(for: candidate) {
                return mapped
            }
        }

        let resolvedType = senderType ?? self.senderType(sender: sender, agentId: agentId, participantId: participantId, explicitRawValue: nil)
        return resolvedType == .agent ? "Agent" : "Human"
    }

    private static func cleanedSenderName(_ sender: String?, agentId: String?) -> String? {
        guard var sender = sender?.thunderCommTrimmed else { return nil }
        if let agentId = agentId?.thunderCommTrimmed {
            let lowerSender = sender.lowercased()
            let duplicateSuffix = " (\(agentId.lowercased()))"
            if lowerSender.hasSuffix(duplicateSuffix) {
                sender = String(sender.dropLast(duplicateSuffix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if lowerSender == agentId.lowercased(), let mapped = mappedDisplayName(for: agentId) {
                return mapped
            }
        }
        return sender.thunderCommTrimmed
    }

    private static func mappedCanonicalID(for value: String?) -> String? {
        guard let token = normalizedToken(value) else { return nil }
        switch token {
        case "jon", "thunderbase", "thunderbase-jon":
            return "jon"
        case "mack", "mac-mack", "macmack":
            return "mack"
        case "michael":
            return "michael"
        case "alex":
            return "alex"
        case "burt", "alex-bridge", "alexbridge":
            return "burt"
        case "rex":
            return "rex"
        case "sasha":
            return "sasha"
        case "system":
            return "system"
        case let token where token.hasPrefix("thunderbase-"):
            return mappedCanonicalID(for: String(token.dropFirst("thunderbase-".count)))
        case let token where token.hasPrefix("mac-mack"):
            return "mack"
        case let token where token.hasPrefix("ios-"):
            // Generic device-prefixed identity: ios-<userKey>-<uuid>.
            // Strip the prefix, take the userKey segment, fall back to the
            // raw segment if it's not in the known table so non-Michael
            // accounts surface as themselves rather than collapsing to one
            // of us.
            let stripped = String(token.dropFirst("ios-".count))
            let segment = stripped.components(separatedBy: "-").first ?? stripped
            if segment.isEmpty { return nil }
            return mappedCanonicalID(for: segment) ?? segment
        default:
            return nil
        }
    }

    private static func mappedDisplayName(for value: String?) -> String? {
        guard let canonical = mappedCanonicalID(for: value) else { return nil }
        switch canonical {
        case "jon": return "Jon"
        case "mack": return "Mack"
        case "michael": return "Michael"
        case "alex": return "Alex"
        case "burt": return "Burt"
        case "rex": return "Rex"
        case "sasha": return "Sasha"
        case "system": return "System"
        default:
            // Unknown but stable canonical (e.g. a custom signed-in user).
            // Title-case it so they show up as a name, not "Human".
            guard let first = canonical.first else { return nil }
            return first.uppercased() + canonical.dropFirst()
        }
    }

    private static func normalizedToken(_ value: String?) -> String? {
        value?
            .thunderCommTrimmed?
            .lowercased()
            .replacingOccurrences(of: "_", with: "-")
            .replacingOccurrences(of: " ", with: "-")
    }
}

struct ThunderCommMessage: Identifiable, Codable, Equatable {
    let id: String
    let channel: String
    let sender: String
    let senderType: ThunderCommSenderType
    let agentId: String?
    let text: String
    let timestamp: Int64
    let originPeer: String?
    let relayedAt: Int64?
    let relayedBy: String?
    let contentKind: ThunderCommContentKind?
    let attachment: ThunderCommAttachmentMetadata?

    init(
        id: String,
        channel: String,
        sender: String,
        senderType: ThunderCommSenderType,
        agentId: String?,
        text: String,
        timestamp: Int64,
        originPeer: String?,
        relayedAt: Int64?,
        relayedBy: String?,
        contentKind: ThunderCommContentKind?,
        attachment: ThunderCommAttachmentMetadata?
    ) {
        self.id = id
        self.channel = channel
        self.sender = sender
        self.senderType = senderType
        self.agentId = agentId
        self.text = text
        self.timestamp = timestamp
        self.originPeer = originPeer
        self.relayedAt = relayedAt
        self.relayedBy = relayedBy
        self.contentKind = contentKind
        self.attachment = attachment
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case channel
        case sender
        case senderType
        case agentId
        case text
        case timestamp
        case originPeer
        case relayedAt
        case relayedBy
        case contentKind
        case attachment
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let agentId = try container.decodeIfPresent(String.self, forKey: .agentId)?.thunderCommTrimmed
        let rawSender = try container.decodeIfPresent(String.self, forKey: .sender)?.thunderCommTrimmed
        let senderType = ThunderCommParticipantIdentity.senderType(
            sender: rawSender,
            agentId: agentId,
            participantId: nil,
            explicitRawValue: try container.decodeIfPresent(String.self, forKey: .senderType)
        )

        self.id = try container.decodeIfPresent(String.self, forKey: .id)?.thunderCommTrimmed ?? UUID().uuidString
        self.channel = try container.decodeIfPresent(String.self, forKey: .channel)?.thunderCommTrimmed ?? "tnt"
        self.sender = ThunderCommParticipantIdentity.displayName(sender: rawSender, agentId: agentId, participantId: nil, senderType: senderType)
        self.senderType = senderType
        self.agentId = agentId
        self.text = try container.decodeIfPresent(String.self, forKey: .text)?.thunderCommTrimmed ?? ""
        self.timestamp = try container.decodeIfPresent(Int64.self, forKey: .timestamp) ?? Int64(Date().timeIntervalSince1970 * 1000)
        self.originPeer = try container.decodeIfPresent(String.self, forKey: .originPeer)?.thunderCommTrimmed
        self.relayedAt = try container.decodeIfPresent(Int64.self, forKey: .relayedAt)
        self.relayedBy = try container.decodeIfPresent(String.self, forKey: .relayedBy)?.thunderCommTrimmed
        self.contentKind = try container.decodeIfPresent(ThunderCommContentKind.self, forKey: .contentKind)
        self.attachment = try container.decodeIfPresent(ThunderCommAttachmentMetadata.self, forKey: .attachment)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(channel, forKey: .channel)
        try container.encode(sender, forKey: .sender)
        try container.encode(senderType, forKey: .senderType)
        try container.encodeIfPresent(agentId, forKey: .agentId)
        try container.encode(text, forKey: .text)
        try container.encode(timestamp, forKey: .timestamp)
        try container.encodeIfPresent(originPeer, forKey: .originPeer)
        try container.encodeIfPresent(relayedAt, forKey: .relayedAt)
        try container.encodeIfPresent(relayedBy, forKey: .relayedBy)
        try container.encodeIfPresent(contentKind, forKey: .contentKind)
        try container.encodeIfPresent(attachment, forKey: .attachment)
    }

    // Bridge from DeliveryCore's wire-level InboxMessage into the rich store
    // shape. ThunderCommStore.merge(_:) re-runs normalize on these, so the
    // display name / canonical agentId here are best-effort — merge fixes them.
    // Channel defaults to "tnt"; routed-direct delivery can override later.
    init(from inbox: InboxMessage) {
        let derivedSenderType = ThunderCommParticipantIdentity.senderType(
            sender: inbox.from,
            agentId: nil,
            participantId: nil,
            explicitRawValue: nil
        )
        let canonical = ThunderCommParticipantIdentity.canonicalID(
            sender: inbox.from,
            agentId: nil,
            participantId: nil,
            senderType: derivedSenderType
        )
        let derivedAgentId: String? = derivedSenderType == .agent ? canonical : nil
        let kind = ThunderCommContentKind(rawValue: inbox.kind ?? "") ?? .text

        self.init(
            id: inbox.id,
            channel: "tnt",
            sender: inbox.from,
            senderType: derivedSenderType,
            agentId: derivedAgentId,
            text: inbox.body,
            timestamp: inbox.createdAtMs,
            originPeer: inbox.from,
            relayedAt: nil,
            relayedBy: nil,
            contentKind: kind,
            attachment: nil
        )
    }
}

struct FederationAuthPayload: Encodable {
    let type: String = "federation_auth"
    let token: String
    let peerId: String
    let channels: [String]
    let model: String? = nil
    // Single replay floor for the subscribed bundle. We intentionally use the
    // oldest known channel timestamp when subscribing to multiple channels so
    // a busy room like #tnt cannot suppress replay for a quieter DM thread.
    // This may allow some duplicate replay on reconnect, but merge() de-dupes
    // by message id and correctness matters more than shaving a few repeats.
    let afterTimestamp: Int64?
}

struct FederationMessagePayload: Encodable {
    let type: String = "federation_message"
    let channel: String
    let sender: String
    let senderType: String
    let text: String
    let timestamp: Int64
    let originPeer: String
    let id: String
    let agentId: String?
    let idempotencyKey: String?
}

struct ThunderCommTypingOutboundPayload: Encodable {
    let type: String = "typing"
    let participantId: String
    let senderType: String
    let typing: Bool
    let channel: String
    let timestamp: Int64
    let agentId: String?
}

struct ThunderCommHistoryRequestPayload: Encodable {
    let type: String = "subscribe"
    let channel: String
    let limit: Int
    let lastMessageId: String? = nil
    // See FederationAuthPayload.afterTimestamp — same semantics.
    let afterTimestamp: Int64?
}

struct ThunderCommTypingPayload: Codable, Equatable {
    let type: String
    let participantId: String?
    let agentId: String?
    let senderType: String?
    let typing: Bool
    let channel: String?
    let timestamp: Int64?
}

struct ThunderCommThinkingPayload: Codable, Equatable {
    let type: String
    let agentId: String?
    let participantId: String?
    let channel: String?
    let timestamp: Int64?
    let thinking: String?
    let model: String?
}

struct ThunderCommStreamPayload: Codable, Equatable {
    let type: String
    let agentId: String?
    let participantId: String?
    let channel: String?
    let delta: String
    let timestamp: Int64?
}

struct ThunderCommAckPayload: Codable, Equatable {
    let type: String
    let idempotencyKey: String?
    let messageId: String?
}

struct ThunderCommSystemEventPayload: Codable, Equatable {
    let type: String
    let text: String
    let channel: String?
    let timestamp: Int64?
}

struct ThunderCommErrorPayload: Codable, Equatable {
    let type: String
    let code: String?
    let message: String
}

struct ThunderCommParticipant: Identifiable, Codable, Equatable {
    let id: String
    let name: String
    let status: String
    let role: String?
    let model: String?
}

struct FederationStatusPayload: Codable {
    let type: String
    let status: String?
    let peerId: String?
    let channels: [String]?
    let peers: [String]?
    let reason: String?
    let gateway: String?
    let sessionWarm: Bool?
    let model: String?
    let thinking: String?
}

struct FederationPeersPayload: Codable {
    let type: String
    let peers: [String]
    let models: [String: String]?
}

struct ThunderCommRosterPayload: Codable {
    let type: String
    let agents: [ThunderCommParticipant]
}

struct ThunderCommHistoryPayload: Codable {
    let type: String
    let messages: [ThunderCommMessage]
    let hasMore: Bool?
}

enum ThunderCommPresenceStatus {
    case online
    case busy
    case offline
}

struct ThunderCommActivityIndicator: Identifiable, Equatable {
    let id: String
    let displayName: String
    let senderType: ThunderCommSenderType
    let channel: String
    let updatedAt: Int64
}

struct ThunderCommStreamingPreview: Identifiable, Equatable {
    let id: String
    let displayName: String
    let senderType: ThunderCommSenderType
    let channel: String
    let text: String
    let updatedAt: Int64
}

enum ThunderCommInboundEvent {
    case status(FederationStatusPayload)
    case peers(FederationPeersPayload)
    case roster(ThunderCommRosterPayload)
    case history(ThunderCommHistoryPayload)
    case message(ThunderCommMessage)
    case typing(ThunderCommTypingPayload)
    case thinking(ThunderCommThinkingPayload)
    case stream(ThunderCommStreamPayload)
    case ack(ThunderCommAckPayload)
    case systemEvent(ThunderCommSystemEventPayload)
    case error(ThunderCommErrorPayload)
    case unknown(String)
}

enum ThunderCommIdentity {
    private static let peerIdKey = "ThunderComm.peerId"
    private static let peerIdUserKey = "ThunderComm.peerIdUserKey"

    /// Returns a stable peerId for the current device, scoped to the signed-in
    /// user's normalized key. If the userKey changes (account switch on the
    /// same device), a fresh peerId is minted so the new account doesn't
    /// inherit the old one's identity.
    static func loadOrCreatePeerId(forUserKey userKey: String? = nil) -> String {
        let defaults = UserDefaults.standard
        let resolved = sanitize(userKey) ?? "anon"
        let storedKey = defaults.string(forKey: peerIdUserKey)
        if storedKey == resolved,
           let existing = defaults.string(forKey: peerIdKey),
           !existing.isEmpty {
            return existing
        }
        let created = "ios-\(resolved)-\(UUID().uuidString.lowercased())"
        defaults.set(created, forKey: peerIdKey)
        defaults.set(resolved, forKey: peerIdUserKey)
        return created
    }

    private static func sanitize(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        let cleaned = value.lowercased().filter { $0.isLetter || $0.isNumber }
        return cleaned.isEmpty ? nil : cleaned
    }
}

private extension String {
    var thunderCommTrimmed: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
