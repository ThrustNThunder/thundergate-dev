/**
 * Untrain Service
 *
 * Two entry points:
 *   1. CLI: `thundergate untrain <key>` — direct removal of a memory by key.
 *   2. Conversational: an inbound containing "untrain that / forget that /
 *      forget that habit / remove that behavior / untrain this" targets
 *      the most recently used/referenced learning entry in the session.
 *
 * Both paths:
 *   - Delete the row from `memory`.
 *   - Write a row to `untrain_log` for the audit CLI.
 *   - Append a provenance event with actor + target + reason.
 *   - Return a confirmation string the runtime can prepend to the
 *     outbound response.
 *
 * "Most recently used/referenced" is tracked here via a small in-memory
 * ring buffer of memory keys surfaced into prompts during the current
 * session. The runtime calls noteUsage() each time it pulls a memory
 * into a system prompt or otherwise touches it.
 */

import type { SessionDB, MemoryEntry } from '../session/database.js';
import type { ProvenanceLedger } from '../provenance/ledger.js';
import type { MemoryWAL } from './wal.js';

const RECENT_USAGE_CAPACITY = 32;

export const CONVERSATIONAL_TRIGGERS: RegExp[] = [
  /\buntrain that\b/i,
  /\buntrain this\b/i,
  /\bforget that habit\b/i,
  /\bremove that behavior\b/i,
  /\bforget that\b/i
];

export function detectUntrainTrigger(text: string): boolean {
  return CONVERSATIONAL_TRIGGERS.some((re) => re.test(text));
}

export class UntrainService {
  private db: SessionDB;
  private ledger?: ProvenanceLedger;
  private recentUsage: string[] = [];
  private wal: MemoryWAL | null;

  constructor(db: SessionDB, ledger?: ProvenanceLedger, opts?: { wal?: MemoryWAL }) {
    this.db = db;
    this.ledger = ledger;
    this.wal = opts?.wal ?? null;
  }

  /** Called by anything that surfaces a memory into a prompt. */
  noteUsage(keys: string[] | string): void {
    const arr = Array.isArray(keys) ? keys : [keys];
    for (const k of arr) {
      if (!k) continue;
      // Move-to-front semantics — most-recent first.
      const idx = this.recentUsage.indexOf(k);
      if (idx !== -1) this.recentUsage.splice(idx, 1);
      this.recentUsage.unshift(k);
    }
    if (this.recentUsage.length > RECENT_USAGE_CAPACITY) {
      this.recentUsage.length = RECENT_USAGE_CAPACITY;
    }
  }

  /** Read-only view of the recent-usage buffer. */
  recent(): string[] {
    return [...this.recentUsage];
  }

  /**
   * CLI path. Deletes the memory by exact key, writes audit + provenance.
   * Returns the deleted row's value so the caller can render confirmation.
   */
  untrainByKey(opts: {
    key: string;
    actor: 'michael' | 'jon';
    reason?: string;
    triggerType?: 'cli' | 'conversational';
  }): { deleted: boolean; value: string | null } {
    const existing = this.db.getMemory(opts.key);
    const value = existing?.value ?? null;
    // WAL the intent BEFORE deletion — a crash between this row and the
    // deleteMemory() call leaves audit-trail evidence that we wanted
    // this memory gone, even if the row is still physically present.
    this.wal?.append({
      type: 'untrain',
      payload: {
        key: opts.key,
        value,
        actor: opts.actor,
        reason: opts.reason ?? null,
        triggerType: opts.triggerType ?? 'cli'
      }
    });
    const deleted = this.db.deleteMemory(opts.key);
    if (deleted) {
      this.db.logUntrain({
        actor: opts.actor,
        targetKey: opts.key,
        targetValue: value,
        reason: opts.reason ?? null,
        triggerType: opts.triggerType ?? 'cli'
      });
      this.ledger?.append({
        actor: opts.actor,
        action: 'untrain',
        target: opts.key,
        reason: opts.reason ?? (opts.triggerType === 'conversational' ? 'conversational trigger' : 'cli'),
        data: value !== null ? { value } : undefined
      });
      // Remove from recent-usage buffer.
      const idx = this.recentUsage.indexOf(opts.key);
      if (idx !== -1) this.recentUsage.splice(idx, 1);
    }
    return { deleted, value };
  }

  /**
   * Conversational path. Resolves the most-recent learning entry from
   * the usage buffer, falls back to the most-recently-updated memory
   * row in the DB if the buffer is empty (gateway just restarted).
   *
   * Returns the resolved row + a human-readable confirmation. The
   * caller is responsible for invoking confirmUntrain() to actually
   * delete — this two-step gives the runtime a chance to splice the
   * confirmation line into the outbound response.
   */
  resolveTarget(): MemoryEntry | null {
    for (const k of this.recentUsage) {
      const row = this.db.getMemory(k);
      if (row) return row;
    }
    const recent = this.db.listMemories(1);
    return recent.length > 0 ? recent[0] : null;
  }

  /**
   * One-shot conversational untrain: resolve + delete + audit. Returns
   * the confirmation string for the runtime to splice.
   */
  conversationalUntrain(opts: { actor: 'michael' | 'jon'; reason?: string }): string | null {
    const target = this.resolveTarget();
    if (!target) return null;
    const description = describeMemory(target);
    const res = this.untrainByKey({
      key: target.key,
      actor: opts.actor,
      reason: opts.reason ?? 'conversational trigger',
      triggerType: 'conversational'
    });
    if (!res.deleted) return null;
    return `Removing behavior: ${description}. Confirmed.`;
  }
}

function describeMemory(m: MemoryEntry): string {
  const value = m.value.replace(/\s+/g, ' ').trim();
  const short = value.length > 80 ? value.slice(0, 80) + '…' : value;
  const cat = m.category ? ` [${m.category}]` : '';
  return `${m.key}${cat} — ${short}`;
}
