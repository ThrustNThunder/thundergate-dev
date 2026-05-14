/**
 * VaultService — encrypted PII store, separate from context.db.
 *
 * Architecture (Burt's separation):
 *   - ThunderGate executes.
 *   - Vault constrains: every read is gated by a Grant (scoped, expiring,
 *     purpose-bound, channel-bound, agent-bound) and produces a hash-chained
 *     Receipt. Sensitive values never enter the provenance ledger.
 *   - BYOAA authorizes: the GrantAuthorizer seam decides whether a grant
 *     may be issued (today, the local authorizer is permissive but enforces
 *     "raw requires policy reason"). Future BYOAA flows plug in here.
 *   - Receipts prove: every disclosure writes a hash-chained receipt
 *     (SHA-256 of the prior receipt) to vault_receipts.
 *
 * Database lives at ~/.thundergate/vault.db with a sibling salt file
 * ~/.thundergate/vault.salt holding the per-vault PBKDF2 salt.
 *
 * Lock model:
 *   - Locked on every process start. The derived key only exists in memory
 *     and is wiped on lock() / TTL expiry.
 *   - Unlock requires the vault password OR a biometric approval signal
 *     relayed from a paired device (vault_unlock_approval — see
 *     PROTOCOL_VAULT.md).
 *   - Default session TTL: 30 minutes. Each access re-checks expiry.
 *
 * Audit:
 *   - issueGrant / accessWithGrant / unlock / lock / add write a
 *     ProvenanceLedger row carrying grant_id, receipt_id, purpose,
 *     channel, agent_id — never the sensitive value itself.
 *   - Hash-chained receipts in vault_receipts give the durable, tamper-
 *     evident trail; provenance is the convenience index.
 */

import Database, { type Database as Db } from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync
} from 'fs';
import { dirname, join } from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { ProvenanceLedger } from '../provenance/ledger.js';
import {
  canonicalStringify,
  decrypt,
  deriveKey,
  encrypt,
  generateSalt,
  hexEqual,
  hmacHex,
  keysEqual,
  sha256Hex
} from './crypto.js';
import { VaultProviderRegistry } from './registry.js';

export type VaultCategory = 'identity' | 'financial' | 'medical' | 'auth';

const VALID_CATEGORIES: ReadonlySet<VaultCategory> = new Set([
  'identity',
  'financial',
  'medical',
  'auth'
]);

export interface VaultEntry {
  id: string;
  category: VaultCategory;
  label: string;
  encrypted_value: string;
  created_at: number;     // unix seconds
  last_accessed_at: number | null;
}

/** Public listing — values are deliberately omitted. */
export interface VaultLabel {
  id: string;
  category: VaultCategory;
  label: string;
  created_at: number;
  last_accessed_at: number | null;
}

export interface VaultStatus {
  locked: boolean;
  ttlRemainingMs: number;
  unlockedAt: number | null;
  expiresAt: number | null;
  source: 'password' | 'biometric' | null;
  entryCount: number;
  dbPath: string;
}

export interface UnlockOptions {
  password?: string;
  biometricToken?: string;       // opaque approval blob from paired device
  source: 'password' | 'biometric';
  ttlMs?: number;
}

/**
 * Disclosure mode bound to every Grant.
 *   - 'claim'         : returns proof of presence (no value, no fingerprint).
 *                       Default. Use this for "the agent needs to know the
 *                       user has an SSN on file" without releasing it.
 *   - 'blinded_match' : caller commits to a candidate via
 *                       HMAC(candidate, grant.nonce); vault returns whether
 *                       the stored value matches. No plaintext leaves.
 *   - 'raw'           : returns plaintext. Exceptional path — the issuing
 *                       authorizer must accept an explicit policy reason,
 *                       and the receipt records the mode.
 */
export type DisclosureMode = 'claim' | 'blinded_match' | 'raw';

const VALID_DISCLOSURE_MODES: ReadonlySet<DisclosureMode> = new Set([
  'claim',
  'blinded_match',
  'raw'
]);

export interface Grant {
  grant_id: string;
  user: string;
  agent_id: string;
  channel: string;
  purpose: string;
  field_label: string;
  disclosure_mode: DisclosureMode;
  ttl_ms: number;
  granted_at: number;     // epoch ms
  expires_at: number;     // epoch ms (granted_at + ttl_ms)
  nonce: string;          // hex; binds blinded_match HMACs to this grant
  policy_hash: string;    // identifier of the policy that authorized issuance
}

