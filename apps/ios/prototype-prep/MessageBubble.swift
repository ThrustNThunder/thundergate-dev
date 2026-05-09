import SwiftUI

struct MessageBubble: View {
    let message: ThunderCommMessage
    let localSender: String

    var body: some View {
        HStack {
            if isLocal { Spacer(minLength: 32) }
            VStack(alignment: .leading, spacing: 6) {
                Text(header)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(message.text)
                    .font(.body)
            }
            .padding(12)
            .background(isLocal ? Color.blue.opacity(0.18) : Color.gray.opacity(0.14))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            if !isLocal { Spacer(minLength: 32) }
        }
    }

    private var isLocal: Bool {
        message.sender == localSender
    }

    private var header: String {
        let date = Date(timeIntervalSince1970: TimeInterval(message.timestamp) / 1000)
        return "\(message.sender) • \(date.formatted(date: .omitted, time: .shortened))"
    }
}
