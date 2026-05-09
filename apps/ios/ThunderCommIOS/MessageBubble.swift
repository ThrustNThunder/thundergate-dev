import SwiftUI

struct MessageBubble: View {
    let message: ThunderCommMessage
    let localSender: String

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
                Text(message.text)
                    .font(.body)
                    .foregroundStyle(.primary)
            }
            .padding(12)
            .background(bubbleColor)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))

            if !isLocal {
                Spacer(minLength: 36)
            }
        }
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
