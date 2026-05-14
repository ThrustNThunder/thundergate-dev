/**
 * VaultProtocol — the live request/response shell around VaultService.
 *
 * The vault module proper (`vault.ts`) only knows about locks, grants,
 * receipts, and decrypt. It has no idea how a user might be asked to
 * unlock, nor how an agent's pending task is resumed after an unlock.
 * This file is that glue: a small orchestrator that turns one shape of
 * call — "I need this PII to complete this task" — into the
 * request/response flow promised by PROTOCOL_VAULT.md.
 *
 * Two paths:
 *   - password   : default for CLI/direct channels. Outbound prompt is a
 *                  human-readable line; the user's next inbound text is
 *                  passed verbatim to VaultService.unlock as the password.
 *   - biometric  : selected when the active channel is ThunderCommo. The
 *                  prompt embeds a JSON `vault_unlock_request` envelope so
 *                  the future iOS handler can pick it up; until Mack
 *                  wires LocalAuthentication, an inbound 'approve' /
 *                  'yes' on the same channel is treated as the approval
 *                  signal and the vault is unlocked using the same
 *                  password seam (the daemon does not yet own the
 *                  device-side wrapped key — Phase 2).
 *
 * The protocol does NOT mock the vault. It really issues a grant, really
 * accesses, and really re-locks after the configured TTL.
 *
 * What is intentionally NOT here:
 *   - Network transport. VaultProtocol returns a `prompt` envelope; the
 *     caller (runtime) is the one that hands it to the channel registry.
 *     Keeping this layer transport-free is what makes the CLI test
 *     command — `thundergate vault test-request` — exercise the same
 *     code path the live channel will run.
 *   - Per-channel deduplication of pending requests beyond "only one
 *     pending per channel id." That is enough for today's use.
 */

import { randomUUID } from 'crypto';
import type { ProvenanceLedger } from '../provenance/ledger.js';
import { WorldState, type PendingVaultRequest } from '../world/state.js';
import {
  VaultBadPasswordError,
  VaultGrantError,
  VaultLockedError,
  VaultService,
  type AccessResponse,
  type DisclosureMode
} from './vault.js';

/** Default lifetime of a pending unlock prompt: 5 minutes. */
const DEFAULT_PROMPT_TTL_MS = 5 * 60 * 1000;

/** Default vault session TTL granted on a successful protocol unlock. */
const DEFAULT_UNLOCK_TTL_MS = 30 * 60 * 1000;

/** Tag used to wrap the unlock-request envelope inside an outbound text
 *  message. ThunderCommo iOS can match the prefix to detect a vault
 *  unlock prompt and switch to the biometric handler instead of showing
 *  a normal chat bubble. Mack: this is your hook. */
export const VAULT_UNLOCK_TAG = '⚡VAULT_UNLOCK_REQUEST';

/** Tokens accepted as the biometric-stub approval. Case-insensitive,
 *  whitespace-trimmed match on the entire inbound message body. */
const BIOMETRIC_APPROVAL_TOKENS = new Set(['approve', 'yes', 'approved']);
const BIOMETRIC_DENIAL_TOKENS = new Set(['deny', 'no', 'denied', 'cancel']);

export interface RequestAccessOptions {
  field_label: string;
  purpose: string;
  channel: string;
  agent_id?: string;
  user?: string;
  /** Disclosure mode bound into the grant. Default 'raw' since the
   *  protocol exists to actually deliver a value back to the caller. */
  disclosure_mode?: DisclosureMode;
  /** Required when disclosure_mode === 'raw'. */
  raw_policy_reason?: string;
  /** Grant TTL once issued. Defaults to 60s — grants are one-shot. */
  grant_ttl_ms?: number;
  /** Unlock TTL when a password/biometric is supplied. */
  unlock_ttl_ms?: number;
}

