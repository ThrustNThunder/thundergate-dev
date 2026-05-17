// MyConnectionInfoView.swift
//
// Settings → "My Connection Info". Surfaces ONLY the user's personal `tc-h-`
// session token from AuthManager (the token /api/auth/signup returned at
// account creation). Relay URL is intentionally *not* shown here — per
// Build 55 final, the relay endpoint is exposed in exactly one place:
// Settings → About.
//
// Token rendering: masked by default, with show/hide + copy. The intent is to
// let the user grab their own credential without exposing it during a casual
// shoulder-glance.

import SwiftUI
import UIKit

public struct MyConnectionInfoView: View {

    @StateObject private var auth = AuthManager.shared

    @State private var isTokenVisible: Bool = false
    @State private var didCopyToken: Bool = false

    public init() {}

    public var body: some View {
        Form {
            Section {
                if let token = auth.peekToken(), !token.isEmpty {
                    tokenRow(token: token)
                } else {
                    Text("Sign in to view your token.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Your token")
            } footer: {
                Text("Your personal `tc-h-` token. Treat it like a password — anyone with it can connect as you.")
            }
        }
        .navigationTitle("My Connection Info")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func tokenRow(token: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Group {
                if isTokenVisible {
                    Text(token)
                        .font(.system(.callout, design: .monospaced))
                        .textSelection(.enabled)
                } else {
                    Text(masked(token))
                        .font(.system(.callout, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 12) {
                Button(isTokenVisible ? "Hide" : "Show") {
                    isTokenVisible.toggle()
                }
                .font(.caption.weight(.semibold))
                .buttonStyle(.bordered)

                Button {
                    UIPasteboard.general.string = token
                    didCopyToken = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { didCopyToken = false }
                } label: {
                    Label(didCopyToken ? "Copied" : "Copy Token",
                          systemImage: didCopyToken ? "checkmark.circle.fill" : "doc.on.doc")
                }
                .buttonStyle(.borderedProminent)
                .disabled(didCopyToken)
            }
        }
    }

    private func masked(_ token: String) -> String {
        guard token.count > 12 else { return String(repeating: "•", count: max(token.count, 4)) }
        let head = token.prefix(6)
        let tail = token.suffix(4)
        return "\(head)…\(tail)"
    }
}
