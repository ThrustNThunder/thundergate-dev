//
//  MessageListView.swift
//  ThunderCommIOS
//
//  Owned by Jon. Renders the message list, streaming rows, thinking dots,
//  and roster presence. Hosts the look-above routing helper called by
//  ComposerBar.
//
//  Ownership boundaries — DO NOT touch these from this file:
//    • ContentView.swift, ComposerBar.swift, SettingsView.swift
//    • MessageBubble.swift, ThunderCommStore.swift, ThunderCommWebSocketClient.swift
//

import SwiftUI

// MARK: - Make Mack's Message engine-compatible

/// One-line conformance so LightweightContextEngine can read what it needs
/// from Message without importing the full type. Requires Message to expose
/// `id`, `agentId`, `sender`, `channel`. See IOS_SLICE_NOTES.md if any of
/// those fields don't exist on the current Message struct.
extension Message: LookAboveMessage {}

// MARK: - View

struct MessageListView: View {

    @ObservedObject var store: ThunderCommStore

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(store.visibleMessages) { message in
                        MessageBubble(message: message)
                            .id(Self.rowID(for: message))
                            .padding(.horizontal, 16)
                    }

                    if let agentId = store.thinkingAgentId {
                        ThinkingDotsRow(
                            agentName: store.displayName(forAgent: agentId) ?? agentId
                        )
                        .id("thinking-\(agentId)")
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                        .transition(.opacity)
                    }
                }
                .padding(.vertical, 8)
            }
            .onChange(of: store.visibleMessages.count) { _ in
                guard let last = store.visibleMessages.last else { return }
                withAnimation(.easeOut(duration: 0.15)) {
                    proxy.scrollTo(Self.rowID(for: last), anchor: .bottom)
                }
            }
            .onChange(of: store.thinkingAgentId) { agentId in
                guard let agentId else { return }
                withAnimation(.easeOut(duration: 0.15)) {
                    proxy.scrollTo("thinking-\(agentId)", anchor: .bottom)
                }
            }
        }
    }

    // MARK: - Row identity (BUG-7 fix)

    /// Stable row identity for SwiftUI diffing.
    ///
    /// CRITICAL: streaming rows must be keyed by message ID, NOT by
    /// `updatedAt` or any timestamp that ticks per delta. With a time-based
    /// ID, SwiftUI tears down and rebuilds the entire row on every delta —
    /// visible churn during long replies, and on weaker devices it starves
    /// the main thread enough that ack handling is delayed past the 12s send
    /// watchdog (W1 in the gate report) and otherwise-fine messages flap
    /// through `.failed`.
    ///
    /// The `streaming-` prefix differentiates in-flight rows from settled
    /// rows — useful if MessageBubble ever wants to style them differently —
    /// while `\(message.id)` keeps identity stable across every delta within
    /// the same message.
    static func rowID(for message: Message) -> String {
        message.isStreaming ? "streaming-\(message.id)" : message.id
    }
}

// MARK: - Look-above public API

extension MessageListView {

    /// Compose-time routing helper. ComposerBar calls this with the current
    /// channel's message list to decide where the in-progress draft goes.
    /// Returns `nil` for broadcast / no-clear-target. Wraps the engine and
    /// adds a debug log so inferred routing is visible during testing.
    static func inferTargetAgent(
        from messages: [Message],
        channel: String
    ) -> String? {
        let result = LightweightContextEngine.inferTargetAgent(
            from: messages, channel: channel
        )
        switch result {
        case .explicit(let id):
            return id
        case .inferred(let id, let confidence):
            #if DEBUG
            print("[look-above] inferred \(id) (confidence \(String(format: "%.2f", confidence))) on channel \(channel)")
            #endif
            return id
        case .none:
            #if DEBUG
            print("[look-above] no agent inferred on channel \(channel) — caller should broadcast")
            #endif
            return nil
        }
    }
}

// MARK: - Thinking dots

private struct ThinkingDotsRow: View {

    let agentName: String

    /// TimelineView drives the redraw cadence. We deliberately avoid
    /// `withAnimation(...).repeatForever` because that pattern breaks if the
    /// row is re-created (which happens whenever thinkingAgentId changes) —
    /// the animation context is lost. TimelineView is stateless and recovers
    /// automatically on re-create.
    var body: some View {
        TimelineView(.animation(minimumInterval: 0.35)) { context in
            let tick = Int(context.date.timeIntervalSinceReferenceDate / 0.35)
            let phase = tick % 3
            HStack(spacing: 6) {
                Text("\(agentName) is thinking")
                    .font(.system(size: 13))
                    .foregroundColor(Color(white: 0.5))
                HStack(spacing: 3) {
                    ForEach(0..<3, id: \.self) { i in
                        Circle()
                            .fill(Color(white: 0.5))
                            .frame(width: 4, height: 4)
                            .opacity(phase == i ? 1.0 : 0.3)
                    }
                }
            }
            .padding(.vertical, 4)
        }
    }
}

// MARK: - Roster presence row

/// Roster row rendered in the sidebar. Value-typed input means SwiftUI
/// re-evaluates only the rows whose presence actually changed — a roster
/// update for a single agent does not redraw the rest of the sidebar.
/// Pair with `ForEach(store.roster) { RosterRow(agent: $0) }` where
/// `AgentPresence` is `Identifiable` (id == agentId).
struct RosterRow: View {

    let agent: AgentPresence

    var body: some View {
        HStack(spacing: 8) {
            PresenceDot(online: agent.isOnline)
            Text(agent.name)
                .font(.system(size: 15, weight: agent.isOnline ? .medium : .regular))
                .foregroundColor(Color(white: 0.85))
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }
}

private struct PresenceDot: View {

    let online: Bool

    var body: some View {
        if online {
            Circle()
                .fill(Color(red: 0.169, green: 0.675, blue: 0.463))
                .frame(width: 9, height: 9)
                .shadow(
                    color: Color(red: 0.169, green: 0.675, blue: 0.463).opacity(0.7),
                    radius: 3
                )
        } else {
            Circle()
                .strokeBorder(Color(white: 0.48), lineWidth: 1.2)
                .frame(width: 9, height: 9)
        }
    }
}
