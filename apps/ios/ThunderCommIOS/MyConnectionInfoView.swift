// MyConnectionInfoView.swift
//
// P5b — Settings → "My Connection Info". Read-only display of Michael's own
// relay token and endpoint with copy buttons. Token is sourced from the live
// ThunderCommStore (which layers UserDefaults override on top of the Account
// the user pasted in during onboarding).

import SwiftUI
import UIKit

struct MyConnectionInfoView: View {
    let connectionStore: ThunderCommStore

    @State private var didCopyToken = false
    @State private var didCopyRelay = false

    var body: some View {
        Form {
            Section {
                Text(connectionStore.token.isEmpty ? "—" : connectionStore.token)
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                Button {
                    UIPasteboard.general.string = connectionStore.token
                    didCopyToken = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { didCopyToken = false }
                } label: {
                    Label(didCopyToken ? "Copied" : "Copy Token",
                          systemImage: didCopyToken ? "checkmark.circle.fill" : "doc.on.doc")
                }
                .disabled(connectionStore.token.isEmpty)
            } header: {
                Text("Token")
            } footer: {
                Text("Your personal connection token")
            }

            Section("Relay URL") {
                Text(connectionStore.endpointText.isEmpty ? "—" : connectionStore.endpointText)
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                Button {
                    UIPasteboard.general.string = connectionStore.endpointText
                    didCopyRelay = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { didCopyRelay = false }
                } label: {
                    Label(didCopyRelay ? "Copied" : "Copy Relay URL",
                          systemImage: didCopyRelay ? "checkmark.circle.fill" : "doc.on.doc")
                }
                .disabled(connectionStore.endpointText.isEmpty)
            }
        }
        .navigationTitle("My Connection Info")
        .navigationBarTitleDisplayMode(.inline)
    }
}