export interface RequestAccessPending {
  status: 'pending_unlock';
  request_id: string;
  channel: string;
  prompt: {
    /** Human-readable single line for non-ThunderCommo channels. */
    text: string;
    /** Wire envelope mirroring `UnlockRequestEnvelope` so the eventual
     *  iOS Face ID handler can act on a structured payload. */
    envelope: {
      type: 'vault_unlock_request';
      request_id: string;
      task: string;
      reason: string;
      requested_at: number;
      ttl_ms: number;
      mode: 'password' | 'biometric';
    };
    /** When `mode === 'biometric'`, the full outbound text the runtime
     *  should broadcast on the channel. Carries both the embedded
     *  envelope (machine-parseable, fenced) and a human-readable line
     *  so today's pre-handler ThunderCommo client still sees something
     *  sensible. */
    composed_text: string;
  };
  mode: 'password' | 'biometric';
}

export interface RequestAccessResolved {
  status: 'resolved';
  response: AccessResponse;
  /** Captured for caller bookkeeping. */
  field_label: string;
  channel: string;
}

export type RequestAccessResult = RequestAccessPending | RequestAccessResolved;

export interface UnlockResponseAccepted {
  status: 'unlocked';
  request_id: string;
  response: AccessResponse;
  field_label: string;
}

export interface UnlockResponseDenied {
  status: 'denied' | 'bad_password' | 'expired' | 'not_pending';
  request_id?: string;
  reason: string;
}

export type UnlockResponseResult = UnlockResponseAccepted | UnlockResponseDenied;

/**
 * Channel-naming heuristic for the biometric path. ThunderCommo
 * registers its inbound entries under `thundercommo:<id>` and outbound
 * deliveries take `<id>` as the channel. The runtime passes the raw
 * channel id (e.g. `tnt`, `direct:jon`) to `requestAccess`, so we
 * treat anything that isn't `cli`/`test:*` as the biometric path by
 * default. The caller can always override `mode` explicitly.
 */
function pickModeForChannel(channel: string): 'password' | 'biometric' {
  if (channel === 'cli') return 'password';
  if (channel.startsWith('test:')) return 'password';
  // The CLI test command uses channel `cli` so the prompt comes back
  // through the password seam; everything that talks to ThunderCommo
  // (tnt/jmab/direct:*) or any future relay routes through biometric.
  return 'biometric';
}

export class VaultProtocol {
  constructor(
    private readonly vault: VaultService,
    private readonly world: WorldState,
    private readonly ledger: ProvenanceLedger
  ) {}

