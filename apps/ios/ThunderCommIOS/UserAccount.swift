// UserAccount.swift
//
// User identity model + persistent store.
//
// Storage split:
//   - UserDefaults: profile (email, name, phone, role, avatar, createdAt,
//     biometricsEnabled), agent metadata (id, name, emoji, URLs, KYA, default).
//   - Keychain: per-agent bearer tokens, keyed by agent UUID. Tokens never
//     touch UserDefaults — that's the rule that keeps a backup-restore from
//     leaking a working credential.

import Foundation
import Combine
import LocalAuthentication
import Security

// MARK: - Models

public enum UserRole: String, Codable {
    case admin
    case user
}

public struct KYAIdentity: Codable, Equatable {
    public var agentId: String
    public var displayName: String
    public var emoji: String
    public var fingerprint: String
    public var verifiedAt: Date?

    public init(agentId: String,
                displayName: String,
                emoji: String,
                fingerprint: String,
                verifiedAt: Date? = nil) {
        self.agentId = agentId
        self.displayName = displayName
        self.emoji = emoji
        self.fingerprint = fingerprint
        self.verifiedAt = verifiedAt
    }
}

public struct AgentConnection: Codable, Identifiable, Equatable {
    public var id: UUID
    public var agentName: String
    public var agentEmoji: String
    public var wsURL: String
    public var httpURL: String
    public var kya: KYAIdentity?
    public var isDefault: Bool

    public init(id: UUID = UUID(),
                agentName: String,
                agentEmoji: String = "⚡",
                wsURL: String,
                httpURL: String,
                kya: KYAIdentity? = nil,
                isDefault: Bool = false) {
        self.id = id
        self.agentName = agentName
        self.agentEmoji = agentEmoji
        self.wsURL = wsURL
        self.httpURL = httpURL
        self.kya = kya
        self.isDefault = isDefault
    }

    // Tokens live in the Keychain, not in this struct. CodingKeys deliberately
    // omits `token` so a JSON encode of this object can never carry one.
    private enum CodingKeys: String, CodingKey {
        case id, agentName, agentEmoji, wsURL, httpURL, kya, isDefault
    }
}

public struct UserAccount: Codable, Identifiable, Equatable {
    public var id: UUID
    public var email: String
    public var displayName: String
    public var phoneNumber: String?
    public var role: UserRole
    public var avatarURL: String?
    public var createdAt: Date
    public var biometricsEnabled: Bool
    public var agents: [AgentConnection]

    public init(id: UUID = UUID(),
                email: String,
                displayName: String,
                phoneNumber: String? = nil,
                role: UserRole = .user,
                avatarURL: String? = nil,
                createdAt: Date = Date(),
                biometricsEnabled: Bool = false,
                agents: [AgentConnection] = []) {
        self.id = id
        self.email = email
        self.displayName = displayName
        self.phoneNumber = phoneNumber
        self.role = role
        self.avatarURL = avatarURL
        self.createdAt = createdAt
        self.biometricsEnabled = biometricsEnabled
        self.agents = agents
    }
}

// MARK: - Errors

public enum UserStoreError: Error, LocalizedError {
    case invalidEmail
    case weakPassword
    case wrongCredentials
    case invalidCredentials
    case biometricsUnavailable
    case biometricsFailed
    case keychainFailure(OSStatus)
    case noAccount
    case serverError(String)
    case networkFailure(String)

    public var errorDescription: String? {
        switch self {
        case .invalidEmail:          return "Please enter a valid email address."
        case .weakPassword:          return "Password must be at least 8 characters."
        case .wrongCredentials:      return "Email or password is incorrect."
        case .invalidCredentials:    return "Email or password is incorrect."
        case .biometricsUnavailable: return "Face ID / Touch ID isn't available on this device."
        case .biometricsFailed:      return "Biometric authentication failed."
        case .keychainFailure:       return "Could not access the secure keychain."
        case .noAccount:             return "No account is signed in."
        case .serverError(let msg):  return msg
        case .networkFailure(let m): return m
        }
    }
}

// MARK: - UserStore

@MainActor
public final class UserStore: ObservableObject {

    public static let shared = UserStore()

    /// Default ThunderBase server. Can be overridden per-agent in AddAgentView.
    public static let defaultHTTPURL = "https://thunderai.us"

    @Published public private(set) var currentUser: UserAccount?
    @Published public private(set) var isAuthenticated: Bool = false
    @Published public var lastAuthenticatedAt: Date?

    private static let userKey      = "thunder.user.account.v1"
    private static let agentTokenSvc = "us.thunderai.thundercommo.agent.token"

