import SwiftUI

struct ContentView: View {
    @State private var messages: [ThunderCommMessage] = []
    @State private var draft = ""
    @State private var state: ThunderCommConnectionState = .disconnected

    let localSender = "Michael"

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                Text("ThunderComm")
                    .font(.title2.bold())
                Spacer()
                ConnectionStatusView(state: state)
            }

            ScrollView {
                LazyVStack(spacing: 10) {
                    ForEach(messages) { message in
                        MessageBubble(message: message, localSender: localSender)
                    }
                }
            }

            HStack(spacing: 8) {
                TextField("Send to #tnt", text: $draft, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                Button("Send") {
                    sendDraft()
                }
                .buttonStyle(.borderedProminent)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding()
    }

    private func sendDraft() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        // Wire to ThunderCommWebSocketClient once Xcode project is created.
    }
}