  /**
   * Ask for a vault field. If the vault is already unlocked, the call
   * issues a grant + access and returns the value-bearing response
   * inline. If the vault is locked, the call records a pending request
   * keyed by `channel` and returns the prompt the caller (runtime/CLI)
   * should hand to the user. The next inbound on that channel — fed to
   * `handleInbound()` — completes the flow.
   */
  requestAccess(opts: RequestAccessOptions): RequestAccessResult {
    const channel = opts.channel.trim();
    if (!channel) throw new Error('channel required for vault.requestAccess');
    const agent_id = opts.agent_id ?? `jon:${channel}`;
    const user = opts.user ?? process.env.USER ?? 'jon';
    const disclosure_mode: DisclosureMode = opts.disclosure_mode ?? 'raw';
    const grant_ttl_ms = opts.grant_ttl_ms ?? 60_000;

    if (this.vault.isUnlocked()) {
      const response = this.issueAndAccess({
        field_label: opts.field_label,
        purpose: opts.purpose,
        channel,
        agent_id,
        user,
        disclosure_mode,
        // The protocol itself is the policy reason when the caller
        // doesn't supply one — every raw access goes through the
        // request/response flow, so its presence is implicit.
        raw_policy_reason:
          opts.raw_policy_reason ?? `vault protocol live request on ${channel}`,
        grant_ttl_ms
      });
      return {
        status: 'resolved',
        response,
        field_label: opts.field_label,
        channel
      };
    }

    // Vault locked — emit a pending request and let the next inbound
    // resolve it. Only one pending request per channel; a fresh request
    // supersedes the prior one (and we log that).
    const existing = this.world.pendingVaultRequests.get(channel);
    if (existing) {
      this.ledger.append({
        actor: 'vault_protocol',
        action: 'pending_request_superseded',
        target: existing.field_label,
        reason: 'new request on same channel',
        data: {
          old_request_id: existing.request_id,
          new_field: opts.field_label,
          channel
        }
      });
    }

    const mode = pickModeForChannel(channel);
    const requested_at = Date.now();
    const ttl_ms = DEFAULT_PROMPT_TTL_MS;
    const pending: PendingVaultRequest = {
      request_id: randomUUID(),
      channel,
      field_label: opts.field_label,
      purpose: opts.purpose,
      agent_id,
      user,
      mode,
      ttl_ms,
      requested_at,
      expires_at: requested_at + ttl_ms
    };
    this.world.pendingVaultRequests.set(channel, pending);

    this.ledger.append({
      actor: 'vault_protocol',
      action: 'pending_request_emitted',
      target: pending.field_label,
      reason: pending.purpose,
      data: {
        request_id: pending.request_id,
        channel: pending.channel,
        mode: pending.mode,
        ttl_ms: pending.ttl_ms,
        agent_id: pending.agent_id
      }
    });

    const envelope = {
      type: 'vault_unlock_request' as const,
      request_id: pending.request_id,
      task: opts.purpose,
      reason: `Jon needs PII labeled '${opts.field_label}'`,
      requested_at,
      ttl_ms,
      mode
    };

    const humanLine =
      mode === 'biometric'
        ? `🔐 Vault access requested for: ${opts.purpose}\n` +
          `Field: ${opts.field_label}\n` +
          `Reply 'approve' or 'yes' to grant access (biometric placeholder).`
        : `🔐 I need your vault password to complete this task: ${opts.purpose}\n` +
          `Reply with your vault password to proceed (or 'cancel' to abort).`;

    // Embed the envelope inside a fenced JSON block prefixed with the
    // tag so the future iOS handler can detect and parse without
    // depending on text format. Plain channels just render the human
    // line and the JSON block as fall-through.
    const composed =
      mode === 'biometric'
        ? `${humanLine}\n\n${VAULT_UNLOCK_TAG}\n\`\`\`json\n${JSON.stringify(envelope, null, 2)}\n\`\`\``
        : humanLine;

    return {
      status: 'pending_unlock',
      request_id: pending.request_id,
      channel,
      mode,
      prompt: { text: humanLine, envelope, composed_text: composed }
    };
  }

  /**
   * Read-only accessor. Used by the runtime to decide whether the next
   * inbound on a channel should be diverted to the unlock path.
   */
  getPending(channel: string): PendingVaultRequest | null {
    const p = this.world.pendingVaultRequests.get(channel);
    if (!p) return null;
    if (Date.now() >= p.expires_at) {
      this.world.pendingVaultRequests.delete(channel);
      this.ledger.append({
        actor: 'vault_protocol',
        action: 'pending_request_expired',
        target: p.field_label,
        reason: 'no response within ttl',
        data: { request_id: p.request_id, channel }
      });
      return null;
    }
    return p;
  }

  /**
   * Heuristic the runtime calls before processing a normal inbound. A
   * pending request must exist on the same channel and the message must
   * look like an unlock answer (short body for password; approval token
   * for biometric). We deliberately keep this conservative — the worst
   * case of a missed match is the user re-prompted, never a normal
   * message accidentally treated as a password.
   */
  looksLikeUnlockResponse(channel: string, text: string): boolean {
    const pending = this.getPending(channel);
    if (!pending) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (pending.mode === 'biometric') {
      const lc = trimmed.toLowerCase();
      return (
        BIOMETRIC_APPROVAL_TOKENS.has(lc) ||
        BIOMETRIC_DENIAL_TOKENS.has(lc)
      );
    }
    // Password mode: short reply with no spaces is the natural shape
    // of a password, so we cap at 80 chars / single line / first word.
    if (trimmed.includes('\n')) return false;
    if (trimmed.length > 80) return false;
    return true;
  }

