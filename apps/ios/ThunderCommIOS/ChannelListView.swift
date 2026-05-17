// ChannelListView.swift
//
// P5c — Replaces the previous AddChannelView sheet. Lists the channels the
// local user is a member of (plus default channels visible to everyone),
// shows member count per channel, and lets the user create a new channel.
// Tapping a channel switches the chat route and dismisses the sheet.

import SwiftUI

struct ChannelListView: View {
    @Environment(\.dismiss) private var dismiss

    let connectionStore: ThunderCommStore

    @State private var showingNewChannel = false

    var body: some View {
        NavigationStack {
            List {
                Section("Your Channels") {
                    ForEach(connectionStore.visibleChannels) { channel in
                        Button {
                            selectChannel(channel)
                        } label: {
                            channelRow(channel)
                        }
                    }
                }

                Section {
                    Button {
                        showingNewChannel = true
                    } label: {
                        Label("New Channel", systemImage: "plus.circle.fill")
                    }
                } footer: {
                    Text("Channels are member-scoped — only invited members see them.")
                }
            }
            .navigationTitle("Channels")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(isPresented: $showingNewChannel) {
                NewChannelSheet(connectionStore: connectionStore)
            }
        }
    }

    private func channelRow(_ channel: ThunderChannel) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "number")
                .foregroundStyle(.secondary)
                .frame(width: 22)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text("#\(channel.name)")
                        .foregroundStyle(.primary)
                    if channel.isDefault {
                        Text("DEFAULT")
                            .font(.caption2.bold())
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.tint.opacity(0.2))
                            .clipShape(Capsule())
                    }
                }
                Text(memberSummary(for: channel))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()
        }
    }

    private func memberSummary(for channel: ThunderChannel) -> String {
        if channel.isDefault && channel.members.isEmpty {
            return "Everyone"
        }
        let count = channel.members.count
        return "\(count) member\(count == 1 ? "" : "s")"
    }

    private func selectChannel(_ channel: ThunderChannel) {
        switch channel.id {
        case "tnt":
            connectionStore.setRoute(.tnt)
        case "jmab":
            connectionStore.setRoute(.jmab)
        default:
            connectionStore.setRoute(.channel, channelName: channel.id)
        }
        dismiss()
    }
}
