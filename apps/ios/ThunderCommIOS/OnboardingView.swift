// OnboardingView.swift
//
// Build 58: post-signup wizard that runs AFTER SignUpView completes.
// Three screens, in order:
//
//   1. Your Token   — show the user's `tc-h-` session token + copy button +
//                     banner explaining what to do with it
//   2. Add Agent    — optional. Generate a `tc-a-` agent token, see the
//                     relay URL with a copy button, then Save to register
//                     the agent locally. "Skip for now" bails to chat.
//   3. Done         — momentary "you're all set" pulse before handing back
//                     to ContentView
//
// What this file does NOT do:
//   - No session ID field. The user gives their agent the tc-a- token + the
//     relay URL and that's enough — the agent connects directly to the
//     relay.
//   - No hardcoded Jon agent token, no hardcoded agent seeding into
//     AccountStore beyond the user's own tc-h- account.
//   - No auto-add of a default agent. If the user skips, only the tc-h-
//     account seeded at signup lives in AccountStore.

import SwiftUI
import UIKit

public struct OnboardingView: View {

    public init(onFinished: @escaping () -> Void) {
        self.onFinished = onFinished
    }

    private let onFinished: () -> Void

    private enum Step: Int { case yourToken, addAgent, done }

    @State private var step: Step = .yourToken

    @State private var generatedAgentToken: String?
    @State private var agentLabel: String = ""
    @State private var didCopyAgentToken: Bool = false
    @State private var didCopyHumanToken: Bool = false
    @State private var didCopyRelayURL: Bool = false
    @State private var isTokenVisible: Bool = false
    @State private var saveError: String?

