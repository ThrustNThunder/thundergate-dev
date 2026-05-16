
import SwiftUI

extension ThunderCommMessage: LookAboveMessage {}

struct MessageListView: View {
    let messages: [ThunderCommMessage]
    let localSender: String
    let localPeerId: String
    let activeIndicators: [ThunderCommActivityIndicator]
    let streamingPreviews: [ThunderCommStreamingPreview]
    let hasOlderMessages: Bool
    let loadOlderMessages: () -> Void
    let deleteMessage: (ThunderCommMessage) -> Void
    let retryMessage: (ThunderCommMessage) -> Void
    let deliveryState: (ThunderCommMessage) -> ThunderCommDeliveryState?

    @State private var didInitialScroll = false

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 10) {
                    if hasOlderMessages {
                        ProgressView("Loading earlier messages…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 8)
                            .onAppear {
                                guard didInitialScroll else { return }
                                loadOlderMessages()
                            }
                    }

                    ForEach(messages) { message in
                        MessageBubble(
                            message: message,
                            localSender: localSender,
                            localPeerId: localPeerId,
                            deliveryState: deliveryState(message),
                            onDelete: {
                                deleteMessage(message)
                            },
                            onRetry: {
                                retryMessage(message)
                            }
                        )
                        .id(message.id)
                    }

                    ForEach(streamingPreviews) { preview in
                        StreamingPreviewBubble(preview: preview)
                            .id("stream-\(preview.id)")
                    }

                    if !activeIndicators.isEmpty {
                        TypingIndicatorsView(indicators: activeIndicators)
                            .padding(.top, 4)
                            .id("typing-indicators")
                    }
                }
                .padding(.vertical, 4)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Color.clear)
            .onAppear {
                scrollToBottom(proxy: proxy, animated: false)
                DispatchQueue.main.async {
                    didInitialScroll = true
                }
            }
            .onChange(of: messages.last?.id) { _, _ in
                scrollToBottom(proxy: proxy, animated: true)
            }
            .onChange(of: streamingPreviews.map { "\($0.id)-\($0.text)" }.joined(separator: ",")) { _, _ in
                scrollToBottom(proxy: proxy, animated: true)
            }
        }
    }

    private func scrollToBottom(proxy: ScrollViewProxy, animated: Bool) {
        if let lastPreview = streamingPreviews.last {
            let action = {
                proxy.scrollTo("stream-\(lastPreview.id)", anchor: .bottom)
            }
            if animated {
                withAnimation(.easeOut(duration: 0.2)) { action() }
            } else {
                action()
            }
            return
        }

        guard let lastID = messages.last?.id else { return }
        let action = {
            proxy.scrollTo(lastID, anchor: .bottom)
        }
        if animated {
            withAnimation(.easeOut(duration: 0.2)) {
                action()
            }
        } else {
            action()
        }
    }
}

private struct TypingIndicatorsView: View {
    let indicators: [ThunderCommActivityIndicator]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(indicators) { indicator in
                HStack(spacing: 8) {
                    Text(indicator.displayName)
                        .font(.caption.weight(.semibold))
                    ThinkingDotsView(color: color(for: indicator.id, senderType: indicator.senderType))
                }
                .foregroundStyle(color(for: indicator.id, senderType: indicator.senderType))
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func color(for participantID: String, senderType: ThunderCommSenderType) -> Color {
        switch participantID {
        case "jon":
            return Color(red: 0.96, green: 0.82, blue: 0.24)
        case "michael":
            return Color(red: 0.73, green: 0.58, blue: 0.98)
        case "mack":
            return Color(red: 0.47, green: 0.80, blue: 1.0)
        default:
            return senderType == .agent
                ? Color(red: 0.80, green: 0.84, blue: 0.92)
                : Color(red: 0.72, green: 0.72, blue: 0.80)
        }
    }
}

private struct ThinkingDotsView: View {
    let color: Color

    @State private var phase = false

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(color)
                    .frame(width: 6, height: 6)
                    .scaleEffect(phase ? 1.0 : 0.55)
                    .opacity(phase ? 1.0 : 0.35)
                    .animation(
                        .easeInOut(duration: 0.6)
                            .repeatForever()
                            .delay(Double(index) * 0.16),
                        value: phase
                    )
            }
        }
        .onAppear {
            phase = true
        }
    }
}

extension MessageListView {
    static func inferTargetAgent(from messages: [ThunderCommMessage], channel: String) -> String? {
        switch LightweightContextEngine.inferTargetAgent(from: messages, channel: channel) {
        case .explicit(let id):
            return id
        case .inferred(let id, let confidence):
            #if DEBUG
            print("[look-above] inferred \(id) (confidence \(String(format: "%.2f", confidence))) on channel \(channel)")
            #endif
            return id
        case .none:
            #if DEBUG
            print("[look-above] no agent inferred on channel \(channel), caller should broadcast")
            #endif
            return nil
        }
    }
}

private struct StreamingPreviewBubble: View {
    let preview: ThunderCommStreamingPreview

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 6) {
                Text(preview.displayName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(color)
                Text(preview.text)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .italic()
            }
            .padding(12)
            .background(color.opacity(0.14))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            Spacer(minLength: 36)
        }
    }

    private var color: Color {
        switch preview.id {
        case "jon":
            return Color(red: 0.96, green: 0.82, blue: 0.24)
        case "mack":
            return Color(red: 0.47, green: 0.80, blue: 1.0)
        default:
            return preview.senderType == .agent
                ? Color(red: 0.80, green: 0.84, blue: 0.92)
                : Color(red: 0.72, green: 0.72, blue: 0.80)
        }
    }
}
