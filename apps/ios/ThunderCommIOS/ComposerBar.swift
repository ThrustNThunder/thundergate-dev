
import SwiftUI

struct ComposerBar: View {
    @Binding var draft: String
    let placeholder: String
    let send: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField(placeholder, text: $draft, axis: .vertical)
                .lineLimit(1...4)
                .submitLabel(.send)
                .onSubmit(send)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(Color(uiColor: .secondarySystemBackground))
                )

            Button {
                send()
            } label: {
                ZStack {
                    Circle()
                        .fill(isEmpty ? AnyShapeStyle(Color(uiColor: .systemGray4)) : AnyShapeStyle(sendGradient))
                        .frame(width: 36, height: 36)
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                }
            }
            .buttonStyle(.plain)
            .disabled(isEmpty)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(Color(uiColor: .tertiarySystemBackground))
        )
    }

    private var isEmpty: Bool {
        draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var sendGradient: LinearGradient {
        LinearGradient(
            colors: [
                Color(red: 0.66, green: 0.42, blue: 0.98),
                Color(red: 0.92, green: 0.55, blue: 1.0)
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}