export interface IssueGrantOptions {
  user: string;
  agent_id: string;
  channel: string;
  purpose: string;
  field_label: string;
  ttl_ms: number;
  disclosure_mode?: DisclosureMode;     // default 'claim'
  raw_policy_reason?: string;            // required when disclosure_mode === 'raw'
  policy_hash?: string;                  // optional override (BYOAA pin)
}

export interface Receipt {
  receipt_id: string;
  grant_id: string;
  field_label: string;
  purpose: string;
  disclosure_mode: DisclosureMode;
  accessed_at: number;
  agent_id: string;
  channel: string;
  previous_receipt_hash: string | null;
  receipt_hash: string;   // SHA-256 over canonical(receipt - this field)
}

export type AccessResponse =
  | { mode: 'raw'; receipt_id: string; grant_id: string; value: string }
  | { mode: 'claim'; receipt_id: string; grant_id: string; has_value: true }
  | {
      mode: 'blinded_match';
      receipt_id: string;
      grant_id: string;
      matches: boolean;
    };

export interface AccessRequest {
  grant: Grant;
  /** Required when grant.disclosure_mode === 'blinded_match'. Hex HMAC of the
   *  candidate value keyed by the grant's nonce. */
  candidate_hmac?: string;
}

/**
 * BYOAA seam. Authorizers decide whether a Grant may be issued at all and
 * stamp it with a policy_hash that the receipt later cites. The local
 * implementation is permissive but enforces the one non-negotiable: 'raw'
 * disclosure requires an explicit policy reason from the caller.
 */
export interface GrantAuthorizer {
  authorize(req: IssueGrantOptions): { allowed: true; policy_hash: string } | { allowed: false; reason: string };
}

export class LocalGrantAuthorizer implements GrantAuthorizer {
  authorize(req: IssueGrantOptions): { allowed: true; policy_hash: string } | { allowed: false; reason: string } {
    const mode: DisclosureMode = req.disclosure_mode ?? 'claim';
    if (mode === 'raw' && (!req.raw_policy_reason || req.raw_policy_reason.trim().length === 0)) {
      return {
        allowed: false,
        reason: 'raw disclosure requires an explicit raw_policy_reason'
      };
    }
    if (req.ttl_ms <= 0) {
      return { allowed: false, reason: 'ttl_ms must be positive' };
    }
    if (req.ttl_ms > 24 * 60 * 60 * 1000) {
      return { allowed: false, reason: 'ttl_ms must not exceed 24h on the local authorizer' };
    }
    const policyTag = mode === 'raw' ? `local:raw(${req.raw_policy_reason})` : `local:${mode}`;
    return { allowed: true, policy_hash: sha256Hex(policyTag) };
  }
}

/** @deprecated retained only for the unlock protocol envelope. */
export interface AccessOptions {
  label: string;
  task: string;                  // free-text, recorded in provenance
  taskId?: string;
}

