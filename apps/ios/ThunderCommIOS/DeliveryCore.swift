// DeliveryCore.swift
//
// Unified delivery system for ThunderCommo.
//
// Three components, one file:
//   1. WebSocketManager — foreground-only live socket (actor-isolated)
//   2. InboxAPI         — HTTP source of truth (drain + ack + send)
//   3. OutboxQueue      — UserDefaults-backed pending sends (actor-isolated)
//
// See CORE_DELIVERY.md for the model. The short version:
//   - WS is a foreground optimization, never a source of truth.
//   - On every .active transition: drain inbox first, then connect WS.
//   - On .background: tear down WS deliberately.
//   - lastDrainAt is persisted; everything resumes from it.
//
// Hardening (Session 3):
//   - WebSocketManager is an actor; URLSession callbacks hop in via a
//     small NSObject delegate adapter.
//   - 30s ping heartbeat detects dead sockets that never get a TCP RST.
//   - WS recv-error and ping-failure trigger reconnect while active.
//   - NWPathMonitor reconnects when network returns mid-foreground.
//   - Inbox drain pages with ?limit=50&offset=… until exhausted.
//   - inbound array capped at 200 (FIFO eviction).
//   - flushOutbox is single-flighted; outbox items poisoned after 10 attempts.
//   - InboxAPI/OutboxQueue are actors so cross-context calls are explicit.
//
// Wire-protocol parity (Session 4):
//   - WebSocket frames are decoded into a `WireMessage` discriminated enum so
//     stream / stream_end / thinking / roster / history / status / system /
//     error frames are handled instead of silently dropped.
//   - @Published roster, streamingMessage, isThinking, gatewayStatus,
//     isRelayConnected expose state to the UI layer.
//   - Persistent FIFO seen-ids store (`tg.seenIds`, cap 500) survives launches
//     so a redelivered drain or replayed history can't double-append.

import Foundation
import SwiftUI
import Combine
import Network

// MARK: - Wire types

public struct InboxMessage: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let from: String
    public let to: String
    public let body: String
    public let createdAtMs: Int64
    public let kind: String?     // "text", "memo", "system", ...

    // Server uses sender/content/timestamp; we keep iOS-side names but
    // remap on the wire.
    enum CodingKeys: String, CodingKey {
        case id, to, kind
        case from = "sender"
        case body = "content"
        case createdAtMs = "timestamp"
    }
}

// Server returns {messages:[...], count, serverTime} from /api/inbox.
private struct InboxResponse: Decodable {
    let messages: [InboxMessage]
}

public struct RosterAgent: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let emoji: String?
    public let model: String?
    public let role: String?     // "agent" or "human"
    public let status: String?
}

public struct StreamingMessage: Equatable, Sendable {
    public let id: String
    public let agentId: String
    public var text: String
}

// Discriminated wire envelope. The relay multiplexes several frame types over a
// single WebSocket; switching on `type` lets us route each one rather than
// silently dropping everything that isn't an InboxMessage.
public enum WireMessage: Decodable, Sendable {
    case inboxMessage(InboxMessage)                        // type: "message"
    case stream(agentId: String, delta: String, id: String)// type: "stream"
    case streamEnd(agentId: String, id: String)            // type: "stream_end"
    case thinking(agentId: String)                         // type: "thinking"
    case roster([RosterAgent])                             // type: "roster"
    case history([InboxMessage])                           // type: "history"
    case status(gateway: String, model: String?)           // type: "status"
    case systemMessage(text: String)                       // type: "system"
    case error(code: String, message: String?)             // type: "error"
    case unknown

