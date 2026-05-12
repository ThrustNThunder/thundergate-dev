/**
 * ThunderComm Message Models
 * Wire protocol types matching thundergate/extensions/thundercomm/src/types.ts
 *
 * Jon | ThunderBase | 2026-05-05
 */

import Foundation

// MARK: - Inbound Messages (App → Gateway)

enum InboundMessage: Encodable {
    case text(TextMessage)
    case audio(AudioMessage)
    case subscribe(SubscribeMessage)
    case actionResponse(ActionResponse)
    case githubPush(GitHubPushMessage)
    case githubFetch(GitHubFetchMessage)
    
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .text(let msg): try container.encode(msg)
        case .audio(let msg): try container.encode(msg)
        case .subscribe(let msg): try container.encode(msg)
        case .actionResponse(let msg): try container.encode(msg)
        case .githubPush(let msg): try container.encode(msg)
        case .githubFetch(let msg): try container.encode(msg)
        }
    }
}

struct TextMessage: Codable {
    let type = "message"
    let channel: ChannelType
    var agentId: String?
    let text: String
    let idempotencyKey: String
    
    init(channel: ChannelType, agentId: String? = nil, text: String) {
        self.channel = channel
        self.agentId = agentId
        self.text = text
        self.idempotencyKey = UUID().uuidString
    }
}

struct AudioMessage: Codable {
    let type = "audio"
    let channel: ChannelType
    var agentId: String?
    let data: String // base64-encoded
    let idempotencyKey: String
    
    init(channel: ChannelType, agentId: String? = nil, audioData: Data) {
        self.channel = channel
        self.agentId = agentId
        self.data = audioData.base64EncodedString()
        self.idempotencyKey = UUID().uuidString
    }
}

struct SubscribeMessage: Codable {
    let type = "subscribe"
    let lastMessageId: String?
    
    init(lastMessageId: String? = nil) {
        self.lastMessageId = lastMessageId
    }
}

struct ActionResponse: Codable {
    let type = "action_response"
    let id: String
    let value: String
    let idempotencyKey: String
    
    init(id: String, value: String) {
        self.id = id
        self.value = value
        self.idempotencyKey = UUID().uuidString
    }
}

struct GitHubPushMessage: Codable {
    let type = "github_push"
    let repo: String
    let path: String
    let content: String // base64-encoded
    let message: String
    let idempotencyKey: String
}

struct GitHubFetchMessage: Codable {
    let type = "github_fetch"
    let repo: String
    let path: String
    var ref: String?
}

// MARK: - Outbound Messages (Gateway → App)

enum OutboundMessage: Decodable {
    case message(ConversationMessage)
    case thinking(ThinkingMessage)
    case stream(StreamMessage)
    case audio(AudioResponseMessage)
    case systemEvent(SystemEventMessage)
    case artifact(ArtifactMessage)
    case actionRequest(ActionRequestMessage)
    case roster(RosterMessage)
    case ack(AckMessage)
    case history(HistoryMessage)
    case status(StatusMessage)
    case githubFile(GitHubFileMessage)
    case githubEvent(GitHubEventMessage)
    case githubAck(GitHubAckMessage)
    case error(ErrorMessage)
    
    private enum CodingKeys: String, CodingKey {
        case type
    }
    
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        
        let singleContainer = try decoder.singleValueContainer()
        
        switch type {
        case "message":
            self = .message(try singleContainer.decode(ConversationMessage.self))
        case "thinking":
            self = .thinking(try singleContainer.decode(ThinkingMessage.self))
        case "stream":
            self = .stream(try singleContainer.decode(StreamMessage.self))
        case "audio":
            self = .audio(try singleContainer.decode(AudioResponseMessage.self))
        case "system_event":
            self = .systemEvent(try singleContainer.decode(SystemEventMessage.self))
        case "artifact":
            self = .artifact(try singleContainer.decode(ArtifactMessage.self))
        case "action_request":
            self = .actionRequest(try singleContainer.decode(ActionRequestMessage.self))
        case "roster":
            self = .roster(try singleContainer.decode(RosterMessage.self))
        case "ack":
            self = .ack(try singleContainer.decode(AckMessage.self))
        case "history":
            self = .history(try singleContainer.decode(HistoryMessage.self))
        case "status":
            self = .status(try singleContainer.decode(StatusMessage.self))
        case "github_file":
            self = .githubFile(try singleContainer.decode(GitHubFileMessage.self))
        case "github_event":
            self = .githubEvent(try singleContainer.decode(GitHubEventMessage.self))
        case "github_ack":
            self = .githubAck(try singleContainer.decode(GitHubAckMessage.self))
        case "error":
            self = .error(try singleContainer.decode(ErrorMessage.self))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown message type: \(type)"
            )
        }
    }
}

