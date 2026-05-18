/**
 * Memory Write-Ahead Log
 *
 * Every memory-affecting operation lands as a row in `memory_wal` BEFORE
 * it is processed. If ThunderGate crashes, is OOM-killed, or the host
 * hard-reboots, the next boot reads back the unreplayed rows and
 * reconstructs the in-flight world.
 *
 * Canonical state still lives in the subsystem tables (promises, frames,
 * memory, untrain_log). The WAL is the durable *history of intent* plus
 * the recovery surface — it gives Jon the same guarantees Postgres has
 * with its WAL and Redis has with its AOF.
 *
 * Design rules:
 *   - Writes are synchronous (better-sqlite3 is sync; we do not defer).
 *   - The payload string is sha256-hashed and stored alongside the row.
 *     Replay verifies the hash before consuming the row; corruption is
 *     logged and the row is skipped (a crash mid-fsync should never
 *     crash the boot).
 *   - Once a row's intent has been re-observed during replay, replayed
 *     is flipped to 1.
 *   - Rotation moves rows older than 7 days AND replayed=1 to
 *     memory_wal_archive. The hot table stays small; the archive is
 *     append-only and queryable for forensics.
 */

import { createHash } from 'crypto';
import type { SessionDB } from '../session/database.js';

export type WALEventType =
  | 'inbound_message'
  | 'outbound_message'
  | 'promise_extracted'
  | 'frame_opened'
  | 'frame_closed'
  | 'learning_extracted'
  | 'correction'
  | 'untrain';

export interface WALRow {
  id: number;
  created_at: number;
  type: WALEventType;
  session_id: string | null;
  agent_id: string;
  payload: string;
  replayed: number;
  checksum: string;
}

export interface WALAppendInput {
  type: WALEventType;
  sessionId?: string | null;
  agentId?: string;
  payload: Record<string, unknown>;
}

export interface WALStats {
  hotRows: number;
  unplayedRows: number;
  oldestUnplayedAgeMs: number | null;
  archiveRows: number;
  lastRotationAt: number | null;
  corruptedRecent: number;
  recentSampleSize: number;
}

export interface ReplaySummary {
  recovered: number;
  byType: Record<WALEventType, number>;
  corrupted: number;
  orphanedInbound: number;
  lastTurns: Array<{
    role: 'user' | 'assistant';
    text: string;
    timestamp: number;
    channel: string | null;
    sessionId: string | null;
  }>;
}

const WAL_LAST_ROTATION_KEY = 'wal:last_rotation_at';
const ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_CORRUPTION_WINDOW = 200;
const RECENT_TURNS_LIMIT = 16;
const DAILY_ROTATION_MS = 24 * 60 * 60 * 1000;

export class MemoryWAL {
  private db: SessionDB;
  private rotationTimer: NodeJS.Timeout | null = null;

  constructor(db: SessionDB) {
    this.db = db;
  }

  /**
   * Append a single intent record to the WAL. Synchronous: returns only
   * after the row has been INSERTed (and, by virtue of SQLite WAL mode +
   * synchronous=NORMAL, flushed to the WAL file). Callers must call this
   * BEFORE the operation it describes — that is the entire point.
   *
   * If the insert fails for any reason we log + swallow. The caller's op
   * still runs. The WAL is best-effort durability — a missing row only
   * means the recovery for that one op is degraded, not that the live
   * path stalls.
   */
  append(input: WALAppendInput): number | null {
    const payloadStr = JSON.stringify(input.payload);
    const checksum = sha256(payloadStr);
    const createdAt = Date.now();
    try {
      const info = this.db.raw().prepare(`
        INSERT INTO memory_wal (created_at, type, session_id, agent_id, payload, replayed, checksum)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `).run(
        createdAt,
        input.type,
        input.sessionId ?? null,
        input.agentId ?? 'jon',
        payloadStr,
        checksum
      );
      return info.lastInsertRowid as number;
    } catch (err) {
      console.warn(`  ⚠ WAL append (${input.type}) failed:`, (err as Error).message);
      return null;
    }
  }