    private enum CodingKeys: String, CodingKey {
        case type, delta, agentId, id, agents, messages
        case gateway, model, text, code, message
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = (try? c.decode(String.self, forKey: .type)) ?? ""
        switch type {
        case "message":
            self = .inboxMessage(try InboxMessage(from: decoder))
        case "stream":
            let agentId = (try? c.decode(String.self, forKey: .agentId)) ?? ""
            let delta   = (try? c.decode(String.self, forKey: .delta))   ?? ""
            let id      = (try? c.decode(String.self, forKey: .id))      ?? ""
            self = .stream(agentId: agentId, delta: delta, id: id)
        case "stream_end":
            let agentId = (try? c.decode(String.self, forKey: .agentId)) ?? ""
            let id      = (try? c.decode(String.self, forKey: .id))      ?? ""
            self = .streamEnd(agentId: agentId, id: id)
        case "thinking":
            let agentId = (try? c.decode(String.self, forKey: .agentId)) ?? ""
            self = .thinking(agentId: agentId)
        case "roster":
            let agents = (try? c.decode([RosterAgent].self, forKey: .agents)) ?? []
            self = .roster(agents)
        case "history":
            let msgs = (try? c.decode([InboxMessage].self, forKey: .messages)) ?? []
            self = .history(msgs)
        case "status":
            let gateway = (try? c.decode(String.self, forKey: .gateway)) ?? ""
            let model   = try? c.decode(String.self, forKey: .model)
            self = .status(gateway: gateway, model: model)
        case "system":
            let text = (try? c.decode(String.self, forKey: .text)) ?? ""
            self = .systemMessage(text: text)
        case "error":
            let code    = (try? c.decode(String.self, forKey: .code))    ?? ""
            let message = try? c.decode(String.self, forKey: .message)
            self = .error(code: code, message: message)
        default:
            // Tolerate legacy bare-InboxMessage frames (no `type` field) so
            // older relays still deliver into `.inboxMessage`.
            if let inbox = try? InboxMessage(from: decoder) {
                self = .inboxMessage(inbox)
            } else {
                self = .unknown
            }
        }
    }
}

public struct OutboxItem: Codable, Identifiable, Equatable, Sendable {

    public enum Status: String, Codable, Sendable {
        case pending
        case failed
    }

    public let id: String        // client-side UUID, used for idempotency
    public let to: String
    public let body: String
    public let kind: String
    public let queuedAtMs: Int64
    public var attempts: Int
    public var status: Status

    public init(
        id: String,
        to: String,
        body: String,
        kind: String,
        queuedAtMs: Int64,
        attempts: Int = 0,
        status: Status = .pending
    ) {
        self.id = id
        self.to = to
        self.body = body
        self.kind = kind
        self.queuedAtMs = queuedAtMs
        self.attempts = attempts
        self.status = status
    }

    private enum CodingKeys: String, CodingKey {
        case id, to, body, kind, queuedAtMs, attempts, status
    }

    // Custom decode tolerates pre-Session-3 persisted items that lack `status`.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.to = try c.decode(String.self, forKey: .to)
        self.body = try c.decode(String.self, forKey: .body)
        self.kind = try c.decode(String.self, forKey: .kind)
        self.queuedAtMs = try c.decode(Int64.self, forKey: .queuedAtMs)
        self.attempts = try c.decode(Int.self, forKey: .attempts)
        self.status = try c.decodeIfPresent(Status.self, forKey: .status) ?? .pending
    }
}

// MARK: - DeliveryCore (the public surface)

@MainActor
public final class DeliveryCore: ObservableObject {

    public static let shared = DeliveryCore()

    public static let inboundCap = 200
    public static let maxOutboxAttempts = 10
    public static let seenIdsCap = 500
    private static let thinkingTimeoutNs: UInt64 = 30 * 1_000_000_000

    @Published public private(set) var isWSConnected: Bool = false
    @Published public private(set) var isRelayConnected: Bool = false
    @Published public private(set) var lastDrainAt: Int64 = 0
    @Published public private(set) var inbound: [InboxMessage] = []
    @Published public private(set) var roster: [RosterAgent] = []
    @Published public private(set) var streamingMessage: StreamingMessage? = nil
    @Published public private(set) var isThinking: Bool = false
    @Published public private(set) var thinkingAgentId: String? = nil
    @Published public private(set) var gatewayStatus: String = ""
    @Published public private(set) var modelName: String? = nil

    private var ws: WebSocketManager?
    private let api = InboxAPI()
    private let outbox = OutboxQueue()

    private var sceneIsActive: Bool = false
    private var isFlushingOutbox: Bool = false
    private var lastPathSatisfied: Bool = true
    private var thinkingClearTask: Task<Void, Never>?

    // Ordered FIFO of message ids we've already routed to `inbound`. Capped at
    // `seenIdsCap` and persisted across launches so a redelivered drain or WS
    // history frame can't double-append after a cold start.
    private var seenIds: [String] = []
    private var seenIdsSet: Set<String> = []

    private let pathMonitor = NWPathMonitor()
    private let pathMonitorQueue = DispatchQueue(label: "thunder.delivery.path", qos: .utility)

