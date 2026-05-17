// OnboardingView.swift
//
// Build 55 final: post-signup wizard that runs AFTER SignUpView completes.
// Three screens, in order:
//
//   1. Your Token   — show the user's `tc-h-` session token + copy button +
//                     banner explaining what to do with it
//   2. Add Agent    — optional. Generate a `tc-a-` agent token + paste an
//                     agent session ID. "Skip for now" bails to chat.
//   3. Done         — momentary "you're all set" pulse before handing back
//                     to ContentView
//
// What this file does NOT do:
//   - No URL fields, no relay-URL display (the relay is shown in Settings →
//     About only).
//   - No hardcoded Jon agent token, no hardcoded agent seeding into
//     AccountStore. The user explicitly opts in by entering a session ID
//     they got from their own agent.
//   - No auto-add of a default agent. If the user skips, AccountStore stays
//     empty until they add one through Settings later.

import SwiftUI
import UIKit

public struct OnboardingView: View {

    public init(onFinished: @escaping () -> Void) {
        self.onFinished = onFinished
    }

    private let onFinished: () -> Void

    private enum Step: Int { case yourToken, addAgent, done }

    @State private var step: Step = .yourToken

    // Add-agent screen state
    @State private var generatedAgentToken: String?
    @State private var agentLabel: String = ""
    @State private var agentSessionID: String = ""
    @State private var didCopyAgentToken: Bool = false
    @State private var didCopyHumanToken: Bool = false
    @State private var isTokenVisible: Bool = false
    @State private var connectError: String?

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
                    Text("Step 1 — Give your agent a token")
                        .font(.headline)

                    TextField("Agent name (e.g. Jon, Mack, Rex)", text: $agentLabel)
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
                        banner("Post this token to your agent.")
                    }
                }

                Divider().padding(.vertical, 6)

                VStack(alignment: .leading, spacing: 10) {
                    Text("Step 2 — Connect using their session ID")
                        .font(.headline)

                    Text("Once your agent has the token, paste the session ID they give you back.")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    TextField("Agent session ID", text: $agentSessionID)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.callout.monospaced())
                        .textFieldStyle(.roundedBorder)

                    if let err = connectError {
                        Text(err)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }

                    Button {
                        connectAgent()
                    } label: {
                        Label("Connect", systemImage: "link")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(agentSessionID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                              || generatedAgentToken == nil)
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
        connectError = nil
    }

    private func connectAgent() {
        connectError = nil
        let sessionID = agentSessionID.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = agentLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sessionID.isEmpty, !name.isEmpty, let token = generatedAgentToken else {
            connectError = "Generate a token and paste the agent's session ID first."
            return
        }
        // Save the agent into the user's account. The wsURL/httpURL fields are
        // re-used here to hold the agent session ID — Build 55 doesn't model
        // a separate "session id" field on AgentConnection yet, and Account-
        // Store's connection contract still expects URLs in these slots. The
        // session ID the user pastes is opaque to this view.
        let connection = AgentConnection(
            agentName: name,
            agentEmoji: "⚡",
            wsURL: sessionID,
            httpURL: sessionID,
            kya: nil,
            isDefault: false
        )
        UserStore.shared.addAgent(connection, token: token)
        step = .done
    }
}
