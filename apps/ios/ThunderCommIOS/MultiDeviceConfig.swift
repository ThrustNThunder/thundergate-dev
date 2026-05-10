// MultiDeviceConfig.swift
//
// Multi-account / multi-device configuration for ThunderCommo.
//
// One device can carry multiple Accounts. Each Account points at a gateway
// (the relay), holds its own bearer token, and tracks the APNs device token
// the relay should fan out to.
//
// No hardcoded "Michael" — every account is set up via OnboardingView.

import Foundation
import Combine
import Security

public struct Account: Codable, Identifiable, Equatable {
    public var id: String          // stable UUID, generated at create time
    public var name: String        // display name shown in UI
    public var wsURL: String       // e.g. "wss://thunderai.us"
    public var httpURL: String     // e.g. "https://thunderai.us"
    // Gateway bearer token. Lives in the Keychain keyed by `id`; AccountStore
    // injects it on load and writes it on add/update. Excluded from Codable so
    // the persisted UserDefaults blob can never carry a working credential.
    public var token: String
    public var deviceToken: String?// APNs token, set by APNsManager after registration
    public var createdAtMs: Int64

    public init(
        id: String = UUID().uuidString,
        name: String,
        wsURL: String,
        httpURL: String,
        token: String,
        deviceToken: String? = nil,
        createdAtMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    ) {
        self.id = id
        self.name = name
        self.wsURL = wsURL
        self.httpURL = httpURL
        self.token = token
        self.deviceToken = deviceToken
        self.createdAtMs = createdAtMs
    }

    // `token` is deliberately omitted — see the property comment.
    // `gatewayURL` is the legacy key for `wsURL` (pre-rename builds).
    private enum CodingKeys: String, CodingKey {
        case id, name, wsURL, httpURL, gatewayURL, deviceToken, createdAtMs
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.name = try c.decode(String.self, forKey: .name)
        // Token is not persisted in the Codable payload. AccountStore.load()
        // populates it from the Keychain after decode.
        self.token = ""
        self.deviceToken = try c.decodeIfPresent(String.self, forKey: .deviceToken)
        self.createdAtMs = try c.decode(Int64.self, forKey: .createdAtMs)

        if let ws = try c.decodeIfPresent(String.self, forKey: .wsURL) {
            self.wsURL = ws
        } else if let legacy = try c.decodeIfPresent(String.self, forKey: .gatewayURL) {
            self.wsURL = legacy
        } else {
            throw DecodingError.keyNotFound(
                CodingKeys.wsURL,
                .init(codingPath: c.codingPath, debugDescription: "Missing wsURL/gatewayURL")
            )
        }
        if let http = try c.decodeIfPresent(String.self, forKey: .httpURL) {
            self.httpURL = http
        } else {
            // Derive once from wsURL, then store going forward.
            self.httpURL = Account.deriveHttpURL(fromWS: self.wsURL)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(wsURL, forKey: .wsURL)
        try c.encode(httpURL, forKey: .httpURL)
        // token deliberately omitted — see CodingKeys.
        try c.encodeIfPresent(deviceToken, forKey: .deviceToken)
        try c.encode(createdAtMs, forKey: .createdAtMs)
    }

    private static func deriveHttpURL(fromWS s: String) -> String {
        if s.hasPrefix("wss://") { return "https://" + s.dropFirst("wss://".count) }
        if s.hasPrefix("ws://")  { return "http://"  + s.dropFirst("ws://".count) }
        return s
    }
}

@MainActor
public final class AccountStore: ObservableObject {

    public static let shared = AccountStore()

    @Published public private(set) var accounts: [Account] = []
    @Published public private(set) var currentID: String?

    public var current: Account? {
        guard let id = currentID else { return accounts.first }
        return accounts.first(where: { $0.id == id })
    }

    public var hasAnyAccount: Bool { !accounts.isEmpty }

    private static let accountsKey = "thunder.accounts.v1"
    private static let currentIDKey = "thunder.accounts.currentID"
    private static let tokenKcService = "us.thunderai.thundercommo.account.token"

    private init() {
        load()
    }

    // MARK: - mutators

    public func add(_ account: Account, makeCurrent: Bool = true) {
        if let idx = accounts.firstIndex(where: { $0.id == account.id }) {
            accounts[idx] = account
        } else {
            accounts.append(account)
        }
        try? writeTokenKeychain(account.token, accountID: account.id)
        if makeCurrent { currentID = account.id }
        persist()
    }

    public func remove(id: String) {
        accounts.removeAll { $0.id == id }
        _ = deleteTokenKeychain(accountID: id)
        if currentID == id { currentID = accounts.first?.id }
        persist()
    }

    public func switchTo(id: String) {
        guard accounts.contains(where: { $0.id == id }) else { return }
        currentID = id
        persist()
    }

    public func updateDeviceToken(_ token: String, for accountID: String) {
        guard let idx = accounts.firstIndex(where: { $0.id == accountID }) else { return }
        accounts[idx].deviceToken = token
        persist()
    }

    public func updateToken(_ token: String, for accountID: String) {
        guard let idx = accounts.firstIndex(where: { $0.id == accountID }) else { return }
        accounts[idx].token = token
        try? writeTokenKeychain(token, accountID: accountID)
        persist()
    }

    // MARK: - persistence

    private func load() {
        let d = UserDefaults.standard
        if let data = d.data(forKey: Self.accountsKey),
           let decoded = try? JSONDecoder().decode([Account].self, from: data) {
            accounts = decoded.map { acct in
                var a = acct
                a.token = (try? readTokenKeychain(accountID: a.id)) ?? ""
                return a
            }
        }
        currentID = d.string(forKey: Self.currentIDKey) ?? accounts.first?.id
    }

    private func persist() {
        let d = UserDefaults.standard
        if let data = try? JSONEncoder().encode(accounts) {
            d.set(data, forKey: Self.accountsKey)
        }
        if let id = currentID {
            d.set(id, forKey: Self.currentIDKey)
        } else {
            d.removeObject(forKey: Self.currentIDKey)
        }
    }

    // MARK: - token keychain

    private func writeTokenKeychain(_ token: String, accountID: String) throws {
        let q: [String: Any] = [
            kSecClass as String:        kSecClassGenericPassword,
            kSecAttrService as String:  Self.tokenKcService,
            kSecAttrAccount as String:  accountID
        ]
        SecItemDelete(q as CFDictionary)
        var add = q
        add[kSecValueData as String]      = Data(token.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }

    private func readTokenKeychain(accountID: String) throws -> String {
        let q: [String: Any] = [
            kSecClass as String:        kSecClassGenericPassword,
            kSecAttrService as String:  Self.tokenKcService,
            kSecAttrAccount as String:  accountID,
            kSecReturnData as String:   true,
            kSecMatchLimit as String:   kSecMatchLimitOne
        ]
        var out: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        guard status == errSecSuccess, let data = out as? Data,
              let s = String(data: data, encoding: .utf8) else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        return s
    }

    @discardableResult
    private func deleteTokenKeychain(accountID: String) -> OSStatus {
        let q: [String: Any] = [
            kSecClass as String:        kSecClassGenericPassword,
            kSecAttrService as String:  Self.tokenKcService,
            kSecAttrAccount as String:  accountID
        ]
        return SecItemDelete(q as CFDictionary)
    }
}
