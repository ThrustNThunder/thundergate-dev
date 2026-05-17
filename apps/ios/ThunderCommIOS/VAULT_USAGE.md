# ThunderCommo Vault Access

The ThunderCommo app supports agent-initiated vault access.

When your agent needs sensitive data (credentials, personal info), the app surfaces an in-app **Vault Access Requested** sheet showing what your agent is asking for. You then explicitly tap **Approve with Face ID** to authenticate, or **Cancel** to deny.

## What you see

The sheet displays three things, rendered by the app from the relay's request:

- **Task** — the short task name the agent is asking to perform.
- **Reason** — the agent's human-readable justification.
- Two buttons: **Approve with Face ID** and **Cancel**.

The Face ID / Touch ID prompt only fires *after* you tap Approve. The system biometric sheet itself is a final confirmation step on top of an in-app, app-controlled preview — the relay never controls the biometric prompt text.

## Outcomes

- **Approve → biometric succeeds** → the app sends `vault_unlock_approval` back to the relay, granting your agent scoped, time-limited access to the requested data.
- **Approve → biometric fails or you cancel the system sheet** → the app sends `vault_unlock_denied`.
- **Cancel** in the in-app sheet → the app sends `vault_unlock_denied`.
- **Swipe-to-dismiss** the in-app sheet → treated as denied.

## Safeguards built into the app

- Requests received while the app is not in the foreground are auto-denied.
- Only one vault request is on screen at a time; additional requests that arrive while one is pending are auto-denied.
- Each request has a server-supplied TTL (capped client-side at 5 minutes). If you do not act in time, the request is auto-denied.
- Recently-seen request IDs are deduplicated to reject replays.
- The reason string from the relay is shown only inside the in-app sheet — it never appears as the sole text on a Face ID system prompt.

You can revoke standing access at any time from your agent's ThunderGate runtime settings.

**No vault menu exists in the app by design.** The vault is an invisible capability — it only surfaces when your agent requests it, and only with the in-app confirmation step described above.