    private static let lastDrainKey = "thunder.delivery.lastDrainAt"
    private static let seenIdsKey = "tg.seenIds"

    public init() {
        self.lastDrainAt = Int64(UserDefaults.standard.integer(forKey: Self.lastDrainKey))
        loadSeenIds()
        startPathMonitor()
    }

    // Called from the SwiftUI scenePhase observer in the App root.
    public func handleScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .active:
            sceneIsActive = true
            Task { await onForeground() }
        case .background, .inactive:
            sceneIsActive = false
            disconnectWS()
        @unknown default:
            break
        }
    }

    // Public — also invoked from APNsManager when a silent push arrives.
    public func drainInbox() async {
        do {
            var collected: [InboxMessage] = []
            var offset = 0
            let pageLimit = 50
            // Page until the server returns less than a full page.
            while true {
                let page = try await api.fetch(
                    since: lastDrainAt,
                    limit: pageLimit,
                    offset: offset
                )
                if page.isEmpty { break }
                collected.append(contentsOf: page)
                if page.count < pageLimit { break }
                offset += page.count
                // Hard ceiling to avoid pathological loops.
                if offset >= 5_000 { break }
            }

            guard !collected.isEmpty else { return }
            for m in collected where !seenIdsSet.contains(m.id) {
                inbound.append(m)
                markSeen(m.id)
            }
            capInboundIfNeeded()
            saveSeenIds()
            try? await api.ack(ids: collected.map(\.id))
            let newest = collected.map(\.createdAtMs).max() ?? lastDrainAt
            updateLastDrainAt(max(newest, lastDrainAt))
        } catch {
            // Swallow — next foreground or push will retry. Do not crash.
            NSLog("[DeliveryCore] drain failed: \(error)")
        }
    }

    // Public send. Optimistically queues; the queue is flushed by either WS
    // or InboxAPI depending on connectivity.
    public func send(to: String, body: String, kind: String = "text") {
        let item = OutboxItem(
            id: UUID().uuidString,
            to: to,
            body: body,
            kind: kind,
            queuedAtMs: nowMs(),
            attempts: 0,
            status: .pending
        )
        Task {
            await outbox.enqueue(item)
            await flushOutbox()
        }
    }

    // MARK: - private

    private func onForeground() async {
        await drainInbox()
        connectWS()
        await flushOutbox()
    }

    private func connectWS() {
        guard ws == nil, let account = AccountStore.shared.current else { return }
        let manager = WebSocketManager(
            account: account,
            onWireMessage: { [weak self] wire in
                Task { @MainActor in
                    self?.handleWire(wire)
                }
            },
            onStateChange: { [weak self] connected in
                Task { @MainActor in
                    self?.isWSConnected = connected
                    self?.isRelayConnected = connected
                }
            },
            onError: { [weak self] in
                Task { @MainActor in
                    guard let self, self.sceneIsActive else { return }
                    self.scheduleReconnect()
                }
            }
        )
        self.ws = manager
        Task { await manager.connect() }
    }

    private func disconnectWS() {
        let manager = ws
        ws = nil
        isWSConnected = false
        isRelayConnected = false
        Task { await manager?.disconnect() }
    }

    // Dispatches each decoded relay frame. Anything we don't recognize lands in
    // `.unknown` and is dropped — same effect as the old try? path, but every
    // recognized type now has an actual handler instead of being silently lost.
    private func handleWire(_ wire: WireMessage) {
        switch wire {
        case .inboxMessage(let m):
            if !seenIdsSet.contains(m.id) {
                inbound.append(m)
                markSeen(m.id)
                capInboundIfNeeded()
                saveSeenIds()
            }
            updateLastDrainAt(max(m.createdAtMs, lastDrainAt))
            Task { try? await self.api.ack(ids: [m.id]) }

        case .stream(let agentId, let delta, let id):
            if var current = streamingMessage, current.id == id {
                current.text += delta
                streamingMessage = current
            } else {
                streamingMessage = StreamingMessage(id: id, agentId: agentId, text: delta)
            }

        case .streamEnd(let agentId, let id):
            if let current = streamingMessage, current.id == id {
                let toMe = AccountStore.shared.current?.id ?? ""
                let final = InboxMessage(
                    id: id,
                    from: agentId,
                    to: toMe,
                    body: current.text,
                    createdAtMs: nowMs(),
                    kind: "text"
                )
                if !seenIdsSet.contains(final.id) {
                    inbound.append(final)
                    markSeen(final.id)
                    capInboundIfNeeded()
                    saveSeenIds()
                }
                streamingMessage = nil
            } else {
                // End frame for a stream we never started — just clear.
                streamingMessage = nil
            }

        case .thinking(let agentId):
            setThinking(agentId: agentId)

        case .roster(let agents):
            self.roster = agents

        case .history(let messages):
            var changed = false
            for m in messages where !seenIdsSet.contains(m.id) {
                inbound.append(m)
                markSeen(m.id)
                changed = true
            }
            if changed {
                capInboundIfNeeded()
                saveSeenIds()
            }

        case .status(let gateway, let model):
            self.gatewayStatus = gateway
            if let model { self.modelName = model }

        case .systemMessage(let text):
            let toMe = AccountStore.shared.current?.id ?? ""
            let m = InboxMessage(
                id: "sys-\(UUID().uuidString)",
                from: "system",
                to: toMe,
                body: text,
                createdAtMs: nowMs(),
                kind: "system"
            )
            inbound.append(m)
            markSeen(m.id)
            capInboundIfNeeded()
            saveSeenIds()

        case .error(let code, let message):
            NSLog("[WS] relay error code=\(code) message=\(message ?? "")")

        case .unknown:
            break
        }
    }

    private func setThinking(agentId: String) {
        isThinking = true
        thinkingAgentId = agentId
        thinkingClearTask?.cancel()
        thinkingClearTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: Self.thinkingTimeoutNs)
            guard let self, !Task.isCancelled else { return }
            self.isThinking = false
            self.thinkingAgentId = nil
        }
    }

    // Tear down and immediately reattempt while active. Small backoff prevents
    // a hot reconnect loop if the server is rejecting us repeatedly.
    private func scheduleReconnect() {
        disconnectWS()
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard self.sceneIsActive else { return }
            self.connectWS()
        }
    }

    private func flushOutbox() async {
        guard !isFlushingOutbox else { return }
        isFlushingOutbox = true
        defer { isFlushingOutbox = false }

        let items = await outbox.snapshot()
        for item in items where item.status == .pending {
            do {
                try await api.send(item)
                await outbox.remove(id: item.id)
            } catch {
                let attempts = await outbox.bumpAttempt(id: item.id)
                NSLog("[DeliveryCore] outbox send failed for \(item.id) (attempt \(attempts)): \(error)")
                if attempts >= Self.maxOutboxAttempts {
                    await outbox.markFailed(id: item.id)
                    NSLog("[DeliveryCore] outbox poison: \(item.id) marked .failed after \(attempts) attempts")
                }
            }
        }
    }

    private func capInboundIfNeeded() {
        if inbound.count > Self.inboundCap {
            inbound.removeFirst(inbound.count - Self.inboundCap)
        }
    }

    private func updateLastDrainAt(_ ms: Int64) {
        lastDrainAt = ms
        UserDefaults.standard.set(Int(ms), forKey: Self.lastDrainKey)
    }

    private func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }

    // MARK: - Seen-ids dedup (persistent, FIFO, capped at seenIdsCap)

    private func loadSeenIds() {
        let stored = UserDefaults.standard.stringArray(forKey: Self.seenIdsKey) ?? []
        let trimmed = stored.suffix(Self.seenIdsCap)
        seenIds = Array(trimmed)
        seenIdsSet = Set(seenIds)
    }

    private func markSeen(_ id: String) {
        guard !seenIdsSet.contains(id) else { return }
        seenIds.append(id)
        seenIdsSet.insert(id)
        if seenIds.count > Self.seenIdsCap {
            let drop = seenIds.count - Self.seenIdsCap
            let removed = seenIds.prefix(drop)
            seenIds.removeFirst(drop)
            for r in removed { seenIdsSet.remove(r) }
        }
    }

    private func saveSeenIds() {
        UserDefaults.standard.set(seenIds, forKey: Self.seenIdsKey)
    }

    // MARK: - Path monitor

    private func startPathMonitor() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            Task { @MainActor in
                guard let self else { return }
                let was = self.lastPathSatisfied
                self.lastPathSatisfied = satisfied
                // Edge-trigger: only act when path transitions to satisfied
                // *while* the scene is active. Background path flaps are ignored.
                if !was && satisfied && self.sceneIsActive {
                    NSLog("[DeliveryCore] network path satisfied — reconnecting")
                    self.scheduleReconnect()
                    await self.drainInbox()
                    await self.flushOutbox()
                }
            }
        }
        pathMonitor.start(queue: pathMonitorQueue)
    }
}

