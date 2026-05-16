import SwiftUI
import UIKit

struct MessageBubble: View {
    let message: ThunderCommMessage
    let localSender: String
    let localPeerId: String
    let deliveryState: ThunderCommDeliveryState?
    let onDelete: (() -> Void)?
    let onRetry: (() -> Void)?

    @State private var copiedCodeBlockIndex: Int?

    init(
        message: ThunderCommMessage,
        localSender: String,
        localPeerId: String,
        deliveryState: ThunderCommDeliveryState?,
        onDelete: (() -> Void)? = nil,
        onRetry: (() -> Void)? = nil
    ) {
        self.message = message
        self.localSender = localSender
        self.localPeerId = localPeerId
        self.deliveryState = deliveryState
        self.onDelete = onDelete
        self.onRetry = onRetry
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            if isLocal {
                Spacer(minLength: 52)
            }

            if !isLocal {
                avatarBadge
            }

            VStack(alignment: isLocal ? .trailing : .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if isLocal {
                        Spacer(minLength: 0)
                    }

                    Text(senderLine)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(senderColor)

                    Text(timestampText)
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    if let deliveryState, isLocal {
                        deliveryBadge(for: deliveryState)
                    }
                }
                .frame(maxWidth: .infinity, alignment: isLocal ? .trailing : .leading)

                VStack(alignment: isLocal ? .trailing : .leading, spacing: 10) {
                    ForEach(Array(messageSegments.enumerated()), id: \.offset) { index, segment in
                        switch segment {
                        case .text(let text):
                            if !text.isEmpty {
                                Text(text)
                                    .font(.body)
                                    .foregroundStyle(.primary)
                                    .multilineTextAlignment(isLocal ? .trailing : .leading)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: isLocal ? .trailing : .leading)
                            }
                        case .code(let language, let code):
                            CodeBlockView(
                                language: language,
                                code: code,
                                copied: copiedCodeBlockIndex == index,
                                copyAction: {
                                    UIPasteboard.general.string = code
                                    copiedCodeBlockIndex = index
                                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                                        if copiedCodeBlockIndex == index {
                                            copiedCodeBlockIndex = nil
                                        }
                                    }
                                }
                            )
                        }
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(bubbleColor)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .frame(maxWidth: bubbleMaxWidth, alignment: isLocal ? .trailing : .leading)
            .overlay(alignment: .topTrailing) {
                if isLocal, deliveryState == .failed {
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .background(Circle().fill(Color(uiColor: .secondarySystemBackground)))
                        .offset(x: 6, y: -6)
                }
            }
            .contextMenu {
                Button("Copy") {
                    UIPasteboard.general.string = message.text
                }
                if isLocal, deliveryState == .failed, let onRetry {
                    Button("Retry send", systemImage: "arrow.clockwise") {
                        onRetry()
                    }
                }
                if let onDelete {
                    Button("Delete", role: .destructive) {
                        onDelete()
                    }
                }
            }
            .onTapGesture {
                guard isLocal, deliveryState == .failed, let onRetry else { return }
                onRetry()
            }
            .frame(maxWidth: .infinity, alignment: isLocal ? .trailing : .leading)

            if isLocal {
                avatarBadge
            } else {
                Spacer(minLength: 52)
            }
        }
    }

    private var messageSegments: [MessageSegment] {
        MessageSegment.parse(message.text)
    }

    private var isLocal: Bool {
        guard message.senderType == .human else { return false }

        if let originPeer = message.originPeer?.trimmingCharacters(in: .whitespacesAndNewlines),
           !originPeer.isEmpty,
           originPeer.caseInsensitiveCompare(localPeerId) == .orderedSame {
            return true
        }

        return participantKey == localParticipantKey
    }

    private var bubbleColor: Color {
        isLocal
            ? senderColor.opacity(0.24)
            : Color(uiColor: .tertiarySystemFill).opacity(0.95)
    }

    private var senderLine: String {
        ThunderCommParticipantIdentity.displayName(
            sender: message.sender,
            agentId: message.agentId,
            participantId: message.originPeer,
            senderType: message.senderType
        )
    }

    private var timestampText: String {
        let date = Date(timeIntervalSince1970: TimeInterval(message.timestamp) / 1000)
        return date.formatted(date: .omitted, time: .shortened)
    }

    private var participantKey: String {
        ThunderCommParticipantIdentity.canonicalID(
            sender: message.sender,
            agentId: message.agentId,
            participantId: message.originPeer,
            senderType: message.senderType
        )
    }

    private var localParticipantKey: String {
        ThunderCommParticipantIdentity.canonicalID(
            sender: localSender,
            agentId: nil,
            participantId: localPeerId,
            senderType: .human
        )
    }

    private var senderColor: Color {
        switch participantKey {
        case "jon":
            return Color(red: 0.96, green: 0.82, blue: 0.24)
        case "michael":
            return Color(red: 0.73, green: 0.58, blue: 0.98)
        case "mack":
            return Color(red: 0.47, green: 0.80, blue: 1.0)
        default:
            return message.senderType == .agent
                ? Color(red: 0.80, green: 0.84, blue: 0.92)
                : Color(red: 0.72, green: 0.72, blue: 0.80)
        }
    }

    private var bubbleMaxWidth: CGFloat {
        min(UIScreen.main.bounds.width * 0.74, 360)
    }

    private var avatarBadge: some View {
        ZStack {
            Circle()
                .fill(senderColor.opacity(0.2))
            Text(String(senderLine.prefix(1)).uppercased())
                .font(.caption.weight(.bold))
                .foregroundStyle(senderColor)
        }
        .frame(width: 28, height: 28)
    }

    @ViewBuilder
    private func deliveryBadge(for state: ThunderCommDeliveryState) -> some View {
        switch state {
        case .sending:
            Label("Sending", systemImage: "clock")
                .labelStyle(.iconOnly)
                .foregroundStyle(.secondary)
        case .sent:
            Image(systemName: "checkmark")
                .foregroundStyle(.secondary)
        case .delivered:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.secondary)
        case .failed:
            HStack(spacing: 4) {
                Image(systemName: "arrow.clockwise.circle.fill")
                Text("Tap to retry")
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.red)
        }
    }
}

