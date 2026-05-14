/**
 * VaultService — encrypted PII store, separate from context.db.
 *
 * The vault holds high-sensitivity values (SSNs, cards, medical IDs,
 * passwords) that the agent should be able to read only after the user
 * has actively unlocked the store. Database lives at
 *   ~/.thundergate/vault.db
 * with a sibling salt file
 *   ~/.thundergate/vault.salt
 * holding the per-vault PBKDF2 salt.
 *
 * Lock model:
 *   - Locked on every process start. The derived key only exists in memory
 *     and is wiped on lock() / TTL expiry.
 *   - Unlock requires the vault password OR a biometric approval signal
 *     relayed from a paired device (vault_unlock_approval — see
 *     PROTOCOL_VAULT.md).
 *   - Default session TTL: 30 minutes. Each access() re-checks expiry.
 *
 * Audit:
 *   - Every add/access/unlock/lock/touch writes a ProvenanceLedger row
 *     keyed by the supplied task description so the post-hoc question
 *     "why did the agent read this field?" has a real answer.
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
  decrypt,
  deriveKey,
  encrypt,
  generateSalt,
  keysEqual
} from './crypto.js';

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

export class VaultService {
  private db!: Db;
  private salt!: Buffer;
  private session: UnlockedSession | null = null;
  private readonly dbPath: string;
  private readonly saltPath: string;

  constructor(
    private readonly ledger: ProvenanceLedger,
    options: { dbPath?: string; saltPath?: string } = {}
  ) {
    const home = os.homedir();
    this.dbPath = options.dbPath ?? join(home, '.thundergate', 'vault.db');
    this.saltPath = options.saltPath ?? join(home, '.thundergate', 'vault.salt');
  }

  /**
   * Open the SQLite handle and ensure schema + salt are in place. Vault
   * always starts locked; a separate unlock() call is required before any
   * value can be read.
   */
  initialize(): void {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA_SQL);
    this.salt = this.loadOrCreateSalt();
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
   * Read the plaintext for a labeled entry. Vault must be unlocked. Every
   * call writes a provenance row carrying the supplied task description
   * so callers can later answer "why was this field accessed?".
   */
  access(opts: AccessOptions): string {
    const live = this.requireUnlocked();
    if (!opts.task || opts.task.trim().length === 0) {
      throw new Error('access task description required');
    }
    const row = this.db
      .prepare(
        `SELECT id, encrypted_value FROM vault WHERE label = ? LIMIT 1`
      )
      .get(opts.label) as { id: string; encrypted_value: string } | undefined;
    if (!row) throw new Error(`no vault entry with label: ${opts.label}`);
    let plaintext: string;
    try {
      plaintext = decrypt(row.encrypted_value, live.key);
    } catch (err) {
      this.ledger.append({
        actor: 'vault',
        action: 'access_failed',
        target: opts.label,
        reason: opts.task,
        data: { id: row.id, taskId: opts.taskId, error: (err as Error).message }
      });
      throw new VaultBadPasswordError(
        `decrypt failed for ${opts.label} — likely wrong password since unlock`
      );
    }
    this.db
      .prepare(`UPDATE vault SET last_accessed_at = ? WHERE id = ?`)
      .run(Date.now() / 1000, row.id);
    this.ledger.append({
      actor: 'vault',
      action: 'access',
      target: opts.label,
      reason: opts.task,
      data: { id: row.id, taskId: opts.taskId }
    });
    return plaintext;
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
