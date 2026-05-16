// AuthManager.swift
//
// Token storage + proactive refresh.
//
// Design points:
//   - Tokens live in the Keychain with kSecAttrAccessibleAfterFirstUnlock.
//     This is the right class for a token a backgrounded app needs to use:
//     readable after first unlock post-boot, but not before. (We do NOT use
//     ...AlwaysThisDeviceOnly — that's deprecated and weakens security.)
//   - currentToken() never returns an expired token. If we're inside the
//     refresh window, it awaits a refresh before returning.
//   - A Combine timer fires the proactive refresh at (expiresAt - 90s).
//     90s gives APNs-driven drains plenty of headroom even on slow networks.
//   - On scenePhase == .active we re-check expiry — if the device was
//     suspended past the refresh time, the timer didn't fire, and we need
//     to refresh on resume before any API call goes out.

import Foundation
import Security
import Combine

@MainActor
public final class AuthManager: ObservableObject {

    public static let shared = AuthManager()

    @Published public private(set) var isAuthenticated: Bool = false

    private static let service = "us.thunderai.thundercommo.auth"
    private static let accountKey = "primary"
    private static let expiryKey = "thunder.auth.expiresAtMs"

    private var refreshTimer: AnyCancellable?
    private var refreshInFlight: Task<String, Error>?

    private init() {
        self.isAuthenticated = (try? readToken()) != nil
        if isAuthenticated { scheduleRefresh() }
    }

    // MARK: - Public API

    public func setToken(_ token: String, expiresAtMs: Int64) throws {
        try writeToken(token)
        UserDefaults.standard.set(Int(expiresAtMs), forKey: Self.expiryKey)
        isAuthenticated = true
        scheduleRefresh()
    }

    public func clearToken() {
        _ = deleteToken()
        UserDefaults.standard.removeObject(forKey: Self.expiryKey)
        refreshTimer?.cancel()
        refreshTimer = nil
        isAuthenticated = false
    }

    /// Synchronous peek for callers that need the current bearer without
    /// triggering a refresh. Returns nil if no token is stored.
    public func peekToken() -> String? {
        try? readToken()
    }

    // Never returns an expired token. Awaits an in-flight refresh if one
    // is happening. Throws if there's no token at all.
    public func currentToken() async throws -> String {
        if let inflight = refreshInFlight {
            return try await inflight.value
        }

        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        let expiresAtMs = Int64(UserDefaults.standard.integer(forKey: Self.expiryKey))

        if expiresAtMs > 0 && nowMs >= (expiresAtMs - 5_000) {
            return try await runRefresh()
        }

        guard let tok = try? readToken() else {
            throw AuthError.notAuthenticated
        }
        return tok
    }

    // Hook from the App root: reacts to .active so we refresh before any
    // network call goes out after a long suspension.
    public func handleScenePhaseActive() {
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        let expiresAtMs = Int64(UserDefaults.standard.integer(forKey: Self.expiryKey))
        guard expiresAtMs > 0 else { return }
        if nowMs >= (expiresAtMs - 90_000) {
            Task { _ = try? await runRefresh() }
        } else {
            scheduleRefresh()
        }
    }

    // MARK: - Refresh

    @discardableResult
    private func runRefresh() async throws -> String {
        if let inflight = refreshInFlight {
            return try await inflight.value
        }
        let task = Task<String, Error> { [weak self] in
            guard let self else { throw AuthError.notAuthenticated }
            return try await self.performRefresh()
        }
        refreshInFlight = task
        defer { refreshInFlight = nil }
        return try await task.value
    }

    private func performRefresh() async throws -> String {
        guard let account = AccountStore.shared.current else {
            throw AuthError.notAuthenticated
        }
        let url = URL(string: account.httpURL + "/api/auth/refresh")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let existing = try? readToken() {
            req.setValue("Bearer \(existing)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "account_id": account.id
        ])

        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw AuthError.refreshFailed
        }
        struct Response: Decodable {
            let token: String
            // Optional: a server that omits this shouldn't break refresh.
            // Fallback is 30 days from now.
            let expires_at_ms: Int64?
        }
        let r = try JSONDecoder().decode(Response.self, from: data)
        let fallback = Int64(Date(timeIntervalSinceNow: 30 * 24 * 3600).timeIntervalSince1970 * 1000)
        try setToken(r.token, expiresAtMs: r.expires_at_ms ?? fallback)
        return r.token
    }

    private func scheduleRefresh() {
        refreshTimer?.cancel()
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        let expiresAtMs = Int64(UserDefaults.standard.integer(forKey: Self.expiryKey))
        guard expiresAtMs > nowMs else { return }
        let delayMs = max(1_000, (expiresAtMs - 90_000) - nowMs)
        refreshTimer = Timer.publish(every: TimeInterval(delayMs) / 1000.0,
                                     on: .main,
                                     in: .common)
            .autoconnect()
            .first()
            .sink { [weak self] _ in
                Task { _ = try? await self?.runRefresh() }
            }
    }

    // MARK: - Keychain

    private func writeToken(_ token: String) throws {
        let data = Data(token.utf8)
        let q: [String: Any] = [
            kSecClass as String:        kSecClassGenericPassword,
            kSecAttrService as String:  Self.service,
            kSecAttrAccount as String:  Self.accountKey
        ]
        SecItemDelete(q as CFDictionary)

        var add = q
        add[kSecValueData as String]      = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw AuthError.keychainWriteFailed(status) }
    }

    private func readToken() throws -> String {
        let q: [String: Any] = [
            kSecClass as String:        kSecClassGenericPassword,
            kSecAttrService as String:  Self.service,
            kSecAttrAccount as String:  Self.accountKey,
            kSecReturnData as String:   true,
            kSecMatchLimit as String:   kSecMatchLimitOne
        ]
        var out: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        guard status == errSecSuccess,
              let data = out as? Data,
              let s = String(data: data, encoding: .utf8) else {
            throw AuthError.notAuthenticated
        }
        return s
    }

    @discardableResult
    private func deleteToken() -> OSStatus {
        let q: [String: Any] = [
            kSecClass as String:        kSecClassGenericPassword,
            kSecAttrService as String:  Self.service,
            kSecAttrAccount as String:  Self.accountKey
        ]
        return SecItemDelete(q as CFDictionary)
    }
}

public enum AuthError: Error {
    case notAuthenticated
    case refreshFailed
    case keychainWriteFailed(OSStatus)
}
