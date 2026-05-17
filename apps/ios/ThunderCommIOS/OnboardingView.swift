// OnboardingView.swift
//
// First-run setup for a new account on this device.
//
// Five steps:
//   1. Gateway URLs        (defaults: wss://relay.thunderai.us + https://relay.thunderai.us)
//   2. Gateway token       (paste or scan; we don't validate format)
//   3. Display name
//   4. Connect test        (WS handshake AND GET /api/inbox?since=0 must succeed)
//   5. Done                (saves Account + dismisses)
//
// Multi-device note: this view is reachable both for first-run *and* from a
// future "Add another account" entry in settings, so it does NOT assume an
// empty AccountStore.

import SwiftUI

public struct OnboardingView: View {

    public init(onComplete: @escaping (Account) -> Void = { _ in }) {
        self.onComplete = onComplete
    }

    private let onComplete: (Account) -> Void

    @State private var step: Step = .gateway
    @State private var wsURL: String = "wss://relay.thunderai.us"
    @State private var httpURL: String = "https://relay.thunderai.us"
    @State private var token: String = ""
    @State private var displayName: String = ""
    @State private var testState: TestState = .idle
    @State private var savedAccount: Account?
    @State private var notificationsRequested: Bool = false

    private enum Step: Int, CaseIterable {
        case gateway, token, name, test, notifications, done
    }

