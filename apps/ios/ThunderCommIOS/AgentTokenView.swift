// AgentTokenView.swift
//
// P5a — Settings → "Connect an Agent". Generates a client-side `tc-a-<UUID>`
// token Michael can hand to an agent so they can connect to ThunderCommo. No
// server call yet; when /api/tokens/generate-agent ships we swap the local
// UUID for the server response.

import SwiftUI
import UIKit

struct AgentTokenView: View {
    private static let defaultRelayURL = "wss://relay.thunderai.us"

    @State private var agentName = ""
    @State private var generatedToken: String?
    @State private var didCopyToken = false
    @State private var didCopyRelay = false

    var body: some View {
        Form {
            Section("Agent") {
                TextField("Agent name (e.g. Jon, Mack, Rex)", text: $agentName)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
            }

            Section {
                Button {
                    let uuid = UUID().uuidString.lowercased()
                    generatedToken = "tc-a-\(uuid)"
                    didCopyToken = false
                    didCopyRelay = false
                } label: {
                    Label("Generate Token", systemImage: "key.fill")
                }
                .disabled(agentName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            if let token = generatedToken {
                Section("Token") {
                    Text(token)
                        .font(.callout.monospaced())
                        .textSelection(.enabled)
                    Button {
                        UIPasteboard.general.string = token
                        didCopyToken = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { didCopyToken = false }
                    } label: {
                        Label(didCopyToken ? "Copied" : "Copy Token",
                              systemImage: didCopyToken ? "checkmark.circle.fill" : "doc.on.doc")
                    }
                }

                Section("Relay URL") {
                    Text(Self.defaultRelayURL)
                        .font(.callout.monospaced())
                        .textSelection(.enabled)
                    Button {
                        UIPasteboard.general.string = Self.defaultRelayURL
                        didCopyRelay = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { didCopyRelay = false }
                    } label: {
                        Label(didCopyRelay ? "Copied" : "Copy Relay URL",
                              systemImage: didCopyRelay ? "checkmark.circle.fill" : "doc.on.doc")
                    }
                }

                Section {
                    EmptyView()
                } footer: {
                    Text("Send this token to your agent. They'll use it to connect to ThunderCommo.")
                }
            }
        }
        .navigationTitle("Connect an Agent")
        .navigationBarTitleDisplayMode(.inline)
    }
}
