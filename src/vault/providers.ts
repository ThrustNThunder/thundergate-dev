/**
 * Vault Plugin Sockets — open seams for BYOAA + Loop integration.
 *
 * Defined verbatim from THUNDERGATE_BYOAA_LOOP_SPEC.md (locked May 14 2026).
 * Each socket is a typed interface; the V1 concrete implementations in
 * this file are intentionally minimal — they make today's local-only
 * behavior available behind the same API surface that BYOAA / Loop will
 * later fill. Swapping in a non-local provider is therefore a
 * `registry.register…()` call, not a refactor.
 *
 * Four sockets:
 *   1. AuthorizationProvider — who is allowed to unlock the vault?
 *      V1: local password / biometric stub.
 *      V1.5: BYOAA off-chain Ed25519 signed grant from paired device.
 *      V2:   BYOAA on-chain capability with Loop anchoring.
 *
 *   2. ReceiptAnchorProvider — where does proof-of-access live?
 *      V1: local SHA-256 hash chain in vault.db.
 *      V2: Merkle root anchored on Solana via Loop.
 *      V3: ZKP-backed proofs through Loop's clearing house.
 *
 *   3. CapabilityAuthority — who issues / revokes capability grants?
 *      V1: ThunderGate self-issues (the LocalGrantAuthorizer policy).
 *      V1.5: BYOAA issues signed capability grants.
 *      V2:   Loop protocol-level capability classes.
 *
 *   4. ZKProofProvider — prove without revealing.
 *      V1: not available — NullZKProofProvider throws on use.
 *      Future: Loop ZKP layer (Alex's lane).
 *
 * Non-negotiables baked into the V1 impls:
 *   - No PII leaves the machine through any of these calls.
 *   - The local hash chain remains tamper-evident under
 *     `verifyAnchor` even if a future provider also batches roots
 *     elsewhere — local-first is the floor, not the ceiling.
 */

import { randomBytes, randomUUID } from 'crypto';
import type { Database as Db } from 'better-sqlite3';
import { canonicalStringify, hexEqual, sha256Hex } from './crypto.js';
import {
  LocalGrantAuthorizer,
  computeReceiptHash,
  type DisclosureMode,
  type Grant,
  type IssueGrantOptions,
  type Receipt
} from './vault.js';

// ── Socket 1: Authorization Provider ──────────────────────────────────────

/**
 * What a provider sees when ThunderGate asks "may this unlock happen?".
 * Mirrors `UnlockRequestEnvelope` from vault.ts but is the canonical
 * shape carried across the plugin boundary, so providers don't need to
 * import vault internals.
 *
 * The optional `credential` is a private contract between the V1 local
 * provider and the orchestrator (VaultProtocol) — for BYOAA the device
 * collects credentials directly and returns a SignedGrant instead.
 */
export interface VaultUnlockRequest {
  type: 'vault_unlock_request';
  request_id: string;
  task: string;
  reason: string;
  requested_at: number;
  ttl_ms: number;
  mode?: 'password' | 'biometric';
  channel?: string;
  /** V1 local seam only — never serialized off-machine. */
  credential?: {
    source: 'password' | 'biometric';
    password?: string;
    biometricToken?: string;
    unlockTtlMs?: number;
  };
}

export type AuthorizationStatus =
  | 'authorized'
  | 'denied'
  | 'bad_credential'
  | 'expired';

export interface AuthorizationResult {
  status: AuthorizationStatus;
  request_id: string;
  /** Present when status === 'authorized'. The signed grant the caller
   *  must later present (or that the local seam treats as implicit). */
  signedGrant?: SignedGrant;
  /** Free-text reason. Always populated on non-authorized outcomes. */
  reason?: string;
}

/**
 * A capability grant + signature. BYOAA returns one of these from the
 * paired device after a biometric challenge. The V1 local provider
 * synthesizes one with an empty signature so the downstream flow can
 * treat both paths uniformly.
 */
export interface SignedGrant {
  /** Stable id; matches the request that triggered issuance. */
  grant_id: string;
  /** Issuer key id (e.g. BYOAA device pubkey); 'local' for V1. */
  issuer: string;
  /** Subject of the grant — typically the field_label the grant covers. */
  subject: string;
  /** Scope: purpose, channel, agent_id, ttl, etc. Free-form on
   *  purpose — V1 local mirrors what VaultService.issueGrant captures. */
  scope: Record<string, unknown>;
  /** Unix epoch ms when issued. */
  issued_at: number;
  /** Unix epoch ms when the grant expires. */
  expires_at: number;
  /** Ed25519 signature hex over canonical(scope + grant_id + subject +
   *  issued_at + expires_at). Empty for V1 local — the local seam is
   *  trusted by construction. */
  signature: string;
}

