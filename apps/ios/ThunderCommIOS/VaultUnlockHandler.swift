// VaultUnlockHandler.swift
//
// Stateless wrapper around LAContext for agent-initiated vault unlocks.
// Called exclusively from VaultUnlockSheet AFTER the user has tapped the
// in-app Approve button — never directly from a WebSocket frame.
//
// The `localizedReason` passed to evaluatePolicy is constructed app-side from
// the validated VaultUnlockRequest.task field, NOT forwarded raw from the
// network. The server-supplied `reason` is displayed only in the in-app
// confirmation sheet, never on the OS biometric prompt itself.

import Foundation
import LocalAuthentication

@MainActor
final class VaultUnlockHandler {
    static let shared = VaultUnlockHandler()

    private init() {}

    func authenticate(localizedReason: String, completion: @escaping (Bool) -> Void) {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            NSLog("[Vault] biometrics unavailable: \(error?.localizedDescription ?? "unknown")")
            completion(false)
            return
        }
        context.evaluatePolicy(
            .deviceOwnerAuthenticationWithBiometrics,
            localizedReason: localizedReason
        ) { success, evalError in
            if let evalError {
                NSLog("[Vault] biometric evaluation error: \(evalError.localizedDescription)")
            }
            DispatchQueue.main.async { completion(success) }
        }
    }
}