// MARK: - WebSocketManager (foreground-only, actor-isolated)

actor WebSocketManager {

    private let account: Account
    private let onWireMessage: @Sendable (WireMessage) -> Void
    private let onStateChange: @Sendable (Bool) -> Void
    private let onError: @Sendable () -> Void

    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var delegateAdapter: WSDelegateAdapter?
    private var explicitlyClosed = false
    private var pingTask: Task<Void, Never>?

    private static let pingIntervalNs: UInt64 = 30 * 1_000_000_000

    init(
        account: Account,
        onWireMessage: @escaping @Sendable (WireMessage) -> Void,
        onStateChange: @escaping @Sendable (Bool) -> Void,
        onError: @escaping @Sendable () -> Void
    ) {
        self.account = account
        self.onWireMessage = onWireMessage
        self.onStateChange = onStateChange
        self.onError = onError
    }

    func connect() {
        explicitlyClosed = false
        guard let url = wsURL() else { return }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(account.token)", forHTTPHeaderField: "Authorization")

        let adapter = WSDelegateAdapter(
            onOpen: { [weak self] in
                Task { await self?.handleOpened() }
            },
            onClose: { [weak self] in
                Task { await self?.handleClosed() }
            }
        )
        let session = URLSession(configuration: .default, delegate: adapter, delegateQueue: nil)
        let task = session.webSocketTask(with: req)
        self.session = session
        self.task = task
        self.delegateAdapter = adapter
        task.resume()
        receiveLoop()
        startPingTimer()
    }

    func disconnect() {
        explicitlyClosed = true
        stopPingTimer()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        delegateAdapter = nil
        onStateChange(false)
    }

    private func wsURL() -> URL? {
        var s = account.wsURL
        if s.hasPrefix("http://")  { s = "ws://"  + s.dropFirst("http://".count) }
        if s.hasPrefix("https://") { s = "wss://" + s.dropFirst("https://".count) }
        if !s.hasSuffix("/ws") { s += "/ws" }
        return URL(string: s)
    }

    private func receiveLoop() {
        guard let task else { return }
        task.receive { [weak self] result in
            guard let self else { return }
            Task { await self.handleReceive(result) }
        }
    }

    private func handleReceive(_ result: Result<URLSessionWebSocketTask.Message, Error>) {
        switch result {
        case .failure(let err):
            NSLog("[WS] recv error: \(err)")
            onStateChange(false)
            // Auto-reconnect path: bubble up so DeliveryCore can rewire
            // a fresh socket while the scene is still active.
            if !explicitlyClosed { onError() }
        case .success(let msg):
            switch msg {
            case .string(let s):
                if let data = s.data(using: .utf8),
                   let wire = try? JSONDecoder().decode(WireMessage.self, from: data) {
                    onWireMessage(wire)
                }
            case .data(let d):
                if let wire = try? JSONDecoder().decode(WireMessage.self, from: d) {
                    onWireMessage(wire)
                }
            @unknown default: break
            }
            if !explicitlyClosed { receiveLoop() }
        }
    }

    private func handleOpened() {
        onStateChange(true)
    }

    private func handleClosed() {
        onStateChange(false)
        if !explicitlyClosed { onError() }
    }

    // MARK: - Ping heartbeat

    private func startPingTimer() {
        pingTask?.cancel()
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: Self.pingIntervalNs)
                if Task.isCancelled { return }
                await self?.sendPing()
            }
        }
    }

    private func stopPingTimer() {
        pingTask?.cancel()
        pingTask = nil
    }

    private func sendPing() {
        guard let task, !explicitlyClosed else { return }
        task.sendPing { [weak self] error in
            guard let self, let error else { return }
            NSLog("[WS] ping failed: \(error)")
            Task { await self.handlePingFailure() }
        }
    }

    private func handlePingFailure() {
        guard !explicitlyClosed else { return }
        onStateChange(false)
        onError()
    }
}