export interface AuthorizationProvider {
  requestAuthorization(request: VaultUnlockRequest): Promise<AuthorizationResult>;
  verifyGrant(grant: SignedGrant): Promise<boolean>;
  /** Human-readable kind for the doctor / CLI inventory. */
  readonly kind: 'local' | 'byoaa' | 'loop' | 'null';
}

// ── Socket 2: Receipt Anchoring Provider ──────────────────────────────────

export interface AnchorProof {
  /** Where this proof lives. V1 = 'local'; V2 = 'solana'; V3 = 'zkp'. */
  kind: 'local' | 'solana' | 'zkp';
  /** Count of receipts covered. */
  receipt_count: number;
  /** Last receipt_hash anchored — the chain head at anchor time. */
  head_receipt_hash: string;
  /** When the anchor was produced (epoch ms). */
  anchored_at: number;
  /** Implementation-specific extra fields. V1: nothing.
   *  V2: { merkle_root, solana_tx, slot }. V3: { zkp_proof }. */
  extra?: Record<string, unknown>;
}

export interface ReceiptAnchorProvider {
  anchorReceipts(receipts: Receipt[]): Promise<AnchorProof>;
  verifyAnchor(proof: AnchorProof): Promise<boolean>;
  readonly kind: 'local' | 'loop' | 'zkp';
}

// ── Socket 3: Capability Authority ────────────────────────────────────────

/**
 * Capability issuance request. Shape-compatible with VaultService's
 * existing IssueGrantOptions so the V1 local authority can delegate
 * directly to the existing policy code path.
 */
export interface CapabilityRequest {
  user: string;
  agent_id: string;
  channel: string;
  purpose: string;
  field_label: string;
  ttl_ms: number;
  disclosure_mode?: DisclosureMode;
  raw_policy_reason?: string;
  /** Pre-pinned policy hash from BYOAA, if the upstream layer has one. */
  policy_hash?: string;
}

/**
 * A full capability grant ready to be persisted. For V1 this is the
 * same shape as VaultService's `Grant` so the existing schema works
 * without translation.
 */
export type CapabilityGrant = Grant;

export interface CapabilityAuthority {
  issueCapabilityGrant(request: CapabilityRequest): Promise<CapabilityGrant>;
  revokeGrant(grantId: string): Promise<void>;
  readonly kind: 'local' | 'byoaa' | 'loop';
}

// ── Socket 4: ZKP Proof Provider (future) ─────────────────────────────────

export interface PrivateClaim {
  /** What you want to prove (e.g. 'has_valid_ssn'). */
  claim: string;
  /** Public parameters for the claim. */
  publicParameters?: Record<string, unknown>;
}

export interface PrivateWitness {
  /** Private witness data — never leaves the prover. */
  witness: unknown;
}

export interface PublicInputs {
  /** Verifier-side public inputs the proof must commit to. */
  inputs: Record<string, unknown>;
}

export interface ZKProof {
  /** Proof bytes / serialization, hex. */
  proof: string;
  /** Scheme identifier (e.g. 'plonk', 'groth16', 'halo2'). */
  scheme: string;
  /** Public inputs the proof was generated for. */
  publicInputs: PublicInputs;
}

export interface ZKProofProvider {
  generateProof(claim: PrivateClaim, witness: PrivateWitness): Promise<ZKProof>;
  verifyProof(proof: ZKProof, publicInputs: PublicInputs): Promise<boolean>;
  readonly kind: 'null' | 'loop' | 'local';
}

// ── V1 concrete implementations ───────────────────────────────────────────

/**
 * V1 authorization: password / biometric-stub unlock backed by the
 * caller-supplied credential. Delegates the actual key derivation to a
 * caller-provided `unlock` callback — VaultProtocol passes its
 * VaultService.unlock binding here so this file does not import the
 * full VaultService class (and so tests can swap in a fake).
 */
export interface LocalAuthorizationUnlockHandle {
  /** Called with the credential; throws on bad password / token. */
  unlock(opts: {
    source: 'password' | 'biometric';
    password?: string;
    biometricToken?: string;
    ttlMs?: number;
  }): void;
}