// MARK: - Conversation Messages

struct ConversationMessage: Codable, Identifiable, Equatable {
    let type: String
    let id: String
    let agentId: String
    let channel: ChannelType
    let text: String
    let timestamp: TimeInterval
    
    var date: Date {
        Date(timeIntervalSince1970: timestamp / 1000)
    }
}

struct ThinkingMessage: Codable {
    let type: String
    let agentId: String
}

struct StreamMessage: Codable {
    let type: String
    let agentId: String
    let delta: String
}

struct AudioResponseMessage: Codable {
    let type: String
    let agentId: String
    let url: String
    let duration: Double
}

// MARK: - System Events

struct SystemEventMessage: Codable, Identifiable {
    let type: String
    let category: SystemEventCategory
    let text: String
    let timestamp: TimeInterval
    
    var id: TimeInterval { timestamp }
    
    var date: Date {
        Date(timeIntervalSince1970: timestamp / 1000)
    }
}

enum SystemEventCategory: String, Codable {
    case github
    case failover
    case scribe
    case gateway
    case beekeeper
}

// MARK: - Artifacts

struct ArtifactMessage: Codable, Identifiable {
    let type: String
    let kind: ArtifactKind
    let title: String
    let source: String
    let content: String // base64-encoded
    var sha: String?
    let timestamp: TimeInterval
    
    var id: TimeInterval { timestamp }
    
    var decodedContent: Data? {
        Data(base64Encoded: content)
    }
}

enum ArtifactKind: String, Codable {
    case githubFile = "github_file"
    case memoryEntry = "memory_entry"
    case specDoc = "spec_doc"
}

// MARK: - Action Requests

struct ActionRequestMessage: Codable, Identifiable {
    let type: String
    let id: String
    let agentId: String
    let description: String
    let actions: [ActionOption]
    var context: String?
    let timestamp: TimeInterval
}

struct ActionOption: Codable {
    let label: String
    let value: String
}

// MARK: - Infrastructure

struct RosterMessage: Codable {
    let type: String
    let agents: [AgentInfo]
}

struct AgentInfo: Codable, Identifiable {
    let id: String
    let name: String
    let status: AgentStatus
    var role: String?
}

enum AgentStatus: String, Codable {
    case online
    case offline
    case busy
}

struct AckMessage: Codable {
    let type: String
    let idempotencyKey: String
    let messageId: String
}

struct HistoryMessage: Codable {
    let type: String
    let messages: [ConversationMessage]
    let hasMore: Bool
}

struct StatusMessage: Codable {
    let type: String
    let gateway: GatewayStatus
    let sessionWarm: Bool
}

enum GatewayStatus: String, Codable {
    case connected
    case reconnecting
    case offline
}

// MARK: - GitHub

struct GitHubFileMessage: Codable {
    let type: String
    let repo: String
    let path: String
    let content: String
    let sha: String
    let timestamp: TimeInterval
}

struct GitHubEventMessage: Codable, Identifiable {
    let type: String
    let repo: String
    let event: GitHubEventType
    let author: String
    let message: String
    let files: [String]
    let timestamp: TimeInterval
    
    var id: TimeInterval { timestamp }
}

enum GitHubEventType: String, Codable {
    case push
    case pr
    case comment
}

struct GitHubAckMessage: Codable {
    let type: String
    let repo: String
    let path: String
    let sha: String
    let idempotencyKey: String
}

// MARK: - Errors

struct ErrorMessage: Codable {
    let type: String
    let code: ErrorCode
    let message: String
}

enum ErrorCode: String, Codable {
    case authFailed = "AUTH_FAILED"
    case rateLimited = "RATE_LIMITED"
    case invalidMessage = "INVALID_MESSAGE"
    case repoNotAllowed = "REPO_NOT_ALLOWED"
    case conflict = "CONFLICT"
}

// MARK: - Common Types

enum ChannelType: String, Codable {
    case team
    case direct
}