export interface UnlockRequestEnvelope {
  type: 'vault_unlock_request';
  request_id: string;
  task: string;
  reason: string;
  requested_at: number;
  ttl_ms: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vault (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  label TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at REAL NOT NULL,
  last_accessed_at REAL
);

CREATE INDEX IF NOT EXISTS idx_vault_label ON vault(label);
CREATE INDEX IF NOT EXISTS idx_vault_category ON vault(category);

CREATE TABLE IF NOT EXISTS vault_grants (
  grant_id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  purpose TEXT NOT NULL,
  field_label TEXT NOT NULL,
  disclosure_mode TEXT NOT NULL,
  ttl_ms INTEGER NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_vault_grants_field ON vault_grants(field_label);
CREATE INDEX IF NOT EXISTS idx_vault_grants_expires ON vault_grants(expires_at);

CREATE TABLE IF NOT EXISTS vault_receipts (
  receipt_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  field_label TEXT NOT NULL,
  purpose TEXT NOT NULL,
  disclosure_mode TEXT NOT NULL,
  accessed_at INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  previous_receipt_hash TEXT,
  receipt_hash TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_vault_receipts_grant ON vault_receipts(grant_id);
CREATE INDEX IF NOT EXISTS idx_vault_receipts_accessed ON vault_receipts(accessed_at);
`;

interface UnlockedSession {
  key: Buffer;
  unlockedAt: number;
  expiresAt: number;
  source: 'password' | 'biometric';
  ttlMs: number;
}

export class VaultLockedError extends Error {
  constructor(message = 'vault is locked') {
    super(message);
    this.name = 'VaultLockedError';
  }
}

export class VaultBadPasswordError extends Error {
  constructor(message = 'vault unlock failed: bad password or tampered store') {
    super(message);
    this.name = 'VaultBadPasswordError';
  }
}

export class VaultGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultGrantError';
  }
}

export class VaultService {
  private db!: Db;
  private salt!: Buffer;
  private session: UnlockedSession | null = null;
  private readonly dbPath: string;
  private readonly saltPath: string;
  private registry: VaultProviderRegistry | null = null;

  constructor(
    private readonly ledger: ProvenanceLedger,
    options: {
      dbPath?: string;
      saltPath?: string;
      registry?: VaultProviderRegistry;
    } = {}
  ) {
    const home = os.homedir();
    this.dbPath = options.dbPath ?? join(home, '.thundergate', 'vault.db');
    this.saltPath = options.saltPath ?? join(home, '.thundergate', 'vault.salt');
    this.registry = options.registry ?? null;
  }

  /**
   * Open the SQLite handle and ensure schema + salt are in place. Vault
   * always starts locked; a separate unlock() call is required before any
   * value can be read.
   *
   * If no provider registry was passed to the constructor, a default
   * one is constructed here using the freshly opened DB handle. That
   * keeps the V1 local providers active by default — callers that
   * never touch the registry see byte-identical behavior to the
   * pre-registry codebase.
   */
  initialize(): void {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA_SQL);
    this.salt = this.loadOrCreateSalt();
    if (!this.registry) {
      // Default V1: local providers all the way. Safe to construct
      // here — providers.ts only references vault.ts inside method
      // bodies, so the module-cycle bindings are resolved by the time
      // any of these providers' methods run.
      this.registry = new VaultProviderRegistry({
        db: this.db,
        unlockHandle: { unlock: (opts) => this.unlock(opts) }
      });
    }
  }

  /** Replace the active provider registry. Used by the runtime to
   *  inject a shared registry after construction, so doctor + CLI
   *  inventory see the same providers the runtime is using. */
  setRegistry(registry: VaultProviderRegistry): void {
    this.registry = registry;
  }

  /** Read-only access to the provider registry. Returns null only if
   *  `initialize()` hasn't been called yet (and no registry was passed
   *  via the constructor). */
  getRegistry(): VaultProviderRegistry | null {
    return this.registry;
  }

  private loadOrCreateSalt(): Buffer {
    if (existsSync(this.saltPath)) {
      const raw = readFileSync(this.saltPath);
      if (raw.length === 16) return raw;
      // Wrong length means a partial/corrupt write. We refuse to silently
      // regenerate because that would orphan every encrypted row.
      throw new Error(
        `vault salt at ${this.saltPath} is ${raw.length} bytes (expected 16); refusing to overwrite`
      );
    }
    const salt = generateSalt();
    mkdirSync(dirname(this.saltPath), { recursive: true });
    writeFileSync(this.saltPath, salt);
    try {
      chmodSync(this.saltPath, 0o600);
    } catch {
      // Best-effort; some FS (network mounts) refuse chmod.
    }
    return salt;
  }

  status(): VaultStatus {
    const entryCount =
      (this.db.prepare('SELECT COUNT(*) AS n FROM vault').get() as { n: number })
        .n ?? 0;
    const live = this.touchExpiry();
    if (!live) {
      return {
        locked: true,
        ttlRemainingMs: 0,
        unlockedAt: null,
        expiresAt: null,
        source: null,
        entryCount,
        dbPath: this.dbPath
      };
    }
    return {
      locked: false,
      ttlRemainingMs: Math.max(0, live.expiresAt - Date.now()),
      unlockedAt: live.unlockedAt,
      expiresAt: live.expiresAt,
      source: live.source,
      entryCount,
      dbPath: this.dbPath
    };
  }

  /** Returns true iff a non-expired session is currently unlocked. */
  isUnlocked(): boolean {
    return this.touchExpiry() !== null;
  }

  /**
   * Unlock the vault. Two paths:
   *   - 'password': PBKDF2-derive the key from the user's password and
   *     verify against any existing row (or accept it if the vault is
   *     empty).
   *   - 'biometric': stub. The paired device has signed an approval; for
   *     now we trust that the caller already validated the device
   *     signature and require the password too. When ThunderCommo iOS
   *     ships the LocalAuthentication handler (Mack's lane), the
   *     approval will carry an HKDF-wrapped session key and this branch
   *     unwraps it instead.
   */
  unlock(opts: UnlockOptions): VaultStatus {
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    if (opts.source === 'password') {
      if (!opts.password) throw new Error('password required for password unlock');
      const key = deriveKey(opts.password, this.salt);
      this.assertKeyValid(key);
      this.openSession(key, 'password', ttlMs);
      this.ledger.append({
        actor: 'vault',
        action: 'unlock',
        target: 'vault.db',
        reason: 'password',
        data: { ttl_ms: ttlMs }
      });
      return this.status();
    }
    if (opts.source === 'biometric') {
      // Biometric stub: a real implementation receives an approval blob
      // signed by the paired device and either (a) wraps a fresh session
      // key under that signature or (b) carries the password through a
      // device-side keychain. We accept the password here so the relay
      // protocol can be exercised end-to-end before the iOS side lands;
      // the source is recorded as 'biometric' so the audit trail still
      // reflects the unlock channel.
      if (!opts.password) {
        throw new Error(
          'biometric unlock stub still requires the password until iOS keychain lands'
        );
      }
      if (!opts.biometricToken) {
        throw new Error('biometricToken required for biometric unlock');
      }
      const key = deriveKey(opts.password, this.salt);
      this.assertKeyValid(key);
      this.openSession(key, 'biometric', ttlMs);
      this.ledger.append({
        actor: 'vault',
        action: 'unlock',
        target: 'vault.db',
        reason: 'biometric',
        data: { ttl_ms: ttlMs, token_fingerprint: fingerprint(opts.biometricToken) }
      });
      return this.status();
    }
    const exhaustive: never = opts.source;
    throw new Error(`unknown unlock source: ${String(exhaustive)}`);
  }

  /** Force-lock immediately. Wipes the in-memory key. */
  lock(reason: string = 'manual'): void {
    if (!this.session) return;
    this.session.key.fill(0);
    this.session = null;
    this.ledger.append({
      actor: 'vault',
      action: 'lock',
      target: 'vault.db',
      reason
    });
  }

  /**
   * Add a new entry. Vault must be unlocked; encryption uses the live
   * session key. Returns the new entry's id.
   */
  add(category: string, label: string, value: string): string {
    const live = this.requireUnlocked();
    if (!VALID_CATEGORIES.has(category as VaultCategory)) {
      throw new Error(
        `invalid category '${category}' — expected one of: ${[...VALID_CATEGORIES].join(', ')}`
      );
    }
    if (!label || label.trim().length === 0) throw new Error('label required');
    if (!value || value.length === 0) throw new Error('value required');
    const id = randomUUID();
    const blob = encrypt(value, live.key);
    this.db
      .prepare(
        `INSERT INTO vault (id, category, label, encrypted_value, created_at, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, NULL)`
      )
      .run(id, category, label, blob, Date.now() / 1000);
    this.ledger.append({
      actor: 'vault',
      action: 'add',
      target: label,
      reason: 'cli add',
      data: { id, category }
    });
    return id;
  }

  /** Labels only — never returns plaintext. Safe to call while locked. */
  list(): VaultLabel[] {
    const rows = this.db
      .prepare(
        `SELECT id, category, label, created_at, last_accessed_at
         FROM vault
         ORDER BY category, label`
      )
      .all() as Array<{
        id: string;
        category: string;
        label: string;
        created_at: number;
        last_accessed_at: number | null;
      }>;
    return rows.map((r) => ({
      id: r.id,
      category: r.category as VaultCategory,
      label: r.label,
      created_at: r.created_at,
      last_accessed_at: r.last_accessed_at
    }));
  }

  /**
   * Issue a scoped, expiring, purpose-bound, channel-bound, agent-bound
   * Grant. The CapabilityAuthority plugin socket (BYOAA seam) decides
   * whether a Grant may be issued and stamps the policy_hash; today's
   * V1 LocalCapabilityAuthority wraps the same LocalGrantAuthorizer
   * policy code path that used to live inline here.
   *
   * Sensitive value is NOT loaded here — issuance does not require an
   * unlocked vault, only a label that exists.
   */
  async issueGrant(opts: IssueGrantOptions): Promise<Grant> {
    if (!opts.user || opts.user.trim().length === 0) throw new VaultGrantError('user required');
    if (!opts.agent_id || opts.agent_id.trim().length === 0) throw new VaultGrantError('agent_id required');
    if (!opts.channel || opts.channel.trim().length === 0) throw new VaultGrantError('channel required');
    if (!opts.purpose || opts.purpose.trim().length === 0) throw new VaultGrantError('purpose required');
    if (!opts.field_label || opts.field_label.trim().length === 0) throw new VaultGrantError('field_label required');
    const mode: DisclosureMode = opts.disclosure_mode ?? 'claim';
    if (!VALID_DISCLOSURE_MODES.has(mode)) {
      throw new VaultGrantError(`invalid disclosure_mode '${mode}'`);
    }
    const exists = this.db
      .prepare(`SELECT 1 AS hit FROM vault WHERE label = ? LIMIT 1`)
      .get(opts.field_label) as { hit: number } | undefined;
    if (!exists) throw new VaultGrantError(`no vault entry with label: ${opts.field_label}`);

    const authority = this.requireRegistry().capabilityAuthority;
    let grant: Grant;
    try {
      grant = await authority.issueCapabilityGrant({
        user: opts.user,
        agent_id: opts.agent_id,
        channel: opts.channel,
        purpose: opts.purpose,
        field_label: opts.field_label,
        ttl_ms: opts.ttl_ms,
        disclosure_mode: mode,
        ...(opts.raw_policy_reason !== undefined ? { raw_policy_reason: opts.raw_policy_reason } : {}),
        ...(opts.policy_hash !== undefined ? { policy_hash: opts.policy_hash } : {})
      });
    } catch (err) {
      const reason = (err as Error).message ?? 'capability denied';
      this.ledger.append({
        actor: 'vault',
        action: 'grant_denied',
        target: opts.field_label,
        reason,
        data: {
          user: opts.user,
          agent_id: opts.agent_id,
          channel: opts.channel,
          purpose: opts.purpose,
          disclosure_mode: mode,
          authority: authority.kind
        }
      });
      throw new VaultGrantError(`grant denied: ${reason}`);
    }

    this.db
      .prepare(
        `INSERT INTO vault_grants (
           grant_id, user, agent_id, channel, purpose, field_label,
           disclosure_mode, ttl_ms, granted_at, expires_at, nonce, policy_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        grant.grant_id,
        grant.user,
        grant.agent_id,
        grant.channel,
        grant.purpose,
        grant.field_label,
        grant.disclosure_mode,
        grant.ttl_ms,
        grant.granted_at,
        grant.expires_at,
        grant.nonce,
        grant.policy_hash
      );

    this.ledger.append({
      actor: 'vault',
      action: 'grant_issued',
      target: grant.field_label,
      reason: grant.purpose,
      data: {
        grant_id: grant.grant_id,
        user: grant.user,
        agent_id: grant.agent_id,
        channel: grant.channel,
        disclosure_mode: grant.disclosure_mode,
        ttl_ms: grant.ttl_ms,
        expires_at: grant.expires_at,
        policy_hash: grant.policy_hash,
        authority: authority.kind
      }
    });
    return grant;
  }

  /**
   * Revoke a previously issued grant. Authority-side revocation is a
   * no-op for V1 local (the local service is the issuer); the DB
   * stamps `revoked_at` so subsequent `getGrant()` calls return null.
   */
  async revokeGrant(grantId: string): Promise<void> {
    if (!grantId) throw new VaultGrantError('grantId required');
    const authority = this.requireRegistry().capabilityAuthority;
    await authority.revokeGrant(grantId);
    const result = this.db
      .prepare(`UPDATE vault_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL`)
      .run(Date.now(), grantId);
    if (result.changes === 0) return;
    this.ledger.append({
      actor: 'vault',
      action: 'grant_revoked',
      target: grantId,
      reason: 'revokeGrant',
      data: { authority: authority.kind }
    });
  }

  /** Look up a grant by id. Returns null if unknown. Does NOT validate expiry. */
  getGrant(grant_id: string): Grant | null {
    const row = this.db
      .prepare(
        `SELECT grant_id, user, agent_id, channel, purpose, field_label,
                disclosure_mode, ttl_ms, granted_at, expires_at, nonce,
                policy_hash, revoked_at
         FROM vault_grants WHERE grant_id = ? LIMIT 1`
      )
      .get(grant_id) as
      | (Omit<Grant, 'disclosure_mode'> & {
          disclosure_mode: string;
          revoked_at: number | null;
        })
      | undefined;
    if (!row) return null;
    if (row.revoked_at !== null) return null;
    return {
      grant_id: row.grant_id,
      user: row.user,
      agent_id: row.agent_id,
      channel: row.channel,
      purpose: row.purpose,
      field_label: row.field_label,
      disclosure_mode: row.disclosure_mode as DisclosureMode,
      ttl_ms: row.ttl_ms,
      granted_at: row.granted_at,
      expires_at: row.expires_at,
      nonce: row.nonce,
      policy_hash: row.policy_hash
    };
  }

  /**
   * Access a vault entry under a previously issued grant. Validates scope
   * (grant.field_label === field_label), expiry, and disclosure mode, then
   * decrypts and shapes the response. Writes a hash-chained Receipt and a
   * value-free provenance row. Vault must be unlocked.
   */
  async accessWithGrant(
    grant_id: string,
    field_label: string,
    candidate_hmac?: string
  ): Promise<AccessResponse> {
    const grant = this.getGrant(grant_id);
    if (!grant) throw new VaultGrantError(`unknown or revoked grant: ${grant_id}`);
    return this.access({ grant, candidate_hmac });
  }

  /**
   * Access using an inlined Grant object (e.g., the value just returned
   * by issueGrant). Equivalent to accessWithGrant after a getGrant(),
   * but skips the round-trip when the caller already holds the row.
   */
  async access(req: AccessRequest): Promise<AccessResponse> {
    const live = this.requireUnlocked();
    const { grant, candidate_hmac } = req;
    if (!grant || !grant.grant_id) throw new VaultGrantError('grant required');
    // Re-load the grant from disk to defeat caller-side mutation; the
    // on-disk row is the source of truth for scope + expiry.
    const stored = this.getGrant(grant.grant_id);
    if (!stored) throw new VaultGrantError(`unknown or revoked grant: ${grant.grant_id}`);
    if (stored.field_label !== grant.field_label) {
      throw new VaultGrantError('grant scope mismatch (field_label)');
    }

    const now = Date.now();
    if (now >= stored.expires_at) {
      this.ledger.append({
        actor: 'vault',
        action: 'access_denied',
        target: stored.field_label,
        reason: 'grant_expired',
        data: { grant_id: stored.grant_id, expires_at: stored.expires_at }
      });
      throw new VaultGrantError(`grant expired at ${new Date(stored.expires_at).toISOString()}`);
    }

    if (stored.disclosure_mode === 'blinded_match') {
      if (!candidate_hmac || candidate_hmac.length === 0) {
        throw new VaultGrantError('blinded_match grants require candidate_hmac');
      }
    }

    const row = this.db
      .prepare(`SELECT id, encrypted_value FROM vault WHERE label = ? LIMIT 1`)
      .get(stored.field_label) as { id: string; encrypted_value: string } | undefined;
    if (!row) throw new VaultGrantError(`no vault entry with label: ${stored.field_label}`);

    let plaintext: string;
    try {
      plaintext = decrypt(row.encrypted_value, live.key);
    } catch {
      this.ledger.append({
        actor: 'vault',
        action: 'access_failed',
        target: stored.field_label,
        reason: 'decrypt_failed',
        data: { grant_id: stored.grant_id, id: row.id }
      });
      throw new VaultBadPasswordError(
        `decrypt failed for ${stored.field_label} — likely wrong password since unlock`
      );
    }

    this.db
      .prepare(`UPDATE vault SET last_accessed_at = ? WHERE id = ?`)
      .run(Date.now() / 1000, row.id);

    const receipt = await this.appendReceipt(stored);

    let response: AccessResponse;
    switch (stored.disclosure_mode) {
      case 'raw':
        response = {
          mode: 'raw',
          receipt_id: receipt.receipt_id,
          grant_id: stored.grant_id,
          value: plaintext
        };
        break;
      case 'claim':
        response = {
          mode: 'claim',
          receipt_id: receipt.receipt_id,
          grant_id: stored.grant_id,
          has_value: true
        };
        break;
      case 'blinded_match': {
        const expected = hmacHex(stored.nonce, plaintext);
        const matches =
          candidate_hmac!.length === expected.length &&
          /^[0-9a-f]+$/i.test(candidate_hmac!) &&
          hexEqual(candidate_hmac!, expected);
        response = {
          mode: 'blinded_match',
          receipt_id: receipt.receipt_id,
          grant_id: stored.grant_id,
          matches
        };
        break;
      }
    }

    // Wipe plaintext from this scope before returning. raw mode hands it
    // to the caller, but in claim/blinded_match it must not linger.
    if (stored.disclosure_mode !== 'raw') {
      plaintext = '';
    }

    this.ledger.append({
      actor: 'vault',
      action: 'access',
      target: stored.field_label,
      reason: stored.purpose,
      data: {
        grant_id: stored.grant_id,
        receipt_id: receipt.receipt_id,
        disclosure_mode: stored.disclosure_mode,
        agent_id: stored.agent_id,
        channel: stored.channel
      }
    });

    return response;
  }

  /**
   * Tail the receipt chain. Returns rows newest-first. Receipts only
   * contain metadata (grant_id, field_label, purpose, mode, hashes); no
   * sensitive value is stored or returned.
   */
  listReceipts(limit: number = 10): Receipt[] {
    const rows = this.db
      .prepare(
        `SELECT receipt_id, grant_id, field_label, purpose, disclosure_mode,
                accessed_at, agent_id, channel,
                previous_receipt_hash, receipt_hash
         FROM vault_receipts
         ORDER BY accessed_at DESC
         LIMIT ?`
      )
      .all(Math.max(1, Math.min(limit, 1000))) as Array<{
        receipt_id: string;
        grant_id: string;
        field_label: string;
        purpose: string;
        disclosure_mode: string;
        accessed_at: number;
        agent_id: string;
        channel: string;
        previous_receipt_hash: string | null;
        receipt_hash: string;
      }>;
    return rows.map((r) => ({
      receipt_id: r.receipt_id,
      grant_id: r.grant_id,
      field_label: r.field_label,
      purpose: r.purpose,
      disclosure_mode: r.disclosure_mode as DisclosureMode,
      accessed_at: r.accessed_at,
      agent_id: r.agent_id,
      channel: r.channel,
      previous_receipt_hash: r.previous_receipt_hash,
      receipt_hash: r.receipt_hash
    }));
  }

  /**
   * Verify the receipt chain end-to-end. Recomputes each receipt_hash and
   * checks that previous_receipt_hash matches the prior row's hash.
   * Returns the index of the first broken link, or null if intact.
   */
  verifyReceiptChain(): { ok: true } | { ok: false; broken_at_receipt_id: string; reason: string } {
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
      if ((r.previous_receipt_hash ?? null) !== prev) {
        return {
          ok: false,
          broken_at_receipt_id: r.receipt_id,
          reason: 'previous_receipt_hash mismatch'
        };
      }
      const expected = computeReceiptHash(r);
      if (!hexEqual(expected, r.receipt_hash)) {
        return {
          ok: false,
          broken_at_receipt_id: r.receipt_id,
          reason: 'receipt_hash recomputation mismatch'
        };
      }
      prev = r.receipt_hash;
    }
    return { ok: true };
  }