export class LocalAuthorizationProvider implements AuthorizationProvider {
  readonly kind = 'local' as const;
  constructor(private readonly handle: LocalAuthorizationUnlockHandle) {}

  async requestAuthorization(
    request: VaultUnlockRequest
  ): Promise<AuthorizationResult> {
    const cred = request.credential;
    if (!cred) {
      // The V1 local seam has no async credential collection — the
      // orchestrator must present a credential alongside the request.
      // We surface this as `denied` rather than throw so the calling
      // code path can record it as an auth failure (not an exception).
      return {
        status: 'denied',
        request_id: request.request_id,
        reason: 'local authorization requires an inline credential'
      };
    }
    try {
      this.handle.unlock({
        source: cred.source,
        ...(cred.password !== undefined ? { password: cred.password } : {}),
        ...(cred.biometricToken !== undefined ? { biometricToken: cred.biometricToken } : {}),
        ...(cred.unlockTtlMs !== undefined ? { ttlMs: cred.unlockTtlMs } : {})
      });
    } catch (err) {
      const name = (err as Error)?.name ?? '';
      const message = (err as Error)?.message ?? 'unknown unlock failure';
      const status: AuthorizationStatus =
        name === 'VaultBadPasswordError' ? 'bad_credential' : 'denied';
      return {
        status,
        request_id: request.request_id,
        reason: message
      };
    }

    const now = Date.now();
    return {
      status: 'authorized',
      request_id: request.request_id,
      signedGrant: {
        grant_id: request.request_id,
        issuer: 'local',
        subject: 'vault_session',
        scope: {
          mode: cred.source,
          channel: request.channel ?? null,
          task: request.task,
          reason: request.reason
        },
        issued_at: now,
        expires_at: now + (cred.unlockTtlMs ?? request.ttl_ms),
        signature: ''
      }
    };
  }

  async verifyGrant(grant: SignedGrant): Promise<boolean> {
    // Local seam: every grant ThunderGate issued itself is trusted.
    // The presence of `issuer === 'local'` and a non-expired window is
    // enough; future providers MUST actually verify the signature.
    if (grant.issuer !== 'local') return false;
    return Date.now() < grant.expires_at;
  }
}

/**
 * V1 anchoring: write receipts directly into vault.db (the existing
 * hash-chain) and verify the chain on demand. The constructor takes a
 * better-sqlite3 handle so we don't have to plumb VaultService back
 * into the provider — the schema (vault_receipts) is part of the V1
 * contract.
 */
export class LocalReceiptAnchorProvider implements ReceiptAnchorProvider {
  readonly kind = 'local' as const;
  constructor(private readonly db: Db) {}