    private init() {
        loadFromDisk()
    }

    // MARK: Sign-up / Sign-in

    public func signUp(email: String,
                       password: String,
                       displayName: String,
                       phone: String?) async throws {
        let cleanedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let cleanedName  = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanedPhone = (phone?.isEmpty == true) ? nil : phone
        guard isValidEmail(cleanedEmail) else { throw UserStoreError.invalidEmail }
        guard password.count >= 8         else { throw UserStoreError.weakPassword }

        if let prior = currentUser, prior.email != cleanedEmail {
            for agent in prior.agents {
                AccountStore.shared.remove(id: agent.id.uuidString)
                _ = deleteAgentToken(agentId: agent.id)
            }
            AuthManager.shared.clearToken()
        }

        var body: [String: String] = [
            "email":       cleanedEmail,
            "password":    password,
            "displayName": cleanedName
        ]
        if let p = cleanedPhone { body["phone"] = p }

        let resp = try await postAuth(path: "/api/auth/signup", body: body, bearer: nil)

        try AuthManager.shared.setToken(
            resp.token,
            expiresAtMs: resp.expires_at_ms ?? Self.defaultExpiryMs()
        )
        let user = makeUserAccount(
            from: resp.user,
            fallbackEmail: cleanedEmail,
            fallbackDisplayName: cleanedName,
            fallbackPhone: cleanedPhone,
            fallbackUser: nil
        )
        currentUser = user
        isAuthenticated = true
        lastAuthenticatedAt = Date()
        persist()
        syncAccountStore(from: resp.user?.agents)
        APNsManager.shared.retryTokenUploadIfNeeded()
    }

    public func signIn(email: String, password: String) async throws {
        let cleanedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard isValidEmail(cleanedEmail) else { throw UserStoreError.invalidEmail }

        let priorUser = currentUser

        let body = ["email": cleanedEmail, "password": password]
        let resp = try await postAuth(path: "/api/auth/signin", body: body, bearer: nil)

        // Switching accounts: drop the prior user's per-agent tokens before we
        // overwrite currentUser, otherwise their keychain entries stay behind.
        if let prior = priorUser, prior.email != cleanedEmail {
            for agent in prior.agents {
                AccountStore.shared.remove(id: agent.id.uuidString)
                _ = deleteAgentToken(agentId: agent.id)
            }
            AuthManager.shared.clearToken()
        }

        try AuthManager.shared.setToken(
            resp.token,
            expiresAtMs: resp.expires_at_ms ?? Self.defaultExpiryMs()
        )
        let user = makeUserAccount(
            from: resp.user,
            fallbackEmail: cleanedEmail,
            fallbackDisplayName: cleanedEmail,
            fallbackPhone: priorUser?.phoneNumber,
            fallbackUser: priorUser
        )
        currentUser = user
        isAuthenticated = true
        lastAuthenticatedAt = Date()
        persist()
        syncAccountStore(from: resp.user?.agents)
        APNsManager.shared.retryTokenUploadIfNeeded()
    }

    /// POST /api/auth/refresh with the current bearer token. Replaces the
    /// stored session token on success and pushes the new expiry to
    /// AuthManager so its proactive-refresh timer is rescheduled.
    @discardableResult
    public func refreshToken() async throws -> String {
        guard let token = AuthManager.shared.peekToken() else {
            throw UserStoreError.noAccount
        }
        let resp = try await postAuth(path: "/api/auth/refresh", body: [:], bearer: token)
        try AuthManager.shared.setToken(
            resp.token,
            expiresAtMs: resp.expires_at_ms ?? Self.defaultExpiryMs()
        )
        return resp.token
    }

    // Build 55 final: sign-out is a full wipe — no bleed between sessions.
    // Clears the persisted user blob, every agent token in the keychain, the
    // session bearer in AuthManager, and resets the in-memory flags. The
    // caller is also responsible for wiping AccountStore and the onboarding
    // flag (see SettingsView).
    public func signOut() {
        if let agents = currentUser?.agents {
            for agent in agents {
                _ = deleteAgentToken(agentId: agent.id)
            }
        }
        currentUser = nil
        isAuthenticated = false
        lastAuthenticatedAt = nil
        AuthManager.shared.clearToken()
        UserDefaults.standard.removeObject(forKey: Self.userKey)
    }

    /// Bearer token for the signed-in user, if any.
    public func sessionToken() -> String? {
        AuthManager.shared.peekToken()
    }

    // MARK: Biometrics