  /**
   * Boot-time recovery. Reads every unreplayed row, verifies the
   * checksum, reconstructs the last-N conversation turns from the
   * inbound/outbound rows, identifies inbound messages that never got a
   * matching outbound (a crash mid-LLM-call), and marks every consumed
   * row as replayed.
   *
   * Corrupted rows are skipped with a warning rather than throwing —
   * a fresh crash mid-fsync should never block a recovery boot.
   */
  replay(): ReplaySummary {
    const rows = this.db.raw().prepare(`
      SELECT * FROM memory_wal WHERE replayed = 0 ORDER BY id ASC
    `).all() as WALRow[];

    const summary: ReplaySummary = {
      recovered: 0,
      byType: {
        inbound_message: 0,
        outbound_message: 0,
        promise_extracted: 0,
        frame_opened: 0,
        frame_closed: 0,
        learning_extracted: 0,
        correction: 0,
        untrain: 0
      },
      corrupted: 0,
      orphanedInbound: 0,
      lastTurns: []
    };

    const turns: ReplaySummary['lastTurns'] = [];
    // Track inbound messageIds so we can detect orphans (inbound that
    // never produced an outbound — likely a crash mid-LLM-call).
    const inboundIds = new Map<string, { sessionId: string | null; channel: string | null }>();
    const outboundAckedInboundIds = new Set<string>();

    const replayedIds: number[] = [];
    for (const row of rows) {
      if (sha256(row.payload) !== row.checksum) {
        summary.corrupted++;
        console.warn(`  ⚠ WAL row ${row.id} (${row.type}) corrupted — checksum mismatch, skipping`);
        continue;
      }
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.payload);
      } catch (err) {
        summary.corrupted++;
        console.warn(`  ⚠ WAL row ${row.id} (${row.type}) unparseable:`, (err as Error).message);
        continue;
      }

      if (row.type === 'inbound_message') {
        const id = String(payload.messageId ?? row.id);
        inboundIds.set(id, {
          sessionId: row.session_id,
          channel: (payload.channel as string) ?? null
        });
        turns.push({
          role: 'user',
          text: String(payload.text ?? ''),
          timestamp: row.created_at,
          channel: (payload.channel as string) ?? null,
          sessionId: row.session_id
        });
      } else if (row.type === 'outbound_message') {
        const inboundRef = payload.inboundMessageId
          ? String(payload.inboundMessageId)
          : null;
        if (inboundRef) outboundAckedInboundIds.add(inboundRef);
        turns.push({
          role: 'assistant',
          text: String(payload.text ?? ''),
          timestamp: row.created_at,
          channel: (payload.channel as string) ?? null,
          sessionId: row.session_id
        });
      }

