/**
 * ThunderComm Gateway Service
 * Manages WebSocket connection to ThunderGate server.
 *
 * Key behaviors:
 * - Automatic reconnection with exponential backoff
 * - Message queuing during disconnection
 * - History sync on reconnect
 * - Device ID persistence for multi-device tracking
 *
 * Jon | ThunderBase | 2026-05-05
 */

import Foundation
import Combine

@MainActor
class GatewayService: NSObject, ObservableObject {
    // MARK: - Published State
    
    @Published var connectionStatus: ConnectionStatus = .disconnected
    @Published var agents: [AgentInfo] = []
    @Published var messages: [ConversationMessage] = []
    @Published var pendingActions: [ActionRequestMessage] = []
    @Published var systemEvents: [SystemEventMessage] = []
    @Published var currentlyThinking: Set<String> = [] // agentIds currently thinking
    @Published var streamBuffer: [String: String] = [:] // agentId -> accumulated stream
    
    // MARK: - Configuration
    
    private var gatewayURL: URL?
    private var token: String?
    private let deviceId: String
    
    // MARK: - WebSocket
    
    private var webSocket: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var reconnectAttempts = 0
    private var reconnectTimer: Timer?
    private let maxReconnectAttempts = 10
    private let baseReconnectDelay: TimeInterval = 1.0
    
    // MARK: - Message Queue
    
    private var pendingMessages: [InboundMessage] = []
    private var lastMessageId: String?
    
    // MARK: - Initialization
    
    override init() {
        // Load or generate device ID
        if let savedId = UserDefaults.standard.string(forKey: "thundercomm_device_id") {
            self.deviceId = savedId
        } else {
            let newId = UUID().uuidString
            UserDefaults.standard.set(newId, forKey: "thundercomm_device_id")
            self.deviceId = newId
        }
        
        super.init()
    }
    
    // MARK: - Connection Management
    
    func configure(url: URL, token: String) {
        self.gatewayURL = url
        self.token = token
    }
    