    public func enableBiometrics() async throws -> Bool {
        let ctx = LAContext()
        var error: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            throw UserStoreError.biometricsUnavailable
        }
        let ok: Bool = try await withCheckedThrowingContinuation { cont in
            ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                               localizedReason: "Enable Face ID for ThunderCommo") { success, err in
                if let err { cont.resume(throwing: err); return }
                cont.resume(returning: success)
            }
        }
        if ok {
            currentUser?.biometricsEnabled = true
            persist()
        }
        return ok
    }

    public func authenticateWithBiometrics() async throws -> Bool {
        guard let user = currentUser, user.biometricsEnabled else {
            throw UserStoreError.biometricsUnavailable
        }
        let ctx = LAContext()
        var error: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            throw UserStoreError.biometricsUnavailable
        }
        let ok: Bool = try await withCheckedThrowingContinuation { cont in
            ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                               localizedReason: "Unlock ThunderCommo") { success, err in
                if let err { cont.resume(throwing: err); return }
                cont.resume(returning: success)
            }
        }
        if ok {
            isAuthenticated = true
            lastAuthenticatedAt = Date()
            APNsManager.shared.retryTokenUploadIfNeeded()
        }
        return ok
    }

    // MARK: Agents

    public func addAgent(_ connection: AgentConnection, token: String? = nil) {
        guard var user = currentUser else { return }
        var conn = connection
        if user.agents.isEmpty { conn.isDefault = true }
        user.agents.append(conn)
        currentUser = user
        if let token { try? writeAgentToken(token, agentId: conn.id) }
        persist()

        let account = Account(
            id: conn.id.uuidString,
            name: conn.agentName,
            wsURL: conn.wsURL,
            httpURL: conn.httpURL,
            token: token ?? ""
        )
        AccountStore.shared.add(account, makeCurrent: user.agents.count == 1)
        APNsManager.shared.retryTokenUploadIfNeeded()
    }

    public func removeAgent(id: UUID) {
        guard var user = currentUser else { return }
        let wasDefault = user.agents.first(where: { $0.id == id })?.isDefault ?? false
        user.agents.removeAll { $0.id == id }
        if wasDefault, !user.agents.isEmpty { user.agents[0].isDefault = true }
        currentUser = user
        _ = deleteAgentToken(agentId: id)
        persist()
    }

    public func token(for agentId: UUID) -> String? {
        try? readAgentToken(agentId: agentId)
    }

    public func updateProfile(displayName: String, phoneNumber: String?) {
        guard var user = currentUser else { return }
        user.displayName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let digitsOnly = phoneNumber?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .filter(\.isNumber)
        user.phoneNumber = (digitsOnly?.isEmpty == false) ? digitsOnly : nil
        currentUser = user
        persist()
    }

    // MARK: Persistence

    private func loadFromDisk() {
        guard let data = UserDefaults.standard.data(forKey: Self.userKey),
              let user = try? JSONDecoder().decode(UserAccount.self, from: data) else {
            return
        }
        currentUser = user
    }

    private func persist() {
        guard let user = currentUser,
              let data = try? JSONEncoder().encode(user) else { return }
        UserDefaults.standard.set(data, forKey: Self.userKey)
    }

    // MARK: Validation

    private func isValidEmail(_ s: String) -> Bool {
        let pattern = "^[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}$"
        return s.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    // MARK: Keychain — agent tokens

    private func writeAgentToken(_ token: String, agentId: UUID) throws {
        try writeKeychain(service: Self.agentTokenSvc,
                          account: agentId.uuidString,
                          data: Data(token.utf8))
    }

    private func readAgentToken(agentId: UUID) throws -> String {
        let data = try readKeychain(service: Self.agentTokenSvc,
                                    account: agentId.uuidString)
        return String(decoding: data, as: UTF8.self)
    }

    @discardableResult
    private func deleteAgentToken(agentId: UUID) -> OSStatus {
        deleteKeychain(service: Self.agentTokenSvc, account: agentId.uuidString)
    }

    // MARK: Keychain — primitives

    private func writeKeychain(service: String, account: String, data: Data) throws {
        let q: [String: Any] = [
            kSecClass as String:        kSecClassGenericPassword,
            kSecAttrService as String:  service,
            kSecAttrAccount as String:  account
        ]
        SecItemDelete(q as CFDictionary)
        var add = q
        add[kSecValueData as String]      = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw UserStoreError.keychainFailure(status) }
    }

    private func readKeychain(service: String, account: String) throws -> Data {
        let q: [String: Any] = [
            kSecClass as String:        kSecClassGenericPassword,
            kSecAttrService as String:  service,
            kSecAttrAccount as String:  account,
            kSecReturnData as String:   true,
            kSecMatchLimit as String:   kSecMatchLimitOne
        ]
        var out: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        guard status == errSecSuccess, let data = out as? Data else {
            throw UserStoreError.keychainFailure(status)
        }
        return data
    }

    @discardableResult
    private func deleteKeychain(service: String, account: String) -> OSStatus {
        let q: [String: Any] = [
            kSecClass as String:        kSecClassGenericPassword,
            kSecAttrService as String:  service,
            kSecAttrAccount as String:  account
        ]
        return SecItemDelete(q as CFDictionary)
    }

    // MARK: HTTP — auth endpoints

    private struct AuthResponse: Decodable {
        let token: String
        // Optional: a server that omits this (older builds, partial deploys)
        // shouldn't break sign-in. Callers fall back to 30 days.
        let expires_at_ms: Int64?
        let user: UserPayload?

        struct UserPayload: Decodable {
            let id: String?
            let email: String?
            let displayName: String?
            let phoneNumber: String?
            let role: UserRole?
            let avatarURL: String?
            let createdAtMs: Int64?
            let biometricsEnabled: Bool?
            let agents: [AuthResponse.AgentPayload]?

            private enum CodingKeys: String, CodingKey {
                case id, email, displayName, display_name, name, phoneNumber, phone, phone_number, role, avatarURL, avatarUrl, avatar_url, createdAtMs, created_at_ms, biometricsEnabled, agents
            }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                id = Self.firstString(c, keys: [.id])
                email = Self.firstString(c, keys: [.email])
                displayName = Self.firstString(c, keys: [.displayName, .display_name, .name])
                phoneNumber = Self.firstString(c, keys: [.phoneNumber, .phone])
                role = try c.decodeIfPresent(UserRole.self, forKey: .role)
                avatarURL = Self.firstString(c, keys: [.avatarURL, .avatarUrl, .avatar_url])
                createdAtMs = try c.decodeIfPresent(Int64.self, forKey: .createdAtMs)
                    ?? c.decodeIfPresent(Int64.self, forKey: .created_at_ms)
                biometricsEnabled = try c.decodeIfPresent(Bool.self, forKey: .biometricsEnabled)
                agents = try c.decodeIfPresent([AuthResponse.AgentPayload].self, forKey: .agents)
            }

            private static func firstString(_ container: KeyedDecodingContainer<CodingKeys>, keys: [CodingKeys]) -> String? {
                for key in keys {
                    if let value = try? container.decodeIfPresent(String.self, forKey: key), !value.isEmpty {
                        return value
                    }
                }
                return nil
            }
        }

        struct AgentPayload: Decodable {
            let id: String?
            let agentName: String?
            let agentEmoji: String?
            let wsURL: String?
            let httpURL: String?
            let token: String?
            let deviceToken: String?
            let createdAtMs: Int64?
            let isDefault: Bool?

            private enum CodingKeys: String, CodingKey {
                case id, name, agentName, displayName, emoji, agentEmoji, wsURL, wsUrl, ws_url, httpURL, httpUrl, http_url, token, deviceToken, device_token, createdAtMs, created_at_ms, isDefault, defaultAgent
            }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                id = Self.firstString(c, keys: [.id])
                agentName = Self.firstString(c, keys: [.agentName, .name, .displayName])
                agentEmoji = Self.firstString(c, keys: [.agentEmoji, .emoji])
                wsURL = Self.firstString(c, keys: [.wsURL, .wsUrl, .ws_url])
                httpURL = Self.firstString(c, keys: [.httpURL, .httpUrl, .http_url])
                token = Self.firstString(c, keys: [.token])
                deviceToken = Self.firstString(c, keys: [.deviceToken, .device_token])
                createdAtMs = try c.decodeIfPresent(Int64.self, forKey: .createdAtMs)
                    ?? c.decodeIfPresent(Int64.self, forKey: .created_at_ms)
                isDefault = try c.decodeIfPresent(Bool.self, forKey: .isDefault)
                    ?? c.decodeIfPresent(Bool.self, forKey: .defaultAgent)
            }

            private static func firstString(_ container: KeyedDecodingContainer<CodingKeys>, keys: [CodingKeys]) -> String? {
                for key in keys {
                    if let value = try? container.decodeIfPresent(String.self, forKey: key), !value.isEmpty {
                        return value
                    }
                }
                return nil
            }
        }
    }

    /// 30 days from now, in ms. Used when the server response omits
    /// expires_at_ms — keeps the proactive-refresh timer armed instead of
    /// silently sitting on a never-expires credential.
    private static func defaultExpiryMs() -> Int64 {
        Int64(Date(timeIntervalSinceNow: 30 * 24 * 3600).timeIntervalSince1970 * 1000)
    }

    private func makeUserAccount(from payload: AuthResponse.UserPayload?,
                                 fallbackEmail: String,
                                 fallbackDisplayName: String,
                                 fallbackPhone: String?,
                                 fallbackUser: UserAccount?) -> UserAccount {
        let agents = makeAgentConnections(from: payload?.agents)
        let sameAccount = fallbackUser?.email == fallbackEmail
        let fallbackAgents = sameAccount ? fallbackUser?.agents ?? [] : []
        let resolvedAgents = agents.isEmpty ? fallbackAgents : agents
        return UserAccount(
            id: payload?.id.flatMap(UUID.init(uuidString:)) ?? (sameAccount ? fallbackUser?.id : nil) ?? UUID(),
            email: payload?.email ?? fallbackEmail,
            displayName: payload?.displayName ?? fallbackDisplayName,
            phoneNumber: payload?.phoneNumber ?? fallbackPhone,
            role: payload?.role ?? (sameAccount ? fallbackUser?.role : nil) ?? .user,
            avatarURL: payload?.avatarURL ?? (sameAccount ? fallbackUser?.avatarURL : nil),
            createdAt: payload?.createdAtMs.map { Date(timeIntervalSince1970: TimeInterval($0) / 1000.0) }
                ?? (sameAccount ? fallbackUser?.createdAt : nil) ?? Date(),
            biometricsEnabled: payload?.biometricsEnabled ?? (sameAccount ? fallbackUser?.biometricsEnabled : nil) ?? false,
            agents: resolvedAgents
        )
    }

    private func makeAgentConnections(from payloads: [AuthResponse.AgentPayload]?) -> [AgentConnection] {
        guard let payloads else { return [] }
        return payloads.map { payload in
            AgentConnection(
                id: payload.id.flatMap(UUID.init(uuidString:)) ?? UUID(),
                agentName: payload.agentName ?? "Agent",
                agentEmoji: payload.agentEmoji ?? "⚡",
                wsURL: payload.wsURL ?? Account.defaultRelayWSURL,
                httpURL: payload.httpURL ?? Account.defaultRelayHTTPURL,
                kya: nil,
                isDefault: payload.isDefault ?? false
            )
        }
    }

    private func syncAccountStore(from payloads: [AuthResponse.AgentPayload]?) {
        guard let payloads, !payloads.isEmpty else { return }
        let resolvedAgents = makeAgentConnections(from: payloads)
        guard !resolvedAgents.isEmpty else { return }
        let defaultIdx = resolvedAgents.firstIndex(where: { $0.isDefault }) ?? 0
        for (index, agent) in resolvedAgents.enumerated() {
            let payloadToken = payloads.indices.contains(index) ? payloads[index].token : nil
            let account = Account(
                id: agent.id.uuidString,
                name: agent.agentName,
                wsURL: agent.wsURL,
                httpURL: agent.httpURL,
                token: payloadToken ?? ""
            )
            AccountStore.shared.add(account, makeCurrent: index == defaultIdx)
        }
    }
    private struct ServerError: Decodable {
        let error: String?
        let message: String?
        var displayMessage: String { message ?? error ?? "Server error" }
    }

    /// POSTs JSON to `Self.defaultHTTPURL + path`. Returns the decoded
    /// `{ token }` on 2xx; throws `.invalidCredentials` on 401, `.serverError`
    /// with the server's message on other non-2xx, `.networkFailure` on
    /// transport errors.
    private func postAuth(path: String,
                          body: [String: String],
                          bearer: String?) async throws -> AuthResponse {
        guard let url = URL(string: Self.defaultHTTPURL + path) else {
            throw UserStoreError.networkFailure("Invalid URL: \(Self.defaultHTTPURL)\(path)")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let bearer { req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        req.httpBody = try JSONEncoder().encode(body)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            throw UserStoreError.networkFailure(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw UserStoreError.networkFailure("No HTTP response")
        }
        switch http.statusCode {
        case 200..<300:
            do {
                return try JSONDecoder().decode(AuthResponse.self, from: data)
            } catch {
                throw UserStoreError.serverError("Malformed server response")
            }
        case 401:
            throw UserStoreError.invalidCredentials
        default:
            let msg = (try? JSONDecoder().decode(ServerError.self, from: data))?.displayMessage
                   ?? String(data: data, encoding: .utf8)
                   ?? "HTTP \(http.statusCode)"
            throw UserStoreError.serverError(msg)
        }
    }
}
