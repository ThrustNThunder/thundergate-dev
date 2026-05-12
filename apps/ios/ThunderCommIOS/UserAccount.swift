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
//
// Pre-seeded admin account
// Email:       thrustnthunder1@gmail.com
// Role:        .admin
// Agent:       Jon (wss://thunderai.us, https://thunderai.us)
// Token:       injected at build time via TC_ADMIN_TOKEN scheme env var
// Biometrics:  enabled by default for admin
// The seed runs once on first launch when no user is persisted, so reinstalling
// the app on Michael's device gets him straight into the existing Jon agent
// without re-entering anything.

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
    private static let seededFlag   = "thunder.user.seeded.v1"

    private init() {
        loadFromDisk()
        seedAdminIfNeeded()
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
        let user = UserAccount(
            email: cleanedEmail,
            displayName: cleanedName,
            phoneNumber: cleanedPhone,
            role: .user
        )
        currentUser = user
        isAuthenticated = true
        lastAuthenticatedAt = Date()
        persist()
        APNsManager.shared.retryTokenUploadIfNeeded()
    }

    public func signIn(email: String, password: String) async throws {
        let cleanedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard isValidEmail(cleanedEmail) else { throw UserStoreError.invalidEmail }

        let body = ["email": cleanedEmail, "password": password]
        let resp = try await postAuth(path: "/api/auth/signin", body: body, bearer: nil)

        // Switching accounts: drop the prior user's per-agent tokens before we
        // overwrite currentUser, otherwise their keychain entries stay behind.
        if let prior = currentUser, prior.email != cleanedEmail {
            for agent in prior.agents {
                _ = deleteAgentToken(agentId: agent.id)
            }
            AuthManager.shared.clearToken()
        }

        try AuthManager.shared.setToken(
            resp.token,
            expiresAtMs: resp.expires_at_ms ?? Self.defaultExpiryMs()
        )
        if currentUser?.email != cleanedEmail {
            currentUser = UserAccount(email: cleanedEmail, displayName: cleanedEmail, role: .user)
        }
        isAuthenticated = true
        lastAuthenticatedAt = Date()
        persist()
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

    public func signOut() {
        isAuthenticated = false
        lastAuthenticatedAt = nil
        AuthManager.shared.clearToken()
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

    private func seedAdminIfNeeded() {
        let alreadySeeded = UserDefaults.standard.bool(forKey: Self.seededFlag)
        if alreadySeeded || currentUser != nil { return }

        let jonId = UUID()
        let jon = AgentConnection(
            id: jonId,
            agentName: "Jon",
            agentEmoji: "⚡",
            wsURL: "wss://thunderai.us",
            httpURL: "https://thunderai.us",
            kya: nil,
            isDefault: true
        )
        let admin = UserAccount(
            email: "thrustnthunder1@gmail.com",
            displayName: "Michael",
            role: .admin,
            biometricsEnabled: true,
            agents: [jon]
        )
        currentUser = admin
        // Set TC_ADMIN_TOKEN in build scheme environment variables.
        let adminToken = (Bundle.main.object(forInfoDictionaryKey: "TC_ADMIN_TOKEN") as? String) ?? ""
        if !adminToken.isEmpty {
            try? writeAgentToken(adminToken, agentId: jonId)
        }
        UserDefaults.standard.set(true, forKey: Self.seededFlag)
        persist()
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
    }

    /// 30 days from now, in ms. Used when the server response omits
    /// expires_at_ms — keeps the proactive-refresh timer armed instead of
    /// silently sitting on a never-expires credential.
    private static func defaultExpiryMs() -> Int64 {
        Int64(Date(timeIntervalSinceNow: 30 * 24 * 3600).timeIntervalSince1970 * 1000)
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