    private enum TestState: Equatable {
        case idle, running, success, failure(String)
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                header
                progressBar
                content
                Spacer()
                navButtons
            }
            .padding()
            .navigationTitle("Set up account")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    // MARK: - layout

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "bolt.fill")
                .foregroundStyle(.yellow)
                .font(.title2)
            Text("ThunderCommo")
                .font(.title2.bold())
            Spacer()
        }
    }

    private var progressBar: some View {
        VStack(spacing: 6) {
            HStack(spacing: 6) {
                ForEach(Step.allCases, id: \.rawValue) { s in
                    Capsule()
                        .fill(s.rawValue <= step.rawValue ? Color.accentColor : Color.gray.opacity(0.25))
                        .frame(height: 4)
                }
            }
            HStack {
                Text("Step \(step.rawValue + 1) of \(Step.allCases.count)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer()
                Text(stepTitle)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var stepTitle: String {
        switch step {
        case .gateway:       return "Gateway"
        case .token:         return "Token"
        case .name:          return "Name"
        case .test:          return "Connect test"
        case .notifications: return "Notifications"
        case .done:          return "Done"
        }
    }

    @ViewBuilder
    private var content: some View {
        switch step {
        case .gateway:       gatewayStep
        case .token:         tokenStep
        case .name:          nameStep
        case .test:          testStep
        case .notifications: notificationsStep
        case .done:          doneStep
        }
    }

    // Apple shows the system permission alert once per install; route the
    // user through a primer first so the prompt arrives expected. Silent push
    // works without alert permission, but we still want users to opt into
    // visible alerts so they actually see new messages.
    private var notificationsStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Stay in the loop").font(.headline)
            Text("ThunderCommo needs notifications to deliver messages when the app is in the background. Without this, you'll only see new messages the next time you open the app.")
                .font(.subheadline).foregroundStyle(.secondary)

            if notificationsRequested {
                Label("Notifications configured", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.title3.weight(.semibold))
            } else {
                Button {
                    requestNotifications()
                } label: {
                    Label("Enable Notifications", systemImage: "bell.badge.fill")
                }
                .buttonStyle(.borderedProminent)

                Text("You can change this later in Settings.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func requestNotifications() {
        Task {
            _ = await APNsManager.shared.requestUserAuthorization()
            notificationsRequested = true
        }
    }

    private var gatewayStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Gateway URLs").font(.headline)
            Text("WebSocket and HTTP endpoints for your relay.")
                .font(.subheadline).foregroundStyle(.secondary)

            Text("WebSocket URL").font(.caption).foregroundStyle(.secondary)
            TextField("wss://relay.thunderai.us", text: $wsURL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
                .keyboardType(.URL)

            Text("HTTP URL").font(.caption).foregroundStyle(.secondary)
            TextField("https://relay.thunderai.us", text: $httpURL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
                .keyboardType(.URL)
        }
    }

    private var tokenStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Gateway token").font(.headline)
            Text("Paste the token issued by your relay admin.").font(.subheadline).foregroundStyle(.secondary)
            TextEditor(text: $token)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .frame(minHeight: 100)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.gray.opacity(0.3)))
            Button {
                if let s = UIPasteboard.general.string {
                    token = s.trimmingCharacters(in: .whitespacesAndNewlines)
                }
            } label: {
                Label("Paste from clipboard", systemImage: "doc.on.clipboard")
            }
        }
    }

    private var nameStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Display name").font(.headline)
            Text("Shown to other users on this account.").font(.subheadline).foregroundStyle(.secondary)
            TextField("e.g. Alex (iPhone)", text: $displayName)
                .textFieldStyle(.roundedBorder)
        }
    }

    private var testStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Connection test").font(.headline)
            Text("We open a WebSocket and call /api/inbox to confirm the gateway and token are valid.")
                .font(.subheadline).foregroundStyle(.secondary)

            Group {
                switch testState {
                case .idle:
                    Button {
                        runConnectTest()
                    } label: {
                        Label("Run connect test", systemImage: "bolt.fill")
                    }
                    .buttonStyle(.borderedProminent)
                case .running:
                    HStack(spacing: 10) {
                        ProgressView()
                            .progressViewStyle(.circular)
                        Text("Connecting…").font(.body)
                    }
                case .success:
                    Label("Connected (WS + inbox OK)", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .font(.title3.weight(.semibold))
                case .failure(let msg):
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Connect failed", systemImage: "xmark.octagon.fill")
                            .foregroundStyle(.red)
                            .font(.title3.weight(.semibold))
                        Text(msg)
                            .font(.callout)
                            .foregroundStyle(.red)
                            .padding(8)
                            .background(Color.red.opacity(0.08))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                        Button {
                            runConnectTest()
                        } label: {
                            Label("Retry", systemImage: "arrow.clockwise")
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }
        }
    }

    private var doneStep: some View {
        VStack(spacing: 16) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 64))
                .foregroundStyle(.green)
            Text("All set").font(.title2.bold())
            if let a = savedAccount {
                Text("Connected as \(a.name)").foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - nav

    private var navButtons: some View {
        HStack {
            if step != .gateway && step != .done {
                Button("Back") { goBack() }
            }
            Spacer()
            Button(primaryButtonTitle) { goForward() }
                .buttonStyle(.borderedProminent)
                .disabled(!canAdvance)
        }
    }

    private var primaryButtonTitle: String {
        switch step {
        case .gateway, .token, .name: return "Next"
        case .test: return testState == .success ? "Finish" : "Skip"
        case .notifications: return notificationsRequested ? "Continue" : "Not now"
        case .done: return "Open ThunderCommo"
        }
    }

    private var canAdvance: Bool {
        switch step {
        case .gateway:
            return !wsURL.trimmingCharacters(in: .whitespaces).isEmpty
                && !httpURL.trimmingCharacters(in: .whitespaces).isEmpty
        case .token:         return !token.trimmingCharacters(in: .whitespaces).isEmpty
        case .name:          return !displayName.trimmingCharacters(in: .whitespaces).isEmpty
        case .test:          return testState != .running
        case .notifications: return true
        case .done:          return savedAccount != nil
        }
    }

    private func goBack() {
        if let prev = Step(rawValue: step.rawValue - 1) { step = prev }
    }

    private func goForward() {
        switch step {
        case .gateway, .token, .name:
            if let next = Step(rawValue: step.rawValue + 1) { step = next }
        case .test:
            saveAccount()
            step = .notifications
        case .notifications:
            step = .done
        case .done:
            if let a = savedAccount { onComplete(a) }
        }
    }

    // MARK: - actions

    private func saveAccount() {
        let account = Account(
            name: displayName.trimmingCharacters(in: .whitespaces),
            wsURL: wsURL.trimmingCharacters(in: .whitespaces),
            httpURL: httpURL.trimmingCharacters(in: .whitespaces),
            token: token.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        AccountStore.shared.add(account, makeCurrent: true)
        // This onboarding flow takes a paste-in relay token, so there's no
        // /api/auth/signup response to read expires_at_ms from. Default to 30
        // days. Once /api/auth/refresh is live the proactive-refresh timer
        // will roll the token forward well before this lapses; if refresh is
        // still missing, the user re-onboards rather than silently running on
        // a 10-year credential the server can never invalidate.
        let thirtyDaysMs = Int64(Date(timeIntervalSinceNow: 30 * 24 * 3600).timeIntervalSince1970 * 1000)
        try? AuthManager.shared.setToken(account.token, expiresAtMs: thirtyDaysMs)
        savedAccount = account
        // The launch-time APNs token upload short-circuited because no account
        // existed yet; now that one does, push the device token to the server.
        APNsManager.shared.retryTokenUploadIfNeeded()
    }

    private func runConnectTest() {
        testState = .running
        let account = Account(
            name: displayName.isEmpty ? "test" : displayName,
            wsURL: wsURL.trimmingCharacters(in: .whitespaces),
            httpURL: httpURL.trimmingCharacters(in: .whitespaces),
            token: token.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        Task.detached { @MainActor in
            await Self.performConnectTest(account: account) { ok, msg in
                testState = ok ? .success : .failure(msg ?? "Unknown error")
            }
        }
    }

    @MainActor
    private static func performConnectTest(
        account: Account,
        completion: @escaping (Bool, String?) -> Void
    ) async {
        // 1. WS handshake.
        guard let wsURL = websocketURL(for: account) else {
            completion(false, "Bad WebSocket URL")
            return
        }
        var wsRequest = URLRequest(url: wsURL)
        wsRequest.setValue("Bearer \(account.token)", forHTTPHeaderField: "Authorization")
        let session = URLSession(configuration: .default)
        let socket = session.webSocketTask(with: wsRequest)
        socket.resume()

        let wsResult: Bool = await withCheckedContinuation { cont in
            var resumed = false

            socket.sendPing { error in
                guard !resumed else { return }
                resumed = true
                socket.cancel(with: .goingAway, reason: nil)
                session.invalidateAndCancel()
                cont.resume(returning: error == nil)
            }

            Task {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                if !resumed {
                    resumed = true
                    socket.cancel(with: .goingAway, reason: nil)
                    session.invalidateAndCancel()
                    cont.resume(returning: false)
                }
            }
        }
        guard wsResult else {
            completion(false, "WebSocket handshake failed within 30s")
            return
        }

        // 2. GET /api/inbox?since=0 → expect 200.
        guard var comps = URLComponents(string: account.httpURL + "/api/inbox") else {
            completion(false, "Bad HTTP URL")
            return
        }
        comps.queryItems = [URLQueryItem(name: "since", value: "0")]
        guard let url = comps.url else {
            completion(false, "Bad HTTP URL")
            return
        }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(account.token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 30
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse else {
                completion(false, "Inbox check: no HTTP response")
                return
            }
            guard http.statusCode == 200 else {
                completion(false, "Inbox check returned HTTP \(http.statusCode)")
                return
            }
            completion(true, nil)
        } catch {
            completion(false, "Inbox check failed: \(error.localizedDescription)")
        }
    }

    private static func websocketURL(for account: Account) -> URL? {
        var value = account.wsURL
        if value.hasPrefix("http://") {
            value = "ws://" + value.dropFirst("http://".count)
        }
        if value.hasPrefix("https://") {
            value = "wss://" + value.dropFirst("https://".count)
        }
        if !value.hasSuffix("/ws") {
            value += "/ws"
        }
        return URL(string: value)
    }
}

// MARK: - Root gate

public struct OnboardingGate<Content: View>: View {
    @StateObject private var store = AccountStore.shared
    @ViewBuilder var content: () -> Content

    public init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    public var body: some View {
        if store.hasAnyAccount {
            content()
        } else {
            OnboardingView { _ in
                // After onboarding, AccountStore is populated and the gate
                // re-renders into the main app.
            }
        }
    }
}