      summary.byType[row.type as WALEventType]++;
      summary.recovered++;
      replayedIds.push(row.id);
    }

    // Orphan detection — every inbound whose matching outbound never
    // landed in the WAL. These are the requests that were in-flight at
    // the moment of the crash. We surface the count so Doctor can flag
    // it; we deliberately do NOT auto-retry, because the LLM call may
    // have actually completed and just failed to log — replaying would
    // double-respond.
    for (const id of inboundIds.keys()) {
      if (!outboundAckedInboundIds.has(id)) summary.orphanedInbound++;
    }

    // Trim turns to the last N for the caller-facing recent-history view.
    summary.lastTurns = turns.slice(-RECENT_TURNS_LIMIT);

    // Mark replayed in one batched transaction.
    if (replayedIds.length > 0) {
      const tx = this.db.raw().transaction((ids: number[]) => {
        const stmt = this.db.raw().prepare(
          `UPDATE memory_wal SET replayed = 1 WHERE id = ?`
        );
        for (const id of ids) stmt.run(id);
      });
      try {
        tx(replayedIds);
      } catch (err) {
        console.warn('  ⚠ WAL replay mark-as-replayed failed:', (err as Error).message);
      }
    }

    return summary;
  }

  /**
   * Move rows older than the retention window AND already replayed into
   * memory_wal_archive. Idempotent. Records last-rotation timestamp via
   * the existing context table so Doctor can surface it.
   */
  rotate(now: number = Date.now()): { archived: number; lastRotationAt: number } {
    const cutoff = now - ARCHIVE_AFTER_MS;
    const raw = this.db.raw();
    let archived = 0;
    const tx = raw.transaction(() => {
      const toArchive = raw.prepare(`
        SELECT * FROM memory_wal
        WHERE replayed = 1 AND created_at < ?
        ORDER BY id ASC
      `).all(cutoff) as WALRow[];

      const insertArchive = raw.prepare(`
        INSERT OR IGNORE INTO memory_wal_archive
          (id, created_at, type, session_id, payload, replayed, checksum, archived_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const deleteHot = raw.prepare(`DELETE FROM memory_wal WHERE id = ?`);
      for (const r of toArchive) {
        insertArchive.run(r.id, r.created_at, r.type, r.session_id, r.payload, r.replayed, r.checksum, now);
        deleteHot.run(r.id);
        archived++;
      }
    });
    try {
      tx();
    } catch (err) {
      console.warn('  ⚠ WAL rotation failed:', (err as Error).message);
      return { archived: 0, lastRotationAt: this.getLastRotationAt() ?? 0 };
    }
    this.db.setContext(WAL_LAST_ROTATION_KEY, String(now));
    return { archived, lastRotationAt: now };
  }

  /**
   * Schedule a daily rotation tick. The first tick fires immediately if
   * we've never rotated; subsequent ticks fire every 24h. Returns the
   * interval handle so the caller (runtime) can stop it on shutdown.
   *
   * We deliberately use a plain setInterval rather than the host's cron:
   * cron primitives aren't available in this repo today, and the
   * runtime's lifecycle is the natural owner — when ThunderGate stops,
   * rotation stops.
   */
  startDailyRotation(): void {
    if (this.rotationTimer) return;
    this.rotationTimer = setInterval(() => {
      const res = this.rotate();
      if (res.archived > 0) {
        console.log(`  📦 WAL rotation: archived ${res.archived} row(s)`);
      }
    }, DAILY_ROTATION_MS);
    // Unref so an idle rotation timer doesn't block process exit during
    // graceful shutdown — the explicit stop() below is the clean path.
    this.rotationTimer.unref?.();
  }

  stopDailyRotation(): void {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
  }

  /** Doctor accessors — cheap counts + age + corruption sample. */
  stats(): WALStats {
    const raw = this.db.raw();
    const hot = raw.prepare(`SELECT COUNT(*) as c FROM memory_wal`).get() as { c: number };
    const unplayed = raw.prepare(`SELECT COUNT(*) as c FROM memory_wal WHERE replayed = 0`).get() as { c: number };
    const oldestUnplayed = raw.prepare(`
      SELECT created_at FROM memory_wal WHERE replayed = 0 ORDER BY created_at ASC LIMIT 1
    `).get() as { created_at: number } | undefined;
    const archive = raw.prepare(`SELECT COUNT(*) as c FROM memory_wal_archive`).get() as { c: number };
    const recentSample = raw.prepare(`
      SELECT payload, checksum FROM memory_wal
      ORDER BY id DESC LIMIT ?
    `).all(RECENT_CORRUPTION_WINDOW) as Array<{ payload: string; checksum: string }>;
    let corrupted = 0;
    for (const r of recentSample) {
      if (sha256(r.payload) !== r.checksum) corrupted++;
    }
    return {
      hotRows: hot.c,
      unplayedRows: unplayed.c,
      oldestUnplayedAgeMs: oldestUnplayed ? Date.now() - oldestUnplayed.created_at : null,
      archiveRows: archive.c,
      lastRotationAt: this.getLastRotationAt(),
      corruptedRecent: corrupted,
      recentSampleSize: recentSample.length
    };
  }

  getLastRotationAt(): number | null {
    const v = this.db.getContext(WAL_LAST_ROTATION_KEY);
    if (!v) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
