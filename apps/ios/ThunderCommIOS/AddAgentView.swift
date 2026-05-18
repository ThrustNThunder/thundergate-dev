// AddAgentView.swift
//
// Build 58: "add an agent" form reached from Settings → Agents → "Add
// agent". The user picks a name, pastes (or generates upstream) the
// `tc-a-` token they want to give the agent, and saves. The relay URL is
// shown read-only with a copy button — the user gives the token + the
// relay URL to their agent, and the agent connects to ThunderCommo's
// relay. No session ID, no QR scanner, no KYA verification.

import SwiftUI

public struct AddAgentView: View {

    @Environment(\.dismiss) private var dismiss
    @StateObject private var store = UserStore.shared

    @State private var agentName: String = ""
    @State private var agentEmoji: String = "⚡"
    @State private var token: String = ""
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
                        Text(Account.defaultRelayWSURL)
                            .font(.callout.monospaced())
                            .foregroundColor(.secondary)
                        Spacer()
                        Button {
                            UIPasteboard.general.string = Account.defaultRelayWSURL
                        } label: {
                            Image(systemName: "doc.on.doc")
                        }
                    }
                } header: {
                    Text("Relay URL")
                } footer: {
                    Text("Give this token and relay URL to your agent.")
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
    }

    private func save() {
        let trimmedName  = agentName.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedEmoji = agentEmoji.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmedName.isEmpty, !trimmedToken.isEmpty else {
            saveError = "Name and token are required."
            return
        }

        // Build 58 (brief change #4): the session-ID field is gone. The
        // agent connects to the user's relay using its token + the hardcoded
        // relay URLs, so AgentConnection just records the relay endpoints.
        let connection = AgentConnection(
            agentName: trimmedName,
            agentEmoji: trimmedEmoji.isEmpty ? "⚡" : trimmedEmoji,
            wsURL: Account.defaultRelayWSURL,
            httpURL: Account.defaultRelayHTTPURL,
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
