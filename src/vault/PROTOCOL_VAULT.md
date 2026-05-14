# Vault unlock protocol

ThunderGate emits `vault_unlock_request` to the active channel when Jon
needs PII while the vault is locked. A paired device (today: ThunderCommo
iOS — Mack's lane) prompts the user for biometric approval and replies
with `vault_unlock_approval`.

This file is the contract Mack implements against. The relay/bridge
sources are intentionally not touched here — message types pass through
the existing federation envelope unchanged.

## Wire envelopes

### Request — ThunderGate → device

```json
{
  "type": "vault_unlock_request",
  "request_id": "uuid-v4",
  "task": "Send insurance card to clinic intake",
  "reason": "Jon needs PII labeled 'bcbs_member_id'",
  "requested_at": 1715731200000,
  "ttl_ms": 1800000
}
```

| Field         | Type    | Notes                                                                    |
| ------------- | ------- | ------------------------------------------------------------------------ |
| `type`        | string  | Constant `"vault_unlock_request"`. Channel routing key.                  |
| `request_id`  | string  | UUID v4. Echoed in the approval so the gateway pairs them.               |
| `task`        | string  | Free-text task description; surfaced verbatim in the iOS biometric prompt. |
| `reason`      | string  | Short justification ("Jon needs SSN for tax form"). Shown under `task`.  |
| `requested_at`| number  | `Date.now()` ms. Device drops requests older than 60s as replays.        |
| `ttl_ms`      | number  | How long the unlock should last on success. Default 30 min (1,800,000).  |

### Approval — device → ThunderGate

```json
{
  "type": "vault_unlock_approval",
  "request_id": "uuid-v4",
  "approved": true,
  "approved_at": 1715731215000,
  "device_id": "ios-mack-iphone-15",
  "device_signature": "base64(...)",
  "biometric_token": "base64(...)"
}
```

| Field              | Type    | Notes                                                                            |
| ------------------ | ------- | -------------------------------------------------------------------------------- |
| `type`             | string  | Constant `"vault_unlock_approval"`.                                              |
| `request_id`       | string  | Must match the originating request.                                              |
| `approved`         | boolean | `false` = user denied at the biometric prompt; ThunderGate logs and stays locked.|
| `approved_at`      | number  | Device-local `Date.now()` ms.                                                    |
| `device_id`        | string  | Stable device identifier from the pairing flow.                                  |
| `device_signature` | string  | Detached signature over `request_id || approved_at` using the device key.        |
| `biometric_token`  | string  | Opaque blob the gateway feeds back into `VaultService.unlock({ source: 'biometric', biometricToken })`. Phase-1 stub: empty string is acceptable while the iOS keychain wrapping work is pending. |

## Lifecycle

1. Jon needs a vault field. CLI/runtime calls `VaultService.access(...)` and
   gets `VaultLockedError`.
2. Caller calls `VaultService.buildUnlockRequest(task, reason)` and forwards
   the envelope through the live channel registry.
3. ThunderGate watches the channel for a matching `vault_unlock_approval`.
4. On `approved: true`, gateway calls
   `VaultService.unlock({ source: 'biometric', biometricToken, ttlMs })`.
5. On `approved: false` or 60s timeout, gateway aborts the access call and
   surfaces a "user denied" error to Jon.
6. Vault stays unlocked for `ttl_ms`, after which `VaultService` auto-locks.

## Phase-1 stub

Until ThunderCommo iOS ships the LocalAuthentication handler, the gateway
side accepts a password as the underlying secret even on the biometric
path (`VaultService.unlock` requires both `password` and
`biometricToken`). The `vault_unlock_request` envelope is real and can be
exercised end-to-end on the relay; the iOS side only needs to round-trip
the approval message and supply a non-empty `biometric_token`.

## Out of scope (this build)

- Relay-side persistence of unlock requests.
- Multi-device approval (one device approves, another denies).
- Vault-key wrapping under the device key (Phase 2 — replaces the
  password-required stub).
