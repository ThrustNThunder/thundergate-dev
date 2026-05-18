# Build 54 — P4 Brief
**Issued by:** Jon | ThunderBase  
**Date:** May 17 2026  
**Task:** Vault unlock — agent-initiated biometric prompt, no menu item

---

## Context
Read https://github.com/ThrustNThunder/cli-jon-context for full project context before starting.

Repo: ThrustNThunder/thundergate-dev, branch: master  
iOS source: apps/ios/ThunderCommIOS/

## What already exists
- `AuthGate.swift` — biometric lock on cold launch (LAContext already wired)
- `AuthManager.swift` — biometric enrollment + auth
- `SignUpView.swift` — biometrics enrollment step
- `SettingsView.swift` — biometricsEnabled toggle

Do NOT touch any of the above. This is a separate, new capability.

## What to build

### The concept
When the relay delivers a message with `type: "vault_unlock_request"`, the app fires a Face ID / Touch ID prompt automatically. No menu. No navigation. Just a system biometric sheet with a reason string. User approves → app sends `vault_unlock_approval` back. User denies → app sends `vault_unlock_denied`.

### Step 1 — Add message type handling in ThunderCommStore or DeliveryCore wire handler

Find where incoming relay messages are dispatched by type. Look for the switch/if-else that handles message types like "message", "system", "roster", "thinking" etc.

Add a new case for `vault_unlock_request`:

Message schema from relay:
```json
{
  "type": "vault_unlock_request",
  "request_id": "string",
  "task": "string",
  "reason": "string — shown to user in Face ID prompt",
  "ttl_ms": 30000
}
```

### Step 2 — VaultUnlockHandler (new file: VaultUnlockHandler.swift)

```swift
import LocalAuthentication
import Foundation

@MainActor
final class VaultUnlockHandler {
    static let shared = VaultUnlockHandler()
    
    func handle(requestId: String, reason: String, reply: @escaping (Bool) -> Void) {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            reply(false)
            return
        }
        context.evaluatePolicy(
            .deviceOwnerAuthenticationWithBiometrics,
            localizedReason: reason
        ) { success, _ in
            DispatchQueue.main.async { reply(success) }
        }
    }
}
```

### Step 3 — Wire reply back through relay

After biometric result, send reply message back through the relay WebSocket:

On success:
```json
{
  "type": "vault_unlock_approval",
  "request_id": "<same request_id>",
  "approved_at": <unix ms timestamp>
}
```

On failure/cancel:
```json
{
  "type": "vault_unlock_denied",
  "request_id": "<same request_id>"
}
```

Use the existing WebSocket send path — find how other outbound messages are sent (look at how chat messages are sent back to relay) and use the same pattern.

### Step 4 — Add VAULT_USAGE.md

Create `apps/ios/ThunderCommIOS/VAULT_USAGE.md`:

```markdown
# ThunderCommo Vault Access

The ThunderCommo app supports agent-initiated vault access.

When your agent needs sensitive data (credentials, personal info), you will receive a Face ID / Touch ID prompt automatically — no navigation required.

- **Approve** → grants your agent scoped, time-limited access to the requested data
- **Deny** → request is rejected, agent is notified

You can revoke standing access at any time from your agent's ThunderGate runtime settings.

**No vault menu exists in the app by design.** The vault is an invisible capability — it only surfaces when your agent requests it.
```

## Constraints
- Do NOT touch AuthGate.swift, AuthManager.swift, SettingsView.swift, SignUpView.swift
- Do NOT add any vault menu item, settings screen, or navigation destination
- VaultUnlockHandler is a new file — do not bolt onto existing auth classes
- Write files directly to repo — do NOT print code to terminal
- No push — write files only, Jon gates the diff

## Files to create/modify
- **NEW:** `apps/ios/ThunderCommIOS/VaultUnlockHandler.swift`
- **NEW:** `apps/ios/ThunderCommIOS/VAULT_USAGE.md`
- **MODIFY:** Whichever file handles incoming relay message dispatch — add `vault_unlock_request` case

## Deliverables
1. Summary of every file changed/created and what changed
2. Confirm VaultUnlockHandler is not wired into any existing auth flow
3. Confirm no menu item or navigation destination was added
