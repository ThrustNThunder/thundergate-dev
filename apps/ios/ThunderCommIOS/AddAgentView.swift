// AddAgentView.swift
//
// Build 55 final: minimal "add an existing agent" form, reached from
// Settings → Agents → "Add agent". The user enters the agent's name, the
// token they want to use to connect, and the session ID their agent gave
// them back. No QR scanner. No relay URL fields. No KYA verification fetch
// — Build 55 final treats the BYOAA verification flow as out of scope and
// stores the connection as-entered. Future builds can re-introduce a
// verification step if needed.

import SwiftUI

public struct AddAgentView: View {

    @Environment(\.dismiss) private var dismiss
    @StateObject private var store = UserStore.shared

    @State private var agentName: String = ""
    @State private var agentEmoji: String = "⚡"
    @State private var token: String = ""
    @State private var sessionID: String = ""
    @State private var isTokenVisible: Bool = false
    @State private var saveError: String?
    @State private var didSave: Bool = false

    public var onAdded: ((AgentConnection) -> Void)?

    public init(onAdded: ((AgentConnection) -> Void)? = nil) {
        self.onAdded = onAdded
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section("Agent") {
                    TextField("Name", text: $agentName)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                    TextField("Emoji", text: $agentEmoji)
                        .autocorrectionDisabled()
                }

                Section {
                    Group {
                        if isTokenVisible {
                            TextField("Bearer token", text: $token)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .font(.callout.monospaced())
                        } else {
                            SecureField("Bearer token", text: $token)
                                .textContentType(.password)
                        }
                    }

                    Button(isTokenVisible ? "Hide token" : "Show token") {
                        isTokenVisible.toggle()
                    }
                    .font(.caption.weight(.semibold))
                } header: {
                    Text("Token")
                } footer: {
                    Text("The bearer token your agent will use to authenticate against the relay.")
                }

                Section {
                    HStack {
                        Text("wss://relay.thunderai.us")
                            .font(.callout.monospaced())
                            .foregroundColor(.secondary)
                        Spacer()
                        Button {
                            UIPasteboard.general.string = "wss://relay.thunderai.us"
                        } label: {
                            Image(systemName: "doc.on.doc")
                        }
                    }
                } header: {
                    Text("Relay URL")
                } footer: {
                    Text("Share this token AND relay URL with your agent. They will need both to connect.")
                }

                Section {
                    TextField("Session ID (optional)", text: $sessionID)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.callout.monospaced())
                } header: {
                    Text("Session")
                } footer: {
                    Text("The session identifier your agent gives you after they connect.")
                }

                if let saveError {
                    Section {
                        Text(saveError)
                            .font(.callout)
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button {
                        save()
                    } label: {
                        Label(didSave ? "Added" : "Add Agent",
                              systemImage: didSave ? "checkmark.circle.fill" : "plus.circle.fill")
                    }
                    .disabled(!isFormValid || didSave)
                }
            }
            .navigationTitle("Add Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private var isFormValid: Bool {
        !agentName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !sessionID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func save() {
        let trimmedName    = agentName.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedEmoji   = agentEmoji.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedToken   = token.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedSession = sessionID.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmedName.isEmpty,
              !trimmedToken.isEmpty,
              !trimmedSession.isEmpty else {
            saveError = "All fields are required."
            return
        }

        // wsURL / httpURL slots are repurposed to carry the agent's session
        // identifier — Build 55 final does not yet model a dedicated
        // sessionID field on AgentConnection, and the existing fields are
        // opaque strings from the storage layer's perspective.
        let connection = AgentConnection(
            agentName: trimmedName,
            agentEmoji: trimmedEmoji.isEmpty ? "⚡" : trimmedEmoji,
            wsURL: trimmedSession,
            httpURL: trimmedSession,
            kya: nil,
            isDefault: false
        )
        store.addAgent(connection, token: trimmedToken)
        didSave = true
        onAdded?(connection)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            dismiss()
        }
    }
}