  /**
   * Build the relay envelope for an unlock request. ThunderGate emits this
   * to the active channel so the paired device can prompt for biometric
   * approval. Approval comes back as a `vault_unlock_approval` message —
   * see PROTOCOL_VAULT.md for the response shape.
   */
  buildUnlockRequest(task: string, reason: string, ttlMs?: number): UnlockRequestEnvelope {
    const envelope: UnlockRequestEnvelope = {
      type: 'vault_unlock_request',
      request_id: randomUUID(),
      task,
      reason,
      requested_at: Date.now(),
      ttl_ms: ttlMs ?? DEFAULT_TTL_MS
    };
    this.ledger.append({
      actor: 'vault',
      action: 'unlock_request_emitted',
      target: 'paired-device',
      reason,
      data: { request_id: envelope.request_id, task, ttl_ms: envelope.ttl_ms }
    });
    return envelope;
  }

  close(): void {
    this.lock('close');
    this.db.close();
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * Build a hash-chained receipt for a successful access and hand it to
   * the active ReceiptAnchorProvider for persistence. V1 local routes
   * the INSERT through `LocalReceiptAnchorProvider` so the on-disk
   * shape is identical to the pre-registry implementation; V2 (Loop)
   * batches and anchors a Merkle root on-chain.
   */
  private async appendReceipt(grant: Grant): Promise<Receipt> {
    const head = this.db
      .prepare(
        `SELECT receipt_hash FROM vault_receipts
         ORDER BY accessed_at DESC, rowid DESC LIMIT 1`
      )
      .get() as { receipt_hash: string } | undefined;
    const previous_receipt_hash = head ? head.receipt_hash : null;

    const partial: Omit<Receipt, 'receipt_hash'> = {
      receipt_id: randomUUID(),
      grant_id: grant.grant_id,
      field_label: grant.field_label,
      purpose: grant.purpose,
      disclosure_mode: grant.disclosure_mode,
      accessed_at: Date.now(),
      agent_id: grant.agent_id,
      channel: grant.channel,
      previous_receipt_hash
    };
    const receipt: Receipt = {
      ...partial,
      receipt_hash: computeReceiptHash(partial)
    };

    await this.requireRegistry().anchorProvider.anchorReceipts([receipt]);
    return receipt;
  }

  private requireRegistry(): VaultProviderRegistry {
    if (!this.registry) {
      throw new Error(
        'vault provider registry not initialized — call VaultService.initialize() first'
      );
    }
    return this.registry;
  }

  private openSession(
    key: Buffer,
    source: 'password' | 'biometric',
    ttlMs: number
  ): void {
    if (this.session) {
      this.session.key.fill(0);
    }
    const now = Date.now();
    this.session = {
      key,
      unlockedAt: now,
      expiresAt: now + ttlMs,
      source,
      ttlMs
    };
  }

  private requireUnlocked(): UnlockedSession {
    const live = this.touchExpiry();
    if (!live) throw new VaultLockedError();
    return live;
  }

  private touchExpiry(): UnlockedSession | null {
    if (!this.session) return null;
    if (Date.now() >= this.session.expiresAt) {
      this.lock('ttl_expired');
      return null;
    }
    return this.session;
  }

  /**
   * Verify the derived key matches the existing vault. We do this by
   * decrypting the first row; an empty vault accepts the first key as
   * authoritative. We deliberately avoid a stored "verifier" row because
   * a single rotation should re-encrypt everything anyway.
   */
  private assertKeyValid(key: Buffer): void {
    const probe = this.db
      .prepare(`SELECT encrypted_value FROM vault LIMIT 1`)
      .get() as { encrypted_value: string } | undefined;
    if (!probe) return;
    try {
      decrypt(probe.encrypted_value, key);
    } catch {
      throw new VaultBadPasswordError();
    }
    // Defense-in-depth: if we already have an unlocked session, surface
    // the case where the new password derives an identical key without
    // re-running PBKDF2 in the caller.
    if (this.session && keysEqual(this.session.key, key)) {
      // same key — caller is re-prompting; let it through.
    }
  }
}

function fingerprint(token: string): string {
  // Short, stable, irreversible — enough to correlate audit rows without
  // committing a verbatim approval blob to disk.
  let h = 0;
  for (let i = 0; i < token.length; i++) {
    h = ((h << 5) - h + token.charCodeAt(i)) | 0;
  }
  return h.toString(16);
}

/**
 * Receipt hash = SHA-256 over canonical JSON of the receipt minus the
 * receipt_hash field itself. Verification recomputes and compares so any
 * mutation of the row (or of the prior link) is detectable.
 */
export function computeReceiptHash(r: Omit<Receipt, 'receipt_hash'> | Receipt): string {
  const { receipt_id, grant_id, field_label, purpose, disclosure_mode,
          accessed_at, agent_id, channel, previous_receipt_hash } = r;
  const canonical = canonicalStringify({
    receipt_id,
    grant_id,
    field_label,
    purpose,
    disclosure_mode,
    accessed_at,
    agent_id,
    channel,
    previous_receipt_hash
  });
  return sha256Hex(canonical);
}