private enum MessageSegment {
    case text(String)
    case code(language: String?, code: String)

    static func parse(_ text: String) -> [MessageSegment] {
        let parts = text.components(separatedBy: "```")
        guard parts.count > 1 else { return [.text(text)] }

        var segments: [MessageSegment] = []
        for (index, part) in parts.enumerated() {
            if index.isMultiple(of: 2) {
                let cleaned = part.trimmingCharacters(in: .newlines)
                if !cleaned.isEmpty {
                    segments.append(.text(cleaned))
                }
                continue
            }

            let normalized = part.hasPrefix("\n") ? String(part.dropFirst()) : part
            let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false)
            if lines.isEmpty {
                continue
            }

            let firstLine = String(lines[0]).trimmingCharacters(in: .whitespacesAndNewlines)
            let hasLanguage = !firstLine.isEmpty && firstLine.range(of: "^[A-Za-z0-9_+.-]+$", options: .regularExpression) != nil
            let language = hasLanguage ? firstLine : nil
            let codeLines = hasLanguage ? lines.dropFirst() : ArraySlice(lines)
            let code = codeLines.joined(separator: "\n").trimmingCharacters(in: .newlines)
            if !code.isEmpty {
                segments.append(.code(language: language, code: code))
            }
        }

        return segments.isEmpty ? [.text(text)] : segments
    }
}

private struct CodeBlockView: View {
    let language: String?
    let code: String
    let copied: Bool
    let copyAction: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(language ?? "code")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button(copied ? "Copied" : "Copy") {
                    copyAction()
                }
                .font(.caption.weight(.semibold))
                .buttonStyle(.borderless)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.callout, design: .monospaced))
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(10)
        .background(Color.black.opacity(0.16))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}
