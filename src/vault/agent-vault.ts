/**
 * Vault A — Agent Credential Vault
 *
 * Encrypted store for API keys/tokens Jon uses to make outbound HTTP
 * calls (ElevenLabs TTS, Voyage embeddings, GitHub PAT, xAI, etc.).
 *
 * Mirrors the Vault H (PII) design intentionally:
 *   - SQLite at ~/.thundergate/agent-vault.db
 *   - Sibling salt at ~/.thundergate/agent-vault.salt
 *   - AES-256-GCM with PBKDF2-derived key (shared crypto.ts)
 *   - Key never persisted; locked on process start; TTL on the session
 *
 * The contract is narrower than Vault H — there are no grants, no
 * receipts, no disclosure modes. Use cases:
 *   - addAgentSecret(name, value, service)  : store an API key
 *   - getAgentSecret(name)                  : retrieve plaintext for
 *                                             internal HTTP header use
 *   - listAgentSecrets()                    : name/service only, no value
 *
 * The plaintext from getAgentSecret() must NEVER be logged, echoed to a
 * surface, or written to the session DB. Outbound redaction in the
 * runtime is the second line of defense if a key leaks into LLM output.
 */

import Database, { type Database as Db } from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  chmodSync
} from 'fs';
import { dirname, join } from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { decrypt, deriveKey, encrypt, generateSalt } from './crypto.js';

const DEFAULT_TTL_MS = 30 * 60 * 1000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_secrets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  service TEXT NOT NULL,
  value_enc TEXT NOT NULL,
  added_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_secrets_service ON agent_secrets(service);