// Small NSObject shim — actors can't subclass NSObject, but URLSession's
// delegate must be NSObjectProtocol. Adapter forwards open/close events
// into the actor via Task hops.
private final class WSDelegateAdapter: NSObject, URLSessionWebSocketDelegate {
    private let onOpen: @Sendable () -> Void
    private let onClose: @Sendable () -> Void

    init(onOpen: @escaping @Sendable () -> Void,
         onClose: @escaping @Sendable () -> Void) {
        self.onOpen = onOpen
        self.onClose = onClose
    }

    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        onOpen()
    }

    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                    reason: Data?) {
        onClose()
    }
}

// MARK: - InboxAPI

actor InboxAPI {

    func fetch(since ms: Int64, limit: Int = 50, offset: Int = 0) async throws -> [InboxMessage] {
        guard let account = await MainActor.run(body: { AccountStore.shared.current }) else {
            return []
        }
        guard var comps = URLComponents(string: account.httpURL + "/api/inbox") else {
            throw NSError(domain: "InboxAPI", code: -1, userInfo: [NSLocalizedDescriptionKey: "invalid inbox URL"])
        }
        comps.queryItems = [
            URLQueryItem(name: "since", value: String(ms)),
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset))
        ]
        guard let url = comps.url else {
            throw NSError(domain: "InboxAPI", code: -1, userInfo: [NSLocalizedDescriptionKey: "invalid inbox URL components"])
        }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(try await AuthManager.shared.currentToken())",
                     forHTTPHeaderField: "Authorization")
        let (data, resp) = try await URLSession.shared.data(for: req)
        try Self.expectOK(resp)
        return try JSONDecoder().decode(InboxResponse.self, from: data).messages
    }

    func ack(ids: [String]) async throws {
        guard !ids.isEmpty else { return }
        guard let account = await MainActor.run(body: { AccountStore.shared.current }) else {
            return
        }
        guard let url = URL(string: account.httpURL + "/api/inbox/ack") else {
            throw NSError(domain: "InboxAPI", code: -1, userInfo: [NSLocalizedDescriptionKey: "invalid ack URL"])
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(try await AuthManager.shared.currentToken())",
                     forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["ids": ids])
        let (_, resp) = try await URLSession.shared.data(for: req)
        try Self.expectOK(resp)
    }

    func send(_ item: OutboxItem) async throws {
        guard let account = await MainActor.run(body: { AccountStore.shared.current }) else {
            return
        }
        guard let url = URL(string: account.httpURL + "/api/messages") else {
            throw NSError(domain: "InboxAPI", code: -1, userInfo: [NSLocalizedDescriptionKey: "invalid messages URL"])
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(item.id, forHTTPHeaderField: "Idempotency-Key")
        req.setValue("Bearer \(try await AuthManager.shared.currentToken())",
                     forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "id": item.id,
            "to": item.to,
            "body": item.body,
            "kind": item.kind
        ])
        let (_, resp) = try await URLSession.shared.data(for: req)
        try Self.expectOK(resp)
    }

    private static func expectOK(_ resp: URLResponse) throws {
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw NSError(domain: "InboxAPI", code: (resp as? HTTPURLResponse)?.statusCode ?? -1)
        }
    }
}

