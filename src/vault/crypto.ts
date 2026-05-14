/**
 * Vault crypto — AES-256-GCM with PBKDF2-derived keys.
 *
 * One key per vault session, derived from the user's vault password and a
 * per-vault salt held outside the encrypted column. We do NOT store the
 * password or the derived key on disk; the salt is fine to expose because
 * it only matters to the PBKDF2 stretch.
 *
 * Layout per ciphertext row (encrypted_value):
 *   base64( IV(12) || GCM_TAG(16) || CIPHERTEXT )
 *
 * Decoding splits on those byte offsets. IV is fresh per encrypt(); GCM
 * authenticates the ciphertext so a tampered row throws on decrypt rather
 * than silently returning garbage.
 */

import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual
} from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;          // AES-256
const IV_BYTES = 12;           // GCM standard
const TAG_BYTES = 16;          // GCM auth tag
const SALT_BYTES = 16;         // per-vault, written next to vault.db
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = 'sha256';

/**
 * Derive a 32-byte AES key from the user's password + per-vault salt.
 * 100k iterations matches the spec; raise it if/when we redo this against
 * an HSM-backed verifier.
 */
export function deriveKey(password: string, salt: Buffer): Buffer {
  if (!password || password.length === 0) {
    throw new Error('vault password required');
  }
  if (salt.length !== SALT_BYTES) {
    throw new Error(`salt must be ${SALT_BYTES} bytes`);
  }
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_BYTES, PBKDF2_DIGEST);
}

/** Fresh per-vault salt. Persist alongside vault.db. */
export function generateSalt(): Buffer {
  return randomBytes(SALT_BYTES);
}

/**
 * Encrypt a UTF-8 string. Returns the canonical base64(IV || TAG || CT)
 * blob that lands in the encrypted_value column.
 */
export function encrypt(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`key must be ${KEY_BYTES} bytes`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/**
 * Decrypt the canonical base64 blob. Throws on tag mismatch — that's the
 * "wrong password" / "tampered row" signal callers should surface.
 */
export function decrypt(blob: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`key must be ${KEY_BYTES} bytes`);
  }
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error('ciphertext truncated');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Constant-time check that a freshly-derived key matches the one already
 * unlocked. Used by re-prompt flows so a typo doesn't drop the live
 * session.
 */
export function keysEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const _internals = {
  ALGORITHM,
  KEY_BYTES,
  IV_BYTES,
  TAG_BYTES,
  SALT_BYTES,
  PBKDF2_ITERATIONS,
  PBKDF2_DIGEST
};