`;

export interface AgentVaultStatus {
  locked: boolean;
  entryCount: number;
  dbPath: string;
}

export interface AgentSecretListing {
  name: string;
  service: string;
  added_at: string;
}

export class AgentVaultLockedError extends Error {
  constructor(message = 'agent vault is locked') {
    super(message);
    this.name = 'AgentVaultLockedError';
  }
}

export class AgentVaultBadPasswordError extends Error {
  constructor(message = 'agent vault unlock failed: bad password or tampered store') {
    super(message);
    this.name = 'AgentVaultBadPasswordError';
  }
}

interface UnlockedSession {
  key: Buffer;
  unlockedAt: number;
  expiresAt: number;
  ttlMs: number;
}

/**
 * One-shot rename of the pre-multi-agent agent-vault files into their
 * agent-suffixed counterparts. Idempotent; runs only for agentId='jon'.
 */
function migrateLegacyAgentVaultPaths(home: string, suffixedDb: string, suffixedSalt: string): void {
  const legacyDb = join(home, '.thundergate', 'agent-vault.db');
  const legacySalt = join(home, '.thundergate', 'agent-vault.salt');
  try {
    if (existsSync(legacyDb) && !existsSync(suffixedDb)) {
      renameSync(legacyDb, suffixedDb);
    }
    if (existsSync(legacySalt) && !existsSync(suffixedSalt)) {
      renameSync(legacySalt, suffixedSalt);
    }
  } catch {
    /* best-effort migration; failure leaves both files in place */
  }
}

export class AgentVault {
  private db!: Db;
  private salt!: Buffer;
  private session: UnlockedSession | null = null;
  private readonly dbPath: string;
  private readonly saltPath: string;

  constructor(options: { dbPath?: string; saltPath?: string; agentId?: string } = {}) {
    const home = os.homedir();
    const agentId = options.agentId ?? 'jon';
    this.dbPath = options.dbPath ?? join(home, '.thundergate', `agent-vault-${agentId}.db`);
    this.saltPath = options.saltPath ?? join(home, '.thundergate', `agent-vault-${agentId}.salt`);
    // Backward-compatible migration: rename the legacy single-agent files
    // (~/.thundergate/agent-vault.{db,salt}) into the agent-suffixed slots
    // on first boot, but only for agentId='jon'. Idempotent.
    if (agentId === 'jon' && !options.dbPath && !options.saltPath) {
      migrateLegacyAgentVaultPaths(home, this.dbPath, this.saltPath);
    }
  }

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
      throw new Error(
        `agent vault salt at ${this.saltPath} is ${raw.length} bytes (expected 16); refusing to overwrite`
      );
    }
    const salt = generateSalt();
    mkdirSync(dirname(this.saltPath), { recursive: true });
    writeFileSync(this.saltPath, salt);
    try {
      chmodSync(this.saltPath, 0o600);
    } catch {
      // Best-effort; some FS refuse chmod.
    }
    return salt;
  }

  status(): AgentVaultStatus {
    const entryCount =
      (this.db.prepare('SELECT COUNT(*) AS n FROM agent_secrets').get() as { n: number })
        .n ?? 0;
    return {
      locked: this.touchExpiry() === null,
      entryCount,
      dbPath: this.dbPath
    };
  }

  isUnlocked(): boolean {
    return this.touchExpiry() !== null;
  }

  /**
   * Unlock with the user's password. On a fresh vault any password
   * "works" — it becomes the binding key. On an existing vault we
   * probe-decrypt one row to verify; tag mismatch = bad password.
   */
  async unlockAgentVault(password: string, ttlMs: number = DEFAULT_TTL_MS): Promise<void> {
    if (!password || password.length === 0) {
      throw new Error('password required');
    }
    const key = deriveKey(password, this.salt);
    this.assertKeyValid(key);
    this.openSession(key, ttlMs);
  }

  lock(): void {
    if (!this.session) return;
    this.session.key.fill(0);
    this.session = null;
  }

  async addAgentSecret(name: string, value: string, service: string): Promise<void> {
    const live = this.requireUnlocked();
    if (!name || name.trim().length === 0) throw new Error('name required');
    if (!value || value.length === 0) throw new Error('value required');
    if (!service || service.trim().length === 0) throw new Error('service required');
    const id = randomUUID();
    const blob = encrypt(value, live.key);
    // We embed the IV inside `value_enc` (base64 of IV||TAG||CT). The
    // `iv` column is reserved for forward compatibility if we ever
    // separate them; today it stores the same fingerprint we'd need
    // to rotate keys atomically.
    this.db
      .prepare(
        `INSERT INTO agent_secrets (id, name, service, value_enc, added_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           service = excluded.service,
           value_enc = excluded.value_enc,
           added_at = excluded.added_at`
      )
      .run(id, name, service, blob, new Date().toISOString());
  }

  listAgentSecrets(): AgentSecretListing[] {
    const rows = this.db
      .prepare(
        `SELECT name, service, added_at
         FROM agent_secrets
         ORDER BY service, name`
      )
      .all() as Array<{ name: string; service: string; added_at: string }>;
    return rows.map((r) => ({ name: r.name, service: r.service, added_at: r.added_at }));
  }

  /**
   * Internal-only accessor. Returns the plaintext value or null. Never
   * log this return value, never echo it to a surface, never write it
   * to a DB row. Designed for direct injection into outbound HTTP
   * Authorization headers.
   */
  async getAgentSecret(name: string): Promise<string | null> {
    const live = this.touchExpiry();
    if (!live) return null;
    const row = this.db
      .prepare(`SELECT value_enc FROM agent_secrets WHERE name = ? LIMIT 1`)
      .get(name) as { value_enc: string } | undefined;
    if (!row) return null;
    try {
      return decrypt(row.value_enc, live.key);
    } catch {
      return null;
    }
  }

  agentVaultStatus(): AgentVaultStatus {
    return this.status();
  }

  close(): void {
    this.lock();
    this.db.close();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private openSession(key: Buffer, ttlMs: number): void {
    if (this.session) {
      this.session.key.fill(0);
    }
    const now = Date.now();
    this.session = {
      key,
      unlockedAt: now,
      expiresAt: now + ttlMs,
      ttlMs
    };
  }

  private requireUnlocked(): UnlockedSession {
    const live = this.touchExpiry();
    if (!live) throw new AgentVaultLockedError();
    return live;
  }

  private touchExpiry(): UnlockedSession | null {
    if (!this.session) return null;
    if (Date.now() >= this.session.expiresAt) {
      this.lock();
      return null;
    }
    return this.session;
  }

  private assertKeyValid(key: Buffer): void {
    const probe = this.db
      .prepare(`SELECT value_enc FROM agent_secrets LIMIT 1`)
      .get() as { value_enc: string } | undefined;
    if (!probe) return;
    try {
      decrypt(probe.value_enc, key);
    } catch {
      throw new AgentVaultBadPasswordError();
    }
  }
}

// ── Process-wide singleton ────────────────────────────────────────────────
//
// The runtime constructs the vault once during start() and shares it via
// `setSharedAgentVault()`. CLI commands construct their own short-lived
// instance and never touch the runtime singleton. The runtime accessor
// returns the same handle so the outbound HTTP path and the CLI agree
// on lock state.

let sharedAgentVault: AgentVault | null = null;

export function setSharedAgentVault(v: AgentVault | null): void {
  sharedAgentVault = v;
}

export function getSharedAgentVault(): AgentVault | null {
  return sharedAgentVault;
}

/**
 * Convenience for the outbound HTTP path. Returns the agent-vault key
 * for `name` if the vault is unlocked and has it; null otherwise. Never
 * throws — the caller falls back to its config-supplied key on null.
 */
export async function tryGetAgentSecret(name: string): Promise<string | null> {
  const v = sharedAgentVault;
  if (!v) return null;
  if (!v.isUnlocked()) return null;
  try {
    return await v.getAgentSecret(name);
  } catch {
    return null;
  }
}

