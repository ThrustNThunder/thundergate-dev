import SwiftUI
import UIKit

struct MessageBubble: View {
    let message: ThunderCommMessage
    let localSender: String

    @State private var copiedCodeBlockIndex: Int?

    var body: some View {
        HStack {
            if isLocal {
                Spacer(minLength: 36)
            }

            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(senderLine)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(senderColor)
                    Text(timestampText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(messageSegments.enumerated()), id: \.offset) { index, segment in
                        switch segment {
                        case .text(let text):
                            if !text.isEmpty {
                                Text(text)
                                    .font(.body)
                                    .foregroundStyle(.primary)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .contextMenu {
                                        Button("Copy") {
                                            UIPasteboard.general.string = text
                                        }
                                    }
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
            .padding(12)
            .background(bubbleColor)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))

            if !isLocal {
                Spacer(minLength: 36)
            }
        }
    }

    private var messageSegments: [MessageSegment] {
        MessageSegment.parse(message.text)
    }

    private var isLocal: Bool {
        message.senderType == .human && participantKey == localParticipantKey
    }

    private var bubbleColor: Color {
        senderColor.opacity(isLocal ? 0.22 : 0.14)
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
            participantId: nil,
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