  async anchorReceipts(receipts: Receipt[]): Promise<AnchorProof> {
    if (receipts.length === 0) {
      const head = this.db
        .prepare(
          `SELECT receipt_hash FROM vault_receipts
           ORDER BY accessed_at DESC, rowid DESC LIMIT 1`
        )
        .get() as { receipt_hash: string } | undefined;
      return {
        kind: 'local',
        receipt_count: 0,
        head_receipt_hash: head?.receipt_hash ?? '',
        anchored_at: Date.now()
      };
    }
    const insert = this.db.prepare(
      `INSERT INTO vault_receipts (
         receipt_id, grant_id, field_label, purpose, disclosure_mode,
         accessed_at, agent_id, channel, previous_receipt_hash, receipt_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = this.db.transaction((rows: Receipt[]) => {
      for (const r of rows) {
        insert.run(
          r.receipt_id,
          r.grant_id,
          r.field_label,
          r.purpose,
          r.disclosure_mode,
          r.accessed_at,
          r.agent_id,
          r.channel,
          r.previous_receipt_hash,
          r.receipt_hash
        );
      }
    });
    tx(receipts);
    const last = receipts[receipts.length - 1];
    return {
      kind: 'local',
      receipt_count: receipts.length,
      head_receipt_hash: last.receipt_hash,
      anchored_at: Date.now()
    };
  }

  async verifyAnchor(proof: AnchorProof): Promise<boolean> {
    if (proof.kind !== 'local') return false;
    // Re-walk the chain end-to-end. We mirror VaultService.verifyReceiptChain
    // because the V2 provider may run against a remote anchor without
    // direct DB access; pinning this to the local schema keeps the V1
    // contract self-contained.
    const rows = this.db
      .prepare(
        `SELECT receipt_id, grant_id, field_label, purpose, disclosure_mode,
                accessed_at, agent_id, channel,
                previous_receipt_hash, receipt_hash
         FROM vault_receipts
         ORDER BY accessed_at ASC, rowid ASC`
      )
      .all() as Array<Receipt>;
    let prev: string | null = null;
    for (const r of rows) {
      if ((r.previous_receipt_hash ?? null) !== prev) return false;
      const expected = computeReceiptHash(r);
      if (!hexEqual(expected, r.receipt_hash)) return false;
      prev = r.receipt_hash;
    }
    // If the caller supplied a head hash, confirm the chain ends at it.
    if (proof.head_receipt_hash && prev && prev !== proof.head_receipt_hash) {
      return false;
    }
    return true;
  }
}

/**
 * V1 capability authority: builds + policy-checks grants locally via
 * the existing LocalGrantAuthorizer. Persistence (INSERT into
 * vault_grants) and the `revoked_at` write live in VaultService — the
 * authority's revoke is a no-op for V1 because the local service IS
 * the revocation authority by construction.
 */
export class LocalCapabilityAuthority implements CapabilityAuthority {
  readonly kind = 'local' as const;
  private readonly authorizer = new LocalGrantAuthorizer();

  async issueCapabilityGrant(request: CapabilityRequest): Promise<CapabilityGrant> {
    const opts: IssueGrantOptions = {
      user: request.user,
      agent_id: request.agent_id,
      channel: request.channel,
      purpose: request.purpose,
      field_label: request.field_label,
      ttl_ms: request.ttl_ms,
      ...(request.disclosure_mode !== undefined
        ? { disclosure_mode: request.disclosure_mode }
        : {}),
      ...(request.raw_policy_reason !== undefined
        ? { raw_policy_reason: request.raw_policy_reason }
        : {}),
      ...(request.policy_hash !== undefined ? { policy_hash: request.policy_hash } : {})
    };
    const decision = this.authorizer.authorize(opts);
    if (!decision.allowed) {
      throw new Error(`capability denied: ${decision.reason}`);
    }
    const now = Date.now();
    const mode: DisclosureMode = request.disclosure_mode ?? 'claim';
    return {
      grant_id: randomUUID(),
      user: request.user,
      agent_id: request.agent_id,
      channel: request.channel,
      purpose: request.purpose,
      field_label: request.field_label,
      disclosure_mode: mode,
      ttl_ms: request.ttl_ms,
      granted_at: now,
      expires_at: now + request.ttl_ms,
      nonce: randomHex(16),
      policy_hash: request.policy_hash ?? decision.policy_hash
    };
  }

  async revokeGrant(_grantId: string): Promise<void> {
    // No-op at the authority layer for V1 — the actual `revoked_at`
    // write is owned by VaultService since it holds the DB. Future
    // BYOAA/Loop authorities will publish a signed revocation here.
    return;
  }
}

/** Stub provider — refuses on every call. Swap in a real ZKP layer
 *  when Loop / Alex's tech ships. */
export class NullZKProofProvider implements ZKProofProvider {
  readonly kind = 'null' as const;
  async generateProof(): Promise<ZKProof> {
    throw new Error('ZKP not available in v1, configure a ZKP provider');
  }
  async verifyProof(): Promise<boolean> {
    throw new Error('ZKP not available in v1, configure a ZKP provider');
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Canonical hash helper exposed so future BYOAA / Loop signers can
 * agree on the same canonical bytes a local grant covers without
 * re-deriving the layout each time.
 */
export function canonicalSignedGrantPreimage(
  parts: Omit<SignedGrant, 'signature'>
): string {
  return canonicalStringify({
    grant_id: parts.grant_id,
    issuer: parts.issuer,
    subject: parts.subject,
    scope: parts.scope,
    issued_at: parts.issued_at,
    expires_at: parts.expires_at
  });
}

/**
 * Stable digest of the canonical preimage. Local provider doesn't
 * sign (signature stays empty), but any future provider can feed this
 * into Ed25519.sign() and verifyGrant() can recompute it.
 */
export function signedGrantDigest(parts: Omit<SignedGrant, 'signature'>): string {
  return sha256Hex(canonicalSignedGrantPreimage(parts));
}

function randomHex(n: number): string {
  return randomBytes(n).toString('hex');
}
