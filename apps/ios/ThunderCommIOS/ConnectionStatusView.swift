import SwiftUI

struct ConnectionStatusView: View {
    let state: ThunderCommConnectionState

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(color)
                .frame(width: 10, height: 10)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.thinMaterial)
        .clipShape(Capsule())
    }

    private var label: String {
        switch state {
        case .disconnected:
            return "Disconnected"
        case .connecting:
            return "Connecting"
        case .authenticating:
            return "Authenticating"
        case .connected:
            return "Connected to #tnt"
        case .reconnecting(let delay):
            return "Reconnecting in \(Int(delay))s"
        case .failed(let message):
            return "Failed: \(message)"
        }
    }

    private var color: Color {
        switch state {
        case .connected:
            return .green
        case .connecting, .authenticating, .reconnecting:
            return .yellow
        case .failed:
            return .red
        case .disconnected:
            return .gray
        }
    }
}