    func connect() {
        guard let baseURL = gatewayURL, let token = token else {
            print("[GatewayService] Not configured — call configure() first")
            return
        }
        
        // Build URL with auth params
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "token", value: token),
            URLQueryItem(name: "deviceId", value: deviceId)
        ]
        
        guard let url = components.url else {
            print("[GatewayService] Failed to build WebSocket URL")
            return
        }
        
        connectionStatus = .connecting
        
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        self.urlSession = session
        
        let ws = session.webSocketTask(with: url)
        self.webSocket = ws
        
        ws.resume()
        receiveMessage()
    }
    
    func disconnect() {
        reconnectTimer?.invalidate()
        reconnectTimer = nil
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        connectionStatus = .disconnected
    }
    
    private func scheduleReconnect() {
        guard reconnectAttempts < maxReconnectAttempts else {
            connectionStatus = .failed
            print("[GatewayService] Max reconnect attempts reached")
            return
        }
        
        connectionStatus = .reconnecting
        
        let delay = baseReconnectDelay * pow(2.0, Double(reconnectAttempts))
        reconnectAttempts += 1
        
        print("[GatewayService] Reconnecting in \(delay)s (attempt \(reconnectAttempts))")
        
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.connect()
            }
        }
    }
    
    // MARK: - Sending Messages
    
    func sendText(_ text: String, channel: ChannelType = .team, agentId: String? = nil) {
        let msg = TextMessage(channel: channel, agentId: agentId, text: text)
        send(.text(msg))
    }
    
    func sendAudio(_ data: Data, channel: ChannelType = .team, agentId: String? = nil) {
        let msg = AudioMessage(channel: channel, agentId: agentId, audioData: data)
        send(.audio(msg))
    }
    
    func respondToAction(_ actionId: String, value: String) {
        let response = ActionResponse(id: actionId, value: value)
        send(.actionResponse(response))
        
        // Remove from pending
        pendingActions.removeAll { $0.id == actionId }
    }
    
    func subscribe() {
        let msg = SubscribeMessage(lastMessageId: lastMessageId)
        send(.subscribe(msg))
    }
    
    private func send(_ message: InboundMessage) {
        guard connectionStatus == .connected else {
            pendingMessages.append(message)
            return
        }
        
        do {
            let data = try JSONEncoder().encode(message)
            let string = String(data: data, encoding: .utf8)!
            
            webSocket?.send(.string(string)) { [weak self] error in
                if let error = error {
                    print("[GatewayService] Send error: \(error)")
                    Task { @MainActor in
                        self?.pendingMessages.append(message)
                    }
                }
            }
        } catch {
            print("[GatewayService] Encode error: \(error)")
        }
    }
    
    private func flushPendingMessages() {
        let pending = pendingMessages
        pendingMessages = []
        for msg in pending {
            send(msg)
        }
    }
    
    // MARK: - Receiving Messages
    
    private func receiveMessage() {
        webSocket?.receive { [weak self] result in
            Task { @MainActor in
                switch result {
                case .success(let message):
                    self?.handleMessage(message)
                    self?.receiveMessage() // Continue receiving
                    
                case .failure(let error):
                    print("[GatewayService] Receive error: \(error)")
                    self?.handleDisconnection()
                }
            }
        }
    }
    
    private func handleMessage(_ message: URLSessionWebSocketTask.Message) {
        switch message {
        case .string(let text):
            parseAndHandle(text)
        case .data(let data):
            if let text = String(data: data, encoding: .utf8) {
                parseAndHandle(text)
            }
        @unknown default:
            break
        }
    }
    
    private func parseAndHandle(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }
        
        do {
            let msg = try JSONDecoder().decode(OutboundMessage.self, from: data)
            handleOutboundMessage(msg)
        } catch {
            print("[GatewayService] Parse error: \(error)")
            print("[GatewayService] Raw message: \(text.prefix(200))")
        }
    }
    
    private func handleOutboundMessage(_ msg: OutboundMessage) {
        switch msg {
        case .message(let conversationMsg):
            messages.append(conversationMsg)
            lastMessageId = conversationMsg.id
            currentlyThinking.remove(conversationMsg.agentId)
            streamBuffer.removeValue(forKey: conversationMsg.agentId)
            
        case .thinking(let thinkingMsg):
            currentlyThinking.insert(thinkingMsg.agentId)
            
        case .stream(let streamMsg):
            let existing = streamBuffer[streamMsg.agentId] ?? ""
            streamBuffer[streamMsg.agentId] = existing + streamMsg.delta
            
        case .audio(let audioMsg):
            // TODO: Play audio
            print("[GatewayService] Received audio from \(audioMsg.agentId)")
            
        case .systemEvent(let event):
            systemEvents.append(event)
            
        case .artifact(let artifact):
            // TODO: Handle artifact display
            print("[GatewayService] Received artifact: \(artifact.title)")
            
        case .actionRequest(let action):
            pendingActions.append(action)
            
        case .roster(let roster):
            agents = roster.agents
            
        case .ack(let ack):
            // Message acknowledged — could update UI if needed
            print("[GatewayService] Ack: \(ack.idempotencyKey)")
            
        case .history(let history):
            // Prepend history (older messages first)
            messages = history.messages + messages
            if let first = history.messages.first {
                lastMessageId = first.id
            }
            
        case .status(let status):
            if status.gateway == .connected {
                connectionStatus = .connected
                reconnectAttempts = 0
                flushPendingMessages()
            }
            
        case .githubFile(let file):
            print("[GatewayService] GitHub file: \(file.repo)/\(file.path)")
            
        case .githubEvent(let event):
            print("[GatewayService] GitHub event: \(event.event) on \(event.repo)")
            
        case .githubAck(let ack):
            print("[GatewayService] GitHub ack: \(ack.path)")
            
        case .error(let error):
            print("[GatewayService] Error: \(error.code) - \(error.message)")
            if error.code == .authFailed {
                disconnect()
                connectionStatus = .authFailed
            }
        }
    }
    
    private func handleDisconnection() {
        webSocket = nil
        if connectionStatus != .disconnected {
            scheduleReconnect()
        }
    }
}

// MARK: - URLSessionWebSocketDelegate

extension GatewayService: URLSessionWebSocketDelegate {
    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        Task { @MainActor in
            print("[GatewayService] Connected")
            connectionStatus = .connected
            reconnectAttempts = 0
            subscribe()
            flushPendingMessages()
        }
    }
    
    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        Task { @MainActor in
            print("[GatewayService] Disconnected: \(closeCode)")
            handleDisconnection()
        }
    }
}

// MARK: - Connection Status

enum ConnectionStatus {
    case disconnected
    case connecting
    case connected
    case reconnecting
    case authFailed
    case failed
    
    var displayText: String {
        switch self {
        case .disconnected: return "Disconnected"
        case .connecting: return "Connecting..."
        case .connected: return "Connected"
        case .reconnecting: return "Reconnecting..."
        case .authFailed: return "Auth Failed"
        case .failed: return "Connection Failed"
        }
    }
    
    var color: String {
        switch self {
        case .connected: return "green"
        case .connecting, .reconnecting: return "yellow"
        case .disconnected, .authFailed, .failed: return "red"
        }
    }
}
