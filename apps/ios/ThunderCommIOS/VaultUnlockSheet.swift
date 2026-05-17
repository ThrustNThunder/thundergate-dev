// VaultUnlockSheet.swift
//
// In-app confirmation surface for agent-initiated vault unlock. The OS
// biometric prompt only fires after the user explicitly taps "Approve" —
// the server-supplied `reason` is visible inside this sheet, never as the
// sole consent surface on a system biometric overlay.

import SwiftUI

struct VaultUnlockSheet: View {
    let request: VaultUnlockRequest
    let onApprove: () -> Void
    let onDeny: () -> Void

    @State private var isAuthenticating = false

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "lock.shield.fill")
                .font(.system(size: 48, weight: .regular))
                .foregroundStyle(.tint)
                .padding(.top, 32)

            VStack(spacing: 6) {
                Text("Vault Access Requested")
                    .font(.title2.weight(.semibold))
                Text(request.task)
                    .font(.headline)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }

            Text(request.reason)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            Spacer(minLength: 8)

            VStack(spacing: 12) {
                Button {
                    isAuthenticating = true
                    VaultUnlockHandler.shared.authenticate(
                        localizedReason: "Authenticate to approve vault access for \(request.task)"
                    ) { success in
                        isAuthenticating = false
                        if success {
                            onApprove()
                        } else {
                            onDeny()
                        }
                    }
                } label: {
                    Label("Approve with Face ID", systemImage: "faceid")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(isAuthenticating)

                Button(role: .cancel) {
                    onDeny()
                } label: {
                    Text("Cancel")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .disabled(isAuthenticating)
            }
            .padding(.horizontal)
            .padding(.bottom, 24)
        }
        // Block swipe-to-dismiss while the OS biometric sheet is up so the
        // user can't accidentally cancel mid-evaluation.
        .interactiveDismissDisabled(isAuthenticating)
        .presentationDetents([.medium])
    }
}