    public var body: some View {
        NavigationStack {
            VStack {
                switch step {
                case .yourToken: yourTokenScreen
                case .addAgent:  addAgentScreen
                case .done:      doneScreen
                }
            }
            .animation(.easeInOut, value: step)
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    // MARK: - Screen 1: Your Token

    private var yourTokenScreen: some View {
        VStack(alignment: .leading, spacing: 18) {
            header(title: "Your token", subtitle: "This is your personal connection token.")

            tokenCard

            banner("Share this token with your agent in their chat window or TUI interface.")

            Spacer()

            Button {
                step = .addAgent
            } label: {
                Label("Next", systemImage: "arrow.right")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .padding()
    }

    private var tokenCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Group {
                if let token = AuthManager.shared.peekToken(), !token.isEmpty {
                    if isTokenVisible {
                        Text(token)
                            .font(.system(.callout, design: .monospaced))
                            .textSelection(.enabled)
                    } else {
                        Text(masked(token))
                            .font(.system(.callout, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Text("No token on this device yet.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color(uiColor: .secondarySystemBackground))
            )

            if let token = AuthManager.shared.peekToken(), !token.isEmpty {
                HStack(spacing: 12) {
                    Button(isTokenVisible ? "Hide" : "Show") {
                        isTokenVisible.toggle()
                    }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.bordered)

                    Button {
                        UIPasteboard.general.string = token
                        didCopyHumanToken = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { didCopyHumanToken = false }
                    } label: {
                        Label(didCopyHumanToken ? "Copied" : "Copy Token",
                              systemImage: didCopyHumanToken ? "checkmark.circle.fill" : "doc.on.doc")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(didCopyHumanToken)
                }
            }
        }
    }

    // MARK: - Screen 2: Add Agent

    private var addAgentScreen: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header(title: "Connect an agent", subtitle: "Optional — you can skip and add one later.")

                VStack(alignment: .leading, spacing: 10) {
                    Text("Give your agent a token")
                        .font(.headline)

                    TextField("Agent name", text: $agentLabel)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder)

                    Button {
                        generateAgentToken()
                    } label: {
                        Label("Generate Agent Token", systemImage: "bolt.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(agentLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                    if let token = generatedAgentToken {
                        agentTokenCard(token: token)
                        relayURLRow
                        banner("Give this token and relay URL to your agent.")

                        if let saveError {
                            Text(saveError)
                                .font(.caption)
                                .foregroundStyle(.red)
                        }

                        Button {
                            saveAgent()
                        } label: {
                            Label("Save Agent", systemImage: "checkmark.circle.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .padding(.top, 4)
                    }
                }

                Button("Skip for now") {
                    step = .done
                }
                .buttonStyle(.borderless)
                .frame(maxWidth: .infinity)
                .padding(.top, 6)
            }
            .padding()
        }
    }

    // Build 58 (brief change #3): the relay URL is the second half of what the
    // user hands to their agent — they need the agent token AND this URL to
    // connect. Read-only, copy button, no editing path.
    private var relayURLRow: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Relay URL").font(.caption).foregroundStyle(.secondary)
                Text(Account.defaultRelayWSURL)
                    .font(.callout.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            Spacer()
            Button {
                UIPasteboard.general.string = Account.defaultRelayWSURL
                didCopyRelayURL = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { didCopyRelayURL = false }
            } label: {
                Image(systemName: didCopyRelayURL ? "checkmark.circle.fill" : "doc.on.doc")
            }
            .accessibilityLabel(didCopyRelayURL ? "Copied" : "Copy relay URL")
        }
        .padding(.top, 4)
    }

    private func agentTokenCard(token: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(token)
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color(uiColor: .secondarySystemBackground))
                )

            Button {
                UIPasteboard.general.string = token
                didCopyAgentToken = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { didCopyAgentToken = false }
            } label: {
                Label(didCopyAgentToken ? "Copied" : "Copy Token",
                      systemImage: didCopyAgentToken ? "checkmark.circle.fill" : "doc.on.doc")
            }
            .buttonStyle(.borderedProminent)
            .disabled(didCopyAgentToken)
        }
    }

    // MARK: - Screen 3: Done

    private var doneScreen: some View {
        VStack(spacing: 22) {
            Spacer()
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 80))
                .foregroundStyle(.green)
            Text("You're all set")
                .font(.largeTitle.bold())
            Text("Your chat is empty until you start a conversation.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
            Spacer()
            Button {
                onFinished()
            } label: {
                Label("Open ThunderCommo", systemImage: "bolt.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .padding()
    }

    // MARK: - Shared helpers

    private func header(title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.largeTitle.bold())
            Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 8)
    }

    private func banner(_ text: String) -> some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.primary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.accentColor.opacity(0.12))
            )
    }

    private func masked(_ token: String) -> String {
        guard token.count > 12 else { return String(repeating: "•", count: max(token.count, 4)) }
        let head = token.prefix(6)
        let tail = token.suffix(4)
        return "\(head)…\(tail)"
    }

    // MARK: - Actions

    private func generateAgentToken() {
        let trimmed = agentLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        generatedAgentToken = "tc-a-\(UUID().uuidString.lowercased())"
        didCopyAgentToken = false
        saveError = nil
    }

    // Build 58: replaces the prior session-ID "Connect" step. The agent
    // connects to the user's relay using the generated tc-a- token plus the
    // hardcoded relay URL; the iOS side doesn't need a session id back, so
    // the AgentConnection carries the relay URLs directly.
    private func saveAgent() {
        saveError = nil
        let name = agentLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, let token = generatedAgentToken else {
            saveError = "Generate a token first."
            return
        }
        let connection = AgentConnection(
            agentName: name,
            agentEmoji: "⚡",
            wsURL: Account.defaultRelayWSURL,
            httpURL: Account.defaultRelayHTTPURL,
            kya: nil,
            isDefault: false
        )
        UserStore.shared.addAgent(connection, token: token)
        step = .done
    }
}

// MARK: - OnboardingGate
//
// Build 55 final: defensive gate that only checks the user has a `tc-h-`
// session token. AuthGate is the upstream gate that handles sign-up /
// sign-in; this gate exists to make sure ContentView is never rendered for
// a logged-out device even if AuthGate's state goes stale. No AccountStore
// seeding, no default agent — the user starts with an empty roster.

public struct OnboardingGate<Content: View>: View {
    @StateObject private var auth = AuthManager.shared
    @ViewBuilder var content: () -> Content

    public init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    public var body: some View {
        if auth.peekToken() != nil {
            content()
        } else {
            SignUpView()
        }
    }
}
