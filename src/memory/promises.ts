/**
 * Promise Tracker
 *
 * Scans outbound assistant text for commitment patterns and persists
 * them as OPEN rows in the `promises` table. On heartbeat (or any
 * inbound after a >4h gap) the tracker surfaces the open list so the
 * gateway can prepend it to the next response.
 *
 * Promises close when Jon or Michael's inbound text references one as
 * done — keyword overlap with the promise text or an explicit "done /
 * finished / shipped / sent" near a quote of the promise.
 *
 * The tracker is intentionally regex-based today. ThunderMind will
 * eventually replace the extractor with a small classifier; the table
 * shape and surfacing behavior should stay stable across that swap.
 */

import { randomUUID } from 'crypto';
import type { SessionDB, PromiseRow } from '../session/database.js';

// First-person commitment patterns. Anchored on "I'll / I will / let me /
// I'll get back / remind me" because we only want *assistant-initiated*
// commitments — questions like "will you do X?" stay out.
const PROMISE_PATTERNS: RegExp[] = [
  /\bI(?:'ll| will)\s+([^.!?\n]{3,160})/gi,
  /\blet me\s+([^.!?\n]{3,160})/gi,
  /\bI(?:'m| am) going to\s+([^.!?\n]{3,160})/gi,
  /\bI(?:'ll| will) get back to you([^.!?\n]{0,120})/gi,
  /\bremind me\s+([^.!?\n]{3,160})/gi,
  /\bI(?:'ll| will) send\s+([^.!?\n]{3,160})/gi,
  /\bI(?:'ll| will) do\s+([^.!?\n]{3,160})/gi
];

// Lowercase tokens shorter than this never count toward "fulfilled
// keyword overlap" — a promise text always contains stop-tokens like
// "the / a / to / get" that would otherwise match any inbound message.
const MIN_OVERLAP_TOKEN_LEN = 4;
const STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'back', 'because',
  'been', 'before', 'being', 'between', 'both', 'but', 'can', 'come',
  'could', 'did', 'does', 'doing', 'done', 'down', 'each', 'few',
  'for', 'from', 'further', 'had', 'has', 'have', 'having', 'her',
  'here', 'him', 'his', 'how', 'into', 'its', 'just', 'like', 'more',
  'most', 'much', 'must', 'now', 'off', 'once', 'only', 'other',
  'our', 'out', 'over', 'own', 'same', 'she', 'should', 'some',
  'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'through', 'too', 'under',
  'until', 'very', 'was', 'were', 'what', 'when', 'where', 'which',
  'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'you',
  'your', 'yours'
]);

// "Done" keywords used as evidence that an inbound is closing a
// referenced promise.
const DONE_KEYWORDS = [
  'done', 'finished', 'shipped', 'sent', 'merged', 'pushed', 'closed',
  'wrapped', 'completed', 'delivered', 'fixed', 'good'
];

export interface PromiseExtractionResult {
  count: number;
  ids: string[];
}

export interface SurfaceTrigger {
  reason: 'heartbeat' | 'gap_resume' | 'manual';
  gapMs?: number;
}

export class PromiseTracker {
  private db: SessionDB;
  private lastInboundAt: number | null = null;
  private gapThresholdMs: number;

  constructor(db: SessionDB, opts?: { gapThresholdMs?: number }) {
    this.db = db;
    this.gapThresholdMs = opts?.gapThresholdMs ?? 4 * 60 * 60 * 1000;
  }

  /**
   * Scan an outbound assistant message and persist any promises it
   * contains. Returns the new promise IDs. Idempotency: we don't
   * dedupe by text — two restated promises become two rows, on the
   * theory that an assistant who repeats a commitment is being asked
   * about the same thing twice and Doctor should surface both.
   */
  extractFromOutbound(opts: {
    text: string;
    sessionId?: string | null;
    channel?: string | null;
  }): PromiseExtractionResult {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const pattern of PROMISE_PATTERNS) {
      // Reset lastIndex because the patterns carry /g and are reused.
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(opts.text)) !== null) {
        const phrase = (m[0] ?? '').trim().replace(/\s+/g, ' ');
        if (!phrase) continue;
        // Collapse identical extractions inside the same call so a
        // promise that matches two patterns becomes one row.
        const norm = phrase.toLowerCase();
        if (seen.has(norm)) continue;
        seen.add(norm);
        const id = randomUUID();
        this.db.insertPromise({
          id,
          sessionId: opts.sessionId ?? null,
          channel: opts.channel ?? null,
          text: phrase
        });
        ids.push(id);
      }
    }
    return { count: ids.length, ids };
  }

  /**
   * Inbound hook. Returns:
   *   - surface: any open promises that should be shown (gap > threshold)
   *   - closed:  promises this inbound resolved (text references + done word)
   *
   * The runtime is responsible for prepending the surface list to the
   * outbound response.
   */
  onInbound(opts: {
    text: string;
    sender: 'jon' | 'michael' | string;
    now?: number;
  }): { surface: PromiseRow[]; closed: PromiseRow[] } {
    const now = opts.now ?? Date.now();
    const gapMs = this.lastInboundAt === null ? 0 : now - this.lastInboundAt;
    this.lastInboundAt = now;

    // Close-detection. Only run for jon/michael — the brief is explicit
    // that a *user* must reference the promise as done.
    let closed: PromiseRow[] = [];
    const senderLower = (opts.sender || '').toLowerCase();
    if (senderLower === 'jon' || senderLower === 'michael') {
      closed = this.closeMatchingPromises(opts.text, senderLower);
    }

    // Surface-on-gap. The brief says > 4h triggers surfacing; the same
    // gate is reused for explicit heartbeats via surfaceOpen().
    const surface = gapMs > this.gapThresholdMs ? this.surfaceOpen() : [];

    return { surface, closed };
  }

  /** Always returns the open promise list. CLI + heartbeat call this. */
  surfaceOpen(limit: number = 20): PromiseRow[] {
    return this.db.getOpenPromises(limit);
  }

  /** Render the surface list as a single line for prepending to a response. */
  formatSurfaceLine(promises: PromiseRow[]): string {
    if (promises.length === 0) return '';
    const items = promises.map((p) => `• ${truncate(p.text, 80)}`).join('\n');
    return `Open promises:\n${items}`;
  }

  /** Force-close a promise by id, e.g. from CLI. */
  closeById(id: string, resolvedBy: string, status: 'FULFILLED' | 'DISMISSED' = 'FULFILLED'): boolean {
    return this.db.closePromise(id, status, resolvedBy);
  }

  /**
   * Find open promises whose text overlaps the inbound and close them.
   * Heuristic: at least one DONE_KEYWORD anywhere in the inbound, plus
   * ≥ 2 content-token overlap with the promise text. This deliberately
   * under-closes — a missed close means the next heartbeat re-surfaces,
   * which is cheap; an over-close silently buries an unfinished task.
   */
  private closeMatchingPromises(inbound: string, sender: string): PromiseRow[] {
    const lower = inbound.toLowerCase();
    const hasDoneWord = DONE_KEYWORDS.some((w) => lower.includes(w));
    if (!hasDoneWord) return [];

    const inboundTokens = tokenize(inbound);
    if (inboundTokens.size === 0) return [];

    const open = this.db.getOpenPromises(50);
    const closed: PromiseRow[] = [];
    for (const p of open) {
      const pTokens = tokenize(p.text);
      let overlap = 0;
      for (const t of pTokens) if (inboundTokens.has(t)) overlap++;
      if (overlap >= 2) {
        if (this.db.closePromise(p.id, 'FULFILLED', sender)) {
          closed.push({ ...p, status: 'FULFILLED', closed_at: Date.now() / 1000, resolved_by: sender });
        }
      }
    }
    return closed;
  }

  /** Doctor uses this for the count line. */
  countOpen(): number {
    return this.db.getOpenPromises(1000).length;
  }
}

function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_OVERLAP_TOKEN_LEN) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}