  /**
   * Consume an inbound message believed to be the response to a pending
   * vault unlock request. Returns the resolved access response on
   * success, or a structured denial reason. Always clears the pending
   * state regardless of outcome — no replay attempts on the same
   * prompt.
   */
  handleInbound(channel: string, text: string): UnlockResponseResult {
    // Read the raw map (not getPending) so we can tell expired apart
    // from never-existed. getPending sweeps expired rows out as a side
    // effect, which is convenient for the runtime's pre-check but
    // would conflate the two outcomes here.
    const pending = this.world.pendingVaultRequests.get(channel);
    if (!pending) {
      return { status: 'not_pending', reason: 'no pending vault request on channel' };
    }
    // Clear pending immediately so a parallel inbound cannot race.
    this.world.pendingVaultRequests.delete(channel);

    if (Date.now() >= pending.expires_at) {
      this.ledger.append({
        actor: 'vault_protocol',
        action: 'unlock_response_expired',
        target: pending.field_label,
        reason: 'received after ttl',
        data: { request_id: pending.request_id, channel }
      });
      return {
        status: 'expired',
        request_id: pending.request_id,
        reason: 'vault unlock prompt expired before response'
      };
    }

    const trimmed = text.trim();

    if (pending.mode === 'biometric') {
      const lc = trimmed.toLowerCase();
      if (BIOMETRIC_DENIAL_TOKENS.has(lc)) {
        this.ledger.append({
          actor: 'vault_protocol',
          action: 'unlock_denied',
          target: pending.field_label,
          reason: 'biometric denial',
          data: { request_id: pending.request_id, channel }
        });
        return {
          status: 'denied',
          request_id: pending.request_id,
          reason: 'user denied vault access'
        };
      }
      if (!BIOMETRIC_APPROVAL_TOKENS.has(lc)) {
        return {
          status: 'denied',
          request_id: pending.request_id,
          reason: 'biometric prompt response not recognized as approve/deny'
        };
      }
      // Biometric stub: vault still requires a password until Mack
      // wires LocalAuthentication. The protocol can't unlock here on
      // its own — but it can succeed-with-stub by reading the
      // daemon-side password from the THUNDERGATE_VAULT_PASSWORD env
      // when present. If not present, surface a clear error so the
      // operator knows the seam isn't fully wired.
      const stubPassword = process.env.THUNDERGATE_VAULT_PASSWORD;
      if (!stubPassword) {
        this.ledger.append({
          actor: 'vault_protocol',
          action: 'unlock_denied',
          target: pending.field_label,
          reason: 'biometric stub missing THUNDERGATE_VAULT_PASSWORD',
          data: { request_id: pending.request_id, channel }
        });
        return {
          status: 'denied',
          request_id: pending.request_id,
          reason:
            'biometric approval accepted but daemon has no vault password (set THUNDERGATE_VAULT_PASSWORD until iOS keychain lands)'
        };
      }
      return this.tryUnlockAndAccess(pending, stubPassword, {
        biometricToken: `stub:${pending.request_id}`,
        unlockSource: 'biometric'
      });
    }

    // Password mode.
    if (trimmed.toLowerCase() === 'cancel') {
      this.ledger.append({
        actor: 'vault_protocol',
        action: 'unlock_denied',
        target: pending.field_label,
        reason: 'user cancelled at password prompt',
        data: { request_id: pending.request_id, channel }
      });
      return {
        status: 'denied',
        request_id: pending.request_id,
        reason: 'user cancelled vault unlock'
      };
    }
    return this.tryUnlockAndAccess(pending, trimmed, { unlockSource: 'password' });
  }