// MARK: - OutboxQueue (UserDefaults-backed, actor-isolated)

actor OutboxQueue {

    private static let key = "thunder.delivery.outbox"

    func snapshot() -> [OutboxItem] {
        read()
    }

    func enqueue(_ item: OutboxItem) {
        var current = read()
        current.append(item)
        write(current)
    }

    func remove(id: String) {
        var current = read()
        current.removeAll { $0.id == id }
        write(current)
    }

    /// Increments the attempt counter and returns the new value.
    @discardableResult
    func bumpAttempt(id: String) -> Int {
        var current = read()
        guard let idx = current.firstIndex(where: { $0.id == id }) else { return 0 }
        current[idx].attempts += 1
        let newCount = current[idx].attempts
        write(current)
        return newCount
    }

    func markFailed(id: String) {
        var current = read()
        guard let idx = current.firstIndex(where: { $0.id == id }) else { return }
        current[idx].status = .failed
        write(current)
    }

    private func read() -> [OutboxItem] {
        guard let data = UserDefaults.standard.data(forKey: Self.key),
              let items = try? JSONDecoder().decode([OutboxItem].self, from: data)
        else { return [] }
        return items
    }

    private func write(_ items: [OutboxItem]) {
        let data = (try? JSONEncoder().encode(items)) ?? Data()
        UserDefaults.standard.set(data, forKey: Self.key)
    }
}
