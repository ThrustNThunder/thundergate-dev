/**
 * Provisional Memory
 *
 * The learning loop seeds inferred memories as PROVISIONAL with a
 * uses_remaining counter of 3. Each time such a memory is surfaced
 * into a prompt, this service decrements the counter and prepends a
 * "[provisional — verify before relying on]" marker. At zero uses
 * left without a correction, the memory is promoted to CONFIRMED.
 *
 * Corrections delete provisional memories outright — the learning
 * loop should re-learn from the correction itself, not patch the bad
 * inference.
 */

import type { SessionDB, MemoryEntry } from '../session/database.js';

export const PROVISIONAL_DEFAULT_USES = 3;
export const PROVISIONAL_MARKER = '[provisional — verify before relying on]';

export class ProvisionalMemoryService {
  private db: SessionDB;

  constructor(db: SessionDB) {
    this.db = db;
  }

  /**
   * Decorate a list of memories with the provisional marker and
   * decrement uses_remaining for any provisional row. Returns the
   * value strings ready to be dropped into a prompt block.
   *
   * Promotion-on-exhaustion: if a provisional row's decrement leaves
   * uses_remaining at 0, we flip status to 'confirmed' before
   * returning the line so the next surface sees a clean entry.
   */
  useForPrompt(memories: MemoryEntry[]): Array<{ value: string; status: string }> {
    const out: Array<{ value: string; status: string }> = [];
    for (const m of memories) {
      if (m.status === 'provisional') {
        const updated = this.db.decrementProvisionalUse(m.key);
        const remaining = updated?.uses_remaining ?? 0;
        if (remaining <= 0) {
          this.db.confirmMemory(m.key);
          out.push({ value: m.value, status: 'confirmed' });
        } else {
          out.push({ value: `${PROVISIONAL_MARKER} ${m.value}`, status: 'provisional' });
        }
      } else {
        out.push({ value: m.value, status: m.status || 'confirmed' });
      }
    }
    return out;
  }

  /**
   * Correction handler. If `key` resolves to a provisional row, delete
   * it. If it resolves to a confirmed row, leave it alone — the caller
   * (learning loop) burns in the new correction separately.
   */
  onCorrection(key: string): { deleted: boolean; wasProvisional: boolean } {
    const existing = this.db.getMemory(key);
    if (!existing) return { deleted: false, wasProvisional: false };
    if (existing.status === 'provisional') {
      const deleted = this.db.deleteMemory(key);
      return { deleted, wasProvisional: true };
    }
    return { deleted: false, wasProvisional: false };
  }

  /** Returns counts of provisional vs confirmed memories. */
  counts(): { provisional: number; confirmed: number; total: number } {
    const rows = this.db.listMemories(10000);
    let provisional = 0;
    let confirmed = 0;
    for (const r of rows) {
      if (r.status === 'provisional') provisional++;
      else confirmed++;
    }
    return { provisional, confirmed, total: rows.length };
  }
}