  /**
   * Compose the user-facing reply for an UnlockResponseResult. The
   * runtime broadcasts this back through the channel that hosted the
   * prompt so the human sees the outcome inline.
   */
  formatOutcome(result: UnlockResponseResult): string {
    switch (result.status) {
      case 'unlocked':
        return `🔓 Vault unlocked. Task completed.`;
      case 'bad_password':
        return `Incorrect vault password. Task cancelled.`;
      case 'denied':
        return `Vault access denied. Task cancelled.`;
      case 'expired':
        return `Vault unlock prompt expired. Task cancelled — please re-issue the request.`;
      case 'not_pending':
        return `No vault unlock was pending — nothing to resume.`;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private tryUnlockAndAccess(
    pending: PendingVaultRequest,
    password: string,
    opts: { biometricToken?: string; unlockSource: 'password' | 'biometric' }
  ): UnlockResponseResult {
    const unlockTtlMs = DEFAULT_UNLOCK_TTL_MS;
    try {
      if (opts.unlockSource === 'biometric') {
        this.vault.unlock({
          source: 'biometric',
          password,
          biometricToken: opts.biometricToken ?? `stub:${pending.request_id}`,
          ttlMs: unlockTtlMs
        });
      } else {
        this.vault.unlock({
          source: 'password',
          password,
          ttlMs: unlockTtlMs
        });
      }
    } catch (err) {
      if (err instanceof VaultBadPasswordError) {
        this.ledger.append({
          actor: 'vault_protocol',
          action: 'unlock_bad_password',
          target: pending.field_label,
          reason: 'wrong password supplied at prompt',
          data: { request_id: pending.request_id, channel: pending.channel }
        });
        return {
          status: 'bad_password',
          request_id: pending.request_id,
          reason: 'incorrect vault password'
        };
      }
      this.ledger.append({
        actor: 'vault_protocol',
        action: 'unlock_failed',
        target: pending.field_label,
        reason: (err as Error).message,
        data: { request_id: pending.request_id, channel: pending.channel }
      });
      return {
        status: 'denied',
        request_id: pending.request_id,
        reason: `unlock failed: ${(err as Error).message}`
      };
    }

    let response: AccessResponse;
    try {
      response = this.issueAndAccess({
        field_label: pending.field_label,
        purpose: pending.purpose,
        channel: pending.channel,
        agent_id: pending.agent_id,
        user: pending.user,
        disclosure_mode: 'raw',
        raw_policy_reason: `vault protocol unlock via ${pending.mode}`,
        grant_ttl_ms: 60_000
      });
    } catch (err) {
      const reason = err instanceof VaultGrantError || err instanceof VaultLockedError
        ? err.message
        : (err as Error).message;
      this.ledger.append({
        actor: 'vault_protocol',
        action: 'access_after_unlock_failed',
        target: pending.field_label,
        reason,
        data: { request_id: pending.request_id, channel: pending.channel }
      });
      return {
        status: 'denied',
        request_id: pending.request_id,
        reason: `unlock ok but access failed: ${reason}`
      };
    }

    this.ledger.append({
      actor: 'vault_protocol',
      action: 'unlock_completed',
      target: pending.field_label,
      reason: pending.purpose,
      data: {
        request_id: pending.request_id,
        channel: pending.channel,
        mode: pending.mode,
        agent_id: pending.agent_id
      }
    });
    return {
      status: 'unlocked',
      request_id: pending.request_id,
      response,
      field_label: pending.field_label
    };
  }

  private issueAndAccess(opts: {
    field_label: string;
    purpose: string;
    channel: string;
    agent_id: string;
    user: string;
    disclosure_mode: DisclosureMode;
    raw_policy_reason?: string;
    grant_ttl_ms: number;
  }): AccessResponse {
    const grant = this.vault.issueGrant({
      user: opts.user,
      agent_id: opts.agent_id,
      channel: opts.channel,
      purpose: opts.purpose,
      field_label: opts.field_label,
      disclosure_mode: opts.disclosure_mode,
      ttl_ms: opts.grant_ttl_ms,
      ...(opts.disclosure_mode === 'raw' && opts.raw_policy_reason
        ? { raw_policy_reason: opts.raw_policy_reason }
        : {})
    });
    return this.vault.access({ grant });
  }
}
