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

struct ThunderCommMessage: Identifiable, Codable, Equatable {
    let id: String
    let channel: String
    let sender: String
    let senderType: ThunderCommSenderType
    let text: String
    let timestamp: Int64
    let originPeer: String?
}

struct FederationAuthPayload: Encodable {
    let type: String = "federation_auth"
    let token: String
    let peerId: String
    let channels: [String]
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
}

struct FederationStatusPayload: Codable {
    let type: String
    let status: String
    let peerId: String?
    let channels: [String]?
    let peers: [String]?
    let reason: String?
}

struct FederationPeersPayload: Codable {
    let type: String
    let peers: [String]
    let models: [String: String]?
}

enum ThunderCommInboundEvent {
    case status(FederationStatusPayload)
    case peers(FederationPeersPayload)
    case message(ThunderCommMessage)
    case unknown(String)
}
