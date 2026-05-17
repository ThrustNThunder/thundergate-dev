// NewChannelSheet.swift
//
// P5c — Create-channel UI launched from ChannelListView. Collects a name and a
// multi-select member list (sourced from the local roster/peers via
// ThunderCommStore.orderedPeerIDs), then calls store.createChannel which
// persists locally and broadcasts a channel_created frame for other members.

import SwiftUI

struct NewChannelSheet: View {
    @Environment(\.dismiss) private var dismiss

    let connectionStore: ThunderCommStore

    @State private var channelName = ""
    @State private var selectedMembers: Set<String> = []

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("channel-name", text: $channelName)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Channel")
                } footer: {
                    Text("Lowercase, no spaces. The leading # is added automatically.")
                }

                Section {
                    let peers = candidateMembers
                    if peers.isEmpty {
                        Text("No other peers known yet. The channel will start with just you.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(peers, id: \.self) { peerId in
                            memberRow(peerId)
                        }
                    }
                } header: {
                    Text("Members")
                } footer: {
                    Text("You're added automatically. Privacy is presentation-layer only for v1 — a relay-side filter lands later.")
                }
            }
            .navigationTitle("New Channel")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { create() }
                        .disabled(normalizedName.isEmpty)
                }
            }
        }
    }

    private var candidateMembers: [String] {
        connectionStore.orderedPeerIDs().filter { $0 != connectionStore.peerId }
    }

    private var normalizedName: String {
        channelName
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "#", with: "")
            .lowercased()
    }

    private func memberRow(_ peerId: String) -> some View {
        let isSelected = selectedMembers.contains(peerId)
        return Button {
            toggle(peerId)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(connectionStore.displayName(forParticipantID: peerId))
                        .foregroundStyle(.primary)
                    Text(connectionStore.roleLabel(forParticipantID: peerId))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
        }
    }

    private func toggle(_ peerId: String) {
        if selectedMembers.contains(peerId) {
            selectedMembers.remove(peerId)
        } else {
            selectedMembers.insert(peerId)
        }
    }

    private func create() {
        let members = Array(selectedMembers)
        connectionStore.createChannel(name: normalizedName, members: members)
        dismiss()
    }
}
