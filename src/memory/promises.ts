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
 * The extractor is regex-based today. ThunderMind will eventually
 * replace it with a small classifier; the table shape and surfacing
 * behavior stays stable across that swap.
 *
 * Extraction layers (each gates the previous):
 *   1. Negative filter — known false-positive phrases ("I'll be honest",
 *      "I'll say this", "I'll admit", etc.) are skipped. These are
 *      conversational throat-clears, not commitments.
 *   2. Action-verb anchor — the captured tail must contain at least one
 *      action verb ("send", "draft", "write", "check", "look", "get",
 *      "ship", "push", "review", "fix", "build", "follow"…). Without
 *      a verb it's a stance, not a promise.
 *   3. Explicit-commitment patterns — "I'll X", "I will X", "let me X",
 *      "going to X", "I'll get back to you".
 *   4. Implicit-commitment patterns — present-progressive short forms
 *      that mean "I'm starting on this now": "on it", "checking that",
 *      "looking into it", "working on", "pulling up".
 *   5. Conditional patterns — "once X, I'll Y" / "as soon as X, I'll Y" /
 *      "when X, I'll Y". Captured as a single conditional promise so the
 *      surface text reflects the dependency.
 *
 * Multi-turn (a promise built across two messages) is not yet handled by
 * this extractor — it deliberately scopes per outbound. The Frame layer
 * is the natural home for cross-turn assembly; calling it out here so a
 * future pass knows where to plug in.
 */

import { randomUUID } from 'crypto';
import type { SessionDB, PromiseRow } from '../session/database.js';
import type { MemoryWAL } from './wal.js';

/**
 * Negative-filter phrases. If the matched outbound substring (normalized)
 * starts with or contains one of these, we drop it. These are the
 * stock-phrase commitments that English speakers use as throat-clears.
 * Adding here is cheap; an over-fire would surface a fake promise on the
 * next heartbeat and erode Michael's trust in the tracker.
 */
const NEGATIVE_PREFIXES: string[] = [
  "i'll be honest",
  'i will be honest',
  "i'll be brief",
  'i will be brief',
  "i'll be direct",
  'i will be direct',
  "i'll be clear",
  'i will be clear',
  "i'll be straight",
  "i'll be real",
  "i'll admit",
  'i will admit',
  "i'll say this",
  'i will say this',
  "i'll say it",
  "i'll tell you",
  "i'll let you know what i think",
  "i'll grant you",
  "i'll concede",
  "i'll bet",
  "i'll wager",
  // "I'll do my best" lacks an actionable object; treat as a stance.
  "i'll do my best",
  // Speculative future, not a commitment.
  "i'll probably",
  "i'll maybe",
  "i'll likely"
];

/**
 * Action verbs that anchor a real promise. The captured tail must
 * contain at least one of these (matched as a whole word) to count as
 * a commitment. Verbs are tracked by stem-ish form — the regex check
 * matches them as substrings against a single tail token, so "send",
 * "sending", "sends" all match. Keeping this conservative reduces
 * false positives.
 */
const ACTION_VERB_STEMS: string[] = [
  'send', 'draft', 'write', 'wrote', 'writ', 'push', 'ship',
  'merge', 'land', 'commit', 'deploy', 'release',
  'check', 'look', 'find', 'search', 'review', 'audit',
  'investigate', 'inspect', 'verify', 'confirm',
  'get back', 'follow up', 'follow-up', 'circle back', 'ping',
  'reach out', 'email', 'message', 'text', 'call', 'dm',
  'fix', 'patch', 'repair', 'address', 'resolve', 'close',
  'build', 'make', 'create', 'add', 'wire', 'plumb', 'implement',
  'remove', 'delete', 'cleanup', 'clean up', 'refactor',
  'test', 'run', 'kick off', 'trigger',
  'document', 'write up', 'summarize', 'recap', 'brief',
  'pull', 'fetch', 'download', 'upload', 'sync',
  'open', 'file', 'log', 'raise',
  'remind', 'schedule', 'book', 'plan',
  'spin up', 'start', 'launch', 'set up',
  'tear down', 'shut down', 'kill',
  'do', 'handle', 'take care', 'sort', 'work on'
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
  /** Reasons we dropped candidate extractions — useful for tuning. */
  dropped: Array<{ phrase: string; reason: 'negative_filter' | 'no_action_verb' | 'duplicate' }>;
}

