# Vault Protocol — Live Request/Response Flow

ThunderGate's vault is a real service now, not a shell. When an agent
task needs PII, the request/response flow below runs through
`VaultProtocol` (`src/vault/protocol.ts`), which the runtime wires up
during `start()` and consults inside `handleChannelInbound` before any
normal processing.

This file is the contract iOS / ThunderCommo implements against. The
relay/bridge sources are intentionally not touched — the unlock prompt
is just a normal outbound message whose text carries an embedded
`vault_unlock_request` envelope.

## Cycle

1. An agent (or the CLI test command) calls
   `VaultProtocol.requestAccess({ field_label, purpose, channel, … })`.
2. If the vault is already unlocked AND a valid grant can be issued,
   the call returns `{ status: 'resolved', response }` synchronously
   and the agent uses the value immediately.
3. If the vault is locked, the protocol records a `PendingVaultRequest`
   on `WorldState.pendingVaultRequests[channel]`, ledgers
   `pending_request_emitted`, and returns
   `{ status: 'pending_unlock', request_id, prompt: { … } }`.
4. The caller hands `prompt.composed_text` (or `prompt.text` on plain
   channels) to the channel registry. The user sees a chat-bubble-style
   prompt on whichever channel issued the request.
5. The next inbound on that channel hits the runtime, which calls
   `VaultProtocol.looksLikeUnlockResponse(channel, text)`. If true, the
   message is routed to `VaultProtocol.handleInbound(channel, text)`
   instead of normal processing. The user's text never enters the LLM
   path, the promise tracker, or `processMessage`.
6. The protocol attempts to unlock (password or biometric, see below),
   issues a one-shot raw-disclosure grant, accesses the value, ledgers
   `unlock_completed`, and returns
   `{ status: 'unlocked', response }`. The vault stays unlocked for the
   default 30-minute session TTL.
7. The runtime broadcasts the formatted outcome back through the same
   channel. The agent that originally requested the field is the one
   that consumed the value at step 6 — no second round trip.
8. After the unlock TTL elapses, `VaultService.touchExpiry` re-locks
   the vault on the next access attempt.

If the user types the wrong password, the protocol returns
`{ status: 'bad_password' }` and the runtime broadcasts
`"Incorrect vault password. Task cancelled."` on the channel. There is
no retry on the same prompt — pending state is cleared the moment the
inbound is consumed.

## Mode selection

`VaultProtocol` decides between two paths by channel name:

| Channel id pattern        | Mode      | Notes                                                              |
| ------------------------- | --------- | ------------------------------------------------------------------ |
| `cli`                     | password  | Stdin prompts the user for the password verbatim.                  |
| `test:*`                  | password  | Reserved for in-process tests; same shape as `cli`.                |
| anything else             | biometric | ThunderCommo channels (`tnt`, `jmab`, `direct:*`) plus future relays. |

## Password path

Outbound prompt text:

```
🔐 I need your vault password to complete this task: <purpose>
Reply with your vault password to proceed (or 'cancel' to abort).
```

Inbound handling:

- The entire trimmed body of the next inbound is passed to
  `VaultService.unlock({ source: 'password', password, ttlMs: 30 min })`.
- `'cancel'` (case-insensitive) cancels the request cleanly.
- Multi-line responses or bodies longer than 80 chars are rejected by
  `looksLikeUnlockResponse` so a wall-of-text message is never
  accidentally treated as a password.

## Biometric path (ThunderCommo)

Outbound prompt text:

```
🔐 Vault access requested for: <purpose>
Field: <field_label>
Reply 'approve' or 'yes' to grant access (biometric placeholder).

⚡VAULT_UNLOCK_REQUEST
```json
{
  "type": "vault_unlock_request",
  "request_id": "...",
  "task": "<purpose>",
  "reason": "Jon needs PII labeled '<field_label>'",
  "requested_at": 1715731200000,
  "ttl_ms": 300000,
  "mode": "biometric"
}
```

### Mack's seam — where iOS plugs in

The `⚡VAULT_UNLOCK_REQUEST` tag (constant
`VAULT_UNLOCK_TAG` in `src/vault/protocol.ts`) marks an outbound message
as a structured vault prompt. The iOS handler should:

1. Match the tag on inbound `message` envelopes before rendering as a
   normal chat bubble.
2. Parse the fenced JSON block as the
   `vault_unlock_request` envelope.
3. Call `LocalAuthentication` to gate the approval behind Face ID /
   Touch ID.
4. On success, post back a normal `federation_message` whose text body
   is `approve` (or `yes`). On user denial, post `deny` (or `cancel`).
5. Phase 2 (after the iOS keychain lands) replaces step 4 with a
   `vault_unlock_approval` envelope carrying a real signed
   `biometric_token`. The protocol already accepts that envelope shape —
   only the handler in `protocol.ts::handleInbound` needs to switch from
   the keyword-match seam to envelope parsing.

### Daemon-side stub

Until Mack's iOS handler is live, the daemon needs the password to
actually decrypt anything. Set `THUNDERGATE_VAULT_PASSWORD=<password>`
in the systemd environment for the user-approved biometric path to
succeed. If unset, an `approve` reply still ledgers but the protocol
returns:

```
{ status: 'denied',
  reason: "biometric approval accepted but daemon has no vault password
           (set THUNDERGATE_VAULT_PASSWORD until iOS keychain lands)" }
```

This is intentional: silent failure on a security-sensitive path is
worse than a loud one. The seam is documented above; once Phase 2
lands, the env var goes away and the wrapped session key carried in
the approval envelope unlocks the vault directly.

## Wire envelopes (Phase 2 — biometric envelope)

The shape below is what `VaultProtocol` will accept once the iOS
keychain wrapping is in place. The keyword-match seam stays as a
fallback so existing test clients keep working.

### Request — ThunderGate → device

```json
{
  "type": "vault_unlock_request",
  "request_id": "uuid-v4",
  "task": "Send insurance card to clinic intake",
  "reason": "Jon needs PII labeled 'bcbs_member_id'",
  "requested_at": 1715731200000,
  "ttl_ms": 300000,
  "mode": "biometric"
}
```

| Field         | Type    | Notes                                                                    |
| ------------- | ------- | ------------------------------------------------------------------------ |
| `type`        | string  | Constant `"vault_unlock_request"`. Channel routing key.                  |
| `request_id`  | string  | UUID v4. Echoed in the approval so the gateway pairs them.               |
| `task`        | string  | Free-text purpose; surfaced verbatim in the iOS biometric prompt.        |
| `reason`      | string  | Short justification ("Jon needs SSN for tax form"). Shown under `task`.  |
| `requested_at`| number  | `Date.now()` ms. Device drops requests older than 60s as replays.        |
| `ttl_ms`      | number  | How long the prompt remains valid. Default 5 min (300,000).              |
| `mode`        | string  | `'password'` or `'biometric'`. Mostly informational on the device side.  |

### Approval — device → ThunderGate (Phase 2)

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

## Test command

```
thundergate vault test-request --field <label> --purpose '<reason>' [--channel <name>]
```

Drives the full lifecycle in-process:

- `--channel cli` (default) walks the password path — prompts on stdin
  through `promptHidden`, unlocks the vault, issues a grant, accesses
  the value, prints it, re-locks.
- `--channel tnt` (or any non-`cli` value) walks the biometric path —
  synthesizes an `approve` inbound by default (override with
  `--biometric-reply deny` to exercise the denial branch) and verifies
  the prompt embeds the `⚡VAULT_UNLOCK_REQUEST` tag + JSON envelope.

The CLI uses an isolated `WorldState` so it cannot pollute the live
daemon's pending request map even if both are running side by side.

## Lifecycle invariants

- One pending request per channel id at a time. A new request on the
  same channel supersedes the prior one and emits a
  `pending_request_superseded` ledger row.
- Pending requests expire after 5 minutes by default. An inbound that
  arrives later returns `{ status: 'expired' }`.
- The unlock TTL granted on success is 30 minutes; afterward the
  vault re-locks on the next access.
- Receipts (`vault_receipts`) and provenance rows are written for
  every grant + every protocol state transition. The user's password
  / approval text never enters either.

## Out of scope (this build)

- Relay-side persistence of unlock requests.
- Multi-device approval (one device approves, another denies).
- Vault-key wrapping under the device key (Phase 2 — replaces the
  password-required stub).
- An agent-callable surface in the runtime that invokes
  `requestAccess` from inside the LLM loop. The CLI test command is
  the only caller wired today; the channel-side response handling is
  what's live in `runtime.ts`.