export interface SurfaceTrigger {
  reason: 'heartbeat' | 'gap_resume' | 'manual';
  gapMs?: number;
}

/**
 * Classification produced by the extractor.
 *   explicit    — "I'll X / I will X / let me X" with action verb.
 *   implicit    — present-progressive "on it / checking that / looking into it".
 *   conditional — "once X, I'll Y / as soon as X, I'll Y / when X, I'll Y".
 */
type PromiseKind = 'explicit' | 'implicit' | 'conditional';

interface Candidate {
  phrase: string;
  kind: PromiseKind;
}

/**
 * Explicit-commitment patterns, anchored on first-person commitment verbs.
 * We capture the *whole* phrase including the anchor so the surface line
 * reads naturally back to the user.
 */
const EXPLICIT_PATTERNS: RegExp[] = [
  /\bI(?:'ll| will)\s+[^.!?\n]{3,160}/gi,
  /\blet me\s+[^.!?\n]{3,160}/gi,
  /\bI(?:'m| am) going to\s+[^.!?\n]{3,160}/gi,
  /\bI(?:'ll| will)? ?get back to you[^.!?\n]{0,120}/gi,
  /\bremind me\s+[^.!?\n]{3,160}/gi
];

/**
 * Implicit-commitment patterns. These are short, present-progressive
 * forms that say "I'm starting on this now" without an explicit "I'll".
 * We deliberately require a leading sentence boundary so we don't catch
 * "this is the thing I'm looking into in the meeting" — the leading
 * pattern anchors at start-of-sentence or message.
 *
 * Bare "on it" is its own pattern because the typical use is the entire
 * message body. We keep the capture short.
 */
const IMPLICIT_PATTERNS: RegExp[] = [
  /(?:^|[.!?\n]\s*)(on it\b[^.!?\n]{0,80})/gi,
  /(?:^|[.!?\n]\s*)(checking (?:that|on it|now|the)[^.!?\n]{0,120})/gi,
  /(?:^|[.!?\n]\s*)(looking (?:into|at) [^.!?\n]{3,120})/gi,
  /(?:^|[.!?\n]\s*)(working on [^.!?\n]{3,120})/gi,
  /(?:^|[.!?\n]\s*)(pulling (?:up|in) [^.!?\n]{3,120})/gi,
  /(?:^|[.!?\n]\s*)(taking a look[^.!?\n]{0,120})/gi
];

/**
 * Conditional patterns — capture both the condition and the action so the
 * surfaced promise reads "once X, I'll Y" not just "I'll Y".
 */
const CONDITIONAL_PATTERNS: RegExp[] = [
  /\b(once\s+[^.!?\n,]+,?\s*I(?:'ll| will)\s+[^.!?\n]{3,160})/gi,
  /\b(as soon as\s+[^.!?\n,]+,?\s*I(?:'ll| will)\s+[^.!?\n]{3,160})/gi,
  /\b(when\s+[^.!?\n,]+,?\s*I(?:'ll| will)\s+[^.!?\n]{3,160})/gi,
  /\b(after\s+[^.!?\n,]+,?\s*I(?:'ll| will)\s+[^.!?\n]{3,160})/gi
];

export class PromiseTracker {
  private db: SessionDB;
  private lastInboundAt: number | null = null;
  private gapThresholdMs: number;
  private wal: MemoryWAL | null;

  constructor(db: SessionDB, opts?: { gapThresholdMs?: number; wal?: MemoryWAL }) {
    this.db = db;
    this.gapThresholdMs = opts?.gapThresholdMs ?? 4 * 60 * 60 * 1000;
    this.wal = opts?.wal ?? null;
  }

  /**
   * Scan an outbound assistant message and persist any promises it
   * contains. Returns the new promise IDs plus a structured list of
   * dropped candidates (for tuning + tests). Idempotency: we don't
   * dedupe across calls — two restated promises become two rows, on the
   * theory that an assistant who repeats a commitment is being asked
   * about the same thing twice and Doctor should surface both. Within a
   * single call we collapse identical extractions.
   */
  extractFromOutbound(opts: {
    text: string;
    sessionId?: string | null;
    channel?: string | null;
  }): PromiseExtractionResult {
    const candidates = extractCandidates(opts.text);
    const ids: string[] = [];
    const dropped: PromiseExtractionResult['dropped'] = [];
    const seen = new Set<string>();

    for (const cand of candidates) {
      const phrase = cand.phrase.trim().replace(/\s+/g, ' ');
      if (!phrase) continue;

      const lower = phrase.toLowerCase();

      // Layer 1: negative filter.
      if (isNegativePhrase(lower)) {
        dropped.push({ phrase, reason: 'negative_filter' });
        continue;
      }

      // Layer 2: must contain an action verb (skip for conditionals — the
      // action half is gated by the explicit "I'll"/"I will" anchor, and
      // we already trust that capture).
      if (cand.kind !== 'conditional' && !hasActionVerb(lower)) {
        dropped.push({ phrase, reason: 'no_action_verb' });
        continue;
      }

      // Within-call dedupe.
      if (seen.has(lower)) {
        dropped.push({ phrase, reason: 'duplicate' });
        continue;
      }
      seen.add(lower);

      const id = randomUUID();
      // WAL the extraction BEFORE the canonical INSERT. A crash between
      // append() and insertPromise() leaves a row that flags an
      // unrealized commitment — strictly better than silently losing it.
      this.wal?.append({
        type: 'promise_extracted',
        sessionId: opts.sessionId ?? null,
        payload: {
          promiseId: id,
          text: phrase,
          kind: cand.kind,
          channel: opts.channel ?? null
        }
      });
      this.db.insertPromise({
        id,
        sessionId: opts.sessionId ?? null,
        channel: opts.channel ?? null,
        text: phrase
      });
      ids.push(id);
    }
    return { count: ids.length, ids, dropped };
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

// ── Extraction internals ───────────────────────────────────────────────────

/**
 * Run all three pattern families against the outbound text and return
 * the raw candidate list. Order matters only for downstream dedupe —
 * the per-pattern lastIndex resets handle re-entrant calls.
 */
function extractCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];

  const collect = (patterns: RegExp[], kind: PromiseKind) => {
    for (const re of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        // Some patterns wrap a leading-boundary group; prefer match[1]
        // when present (the captured commitment phrase) and fall back
        // to the full match.
        const phrase = (m[1] ?? m[0] ?? '').trim();
        if (phrase) out.push({ phrase, kind });
      }
    }
  };

  // Process conditionals first so an "once X, I'll Y" doesn't also get
  // picked up by the bare "I'll Y" explicit pattern and double-count.
  collect(CONDITIONAL_PATTERNS, 'conditional');
  collect(EXPLICIT_PATTERNS, 'explicit');
  collect(IMPLICIT_PATTERNS, 'implicit');

  // De-overlap: drop explicit candidates that are a substring of a
  // conditional candidate already captured. The conditional retains the
  // condition half and is the more informative row.
  const conditionals = out.filter((c) => c.kind === 'conditional').map((c) => c.phrase.toLowerCase());
  const filtered = out.filter((c) => {
    if (c.kind !== 'explicit') return true;
    const lower = c.phrase.toLowerCase();
    return !conditionals.some((cond) => cond.includes(lower));
  });
  return filtered;
}

function isNegativePhrase(lowerPhrase: string): boolean {
  for (const neg of NEGATIVE_PREFIXES) {
    if (lowerPhrase.startsWith(neg)) return true;
    // Also catch "I'll be honest with you" when prefix is "I'll be honest" —
    // already covered by startsWith. For middle-position matches like
    // "what I'll do is, I'll be honest, …" we keep startsWith only;
    // those are rare and the conservative path is fewer false-positives.
  }
  return false;
}

function hasActionVerb(lowerPhrase: string): boolean {
  for (const stem of ACTION_VERB_STEMS) {
    // Multi-word stems ("get back", "follow up") — substring match.
    if (stem.includes(' ')) {
      if (lowerPhrase.includes(stem)) return true;
      continue;
    }
    // Single-word — word-boundary match so "send" doesn't match "sender".
    const re = new RegExp(`\\b${escapeRegex(stem)}\\w{0,4}\\b`);
    if (re.test(lowerPhrase)) return true;
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
