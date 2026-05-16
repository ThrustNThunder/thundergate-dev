/**
 * ContextManager — cloud-mode context window controls.
 *
 * Scope: this module is the policy layer for `config.context`. It does
 * not touch LOCAL_INFERENCE memory architecture (that has its own spec
 * under `localInference.*`); operators routed to local inference get a
 * different code path entirely.
 *
 * Responsibilities:
 *
 *   • TTL gating — given config.context.sessionTtl and a last-activity
 *     timestamp, decide whether the next inbound triggers a reset.
 *
 *   • Compaction — given a transcript headed for callLLM and an
 *     estimated-token budget, prune it down using one of three
 *     strategies (`smart`, `aggressive`, `none`).
 *
 *   • Prune-on-reset — when a reset happens, sift recent turns for
 *     "important" content (decisions, corrections, milestones) and
 *     append a Markdown block to MEMORY.md so the next session has a
 *     running ledger of what's been settled.
 *
 *   • Cache-retention hint — convert config.context.cacheRetention into
 *     the Anthropic cache_control / beta-header shape that callLLM
 *     stamps onto the last user message.
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { Config } from '../config/loader.js';

export type TtlValue = '30m' | '1h' | '2h' | '4h' | 'unlimited';
export type CacheRetention = 'short' | 'long' | 'extended';
export type CompactionMode = 'smart' | 'aggressive' | 'none';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  // Optional tag the caller can supply so smart-compaction never prunes
  // it. Channels stamp 'decision' / 'correction' / 'milestone' when the
  // text contains the obvious markers; the caller can also stamp manually
  // (e.g. a future /pin-this command).
  tag?: 'decision' | 'correction' | 'milestone' | null;
}

export interface CacheControlHint {
  /** Anthropic cache_control payload to attach to the last user message. */
  cacheControl: { type: 'ephemeral'; ttl?: string };
  /** Beta header to append, if any (Anthropic gates extended TTLs behind beta). */
  betaHeader: string | null;
  /** Human-readable label for status output. */
  label: string;
}

/** Hard ceiling — Anthropic's window. */
export const MAX_TOKEN_CEILING = 200_000;

/** Default MEMORY.md target. Documented in the task brief. */
export const DEFAULT_MEMORY_PATH = '/home/ubuntu/.openclaw/workspace/MEMORY.md';

/**
 * Parse a TTL string into milliseconds. `'unlimited'` returns `Infinity`
 * so the caller's `(elapsed > ttl)` test stays a single line.
 */
export function parseTtl(value: TtlValue): number {
  switch (value) {
    case '30m': return 30 * 60 * 1000;
    case '1h':  return 60 * 60 * 1000;
    case '2h':  return 2 * 60 * 60 * 1000;
    case '4h':  return 4 * 60 * 60 * 1000;
    case 'unlimited': return Number.POSITIVE_INFINITY;
  }
}

export function isExpired(lastActivity: Date, ttl: TtlValue, now: number = Date.now()): boolean {
  const window = parseTtl(ttl);
  if (!Number.isFinite(window)) return false;
  return (now - lastActivity.getTime()) > window;
}

/**
 * Rough token estimate — 1 token ≈ 4 chars of English. Good enough for
 * the "should I compact?" decision; we are not budgeting against the API,
 * just deciding when to prune. If this proves loose in practice we swap
 * in a real tokenizer here without touching callers.
 */
export function estimateTokens(turns: Turn[]): number {
  let chars = 0;
  for (const t of turns) chars += t.content.length;
  return Math.ceil(chars / 4);
}

/**
 * Pattern for tagging a turn as "preserve through smart compaction". We
 * keep it broad on purpose — we'd rather over-preserve a milestone marker
 * than lose a real decision because the operator phrased it as "let's
 * agree to" instead of "decided".
 */
const KEEP_PATTERNS = [
  /\b(decided|decision|agree(?:d)?|going to|we will|let's lock|locked in)\b/i,
  /\b(correction|fix(?:ed)?|wrong|actually|disregard|ignore the previous|scratch that)\b/i,
  /\b(milestone|shipped|launched|released|cutover|gate passed|signed off)\b/i,
  /\b(rule|principle|policy|invariant|never|always)\b/i
];

export function tagTurn(turn: { role: 'user' | 'assistant'; content: string }): Turn {
  for (const p of KEEP_PATTERNS) {
    if (p.test(turn.content)) {
      if (/correction|fix|wrong|actually|disregard|scratch that/i.test(turn.content)) {
        return { ...turn, tag: 'correction' };
      }
      if (/milestone|shipped|launched|released|cutover|gate/i.test(turn.content)) {
        return { ...turn, tag: 'milestone' };
      }
      return { ...turn, tag: 'decision' };
    }
  }
  return { ...turn, tag: null };
}

export interface CompactResult {
  turns: Turn[];
  removed: number;
  beforeTokens: number;
  afterTokens: number;
  mode: CompactionMode;
}

/**
 * Apply the configured compaction style. Returns the pruned transcript
 * plus stats so callers can log what happened — silent compaction is the
 * fastest way to lose trust in the system.
 *
 *   • smart      — keep last 20 turns + any tagged turn anywhere in history
 *   • aggressive — keep last 5 turns, everything else dropped
 *   • none       — pass through
 *
 * We do not compact below `keep` turns even if the result is still over
 * budget. That's a deliberate floor: an over-budget call is still a
 * better outcome than dropping the most recent context, which is what
 * the LLM needs most.
 */
export function compactForInference(
  turns: Turn[],
  mode: CompactionMode,
  maxTokens: number
): CompactResult {
  const beforeTokens = estimateTokens(turns);
  if (mode === 'none' || beforeTokens <= maxTokens) {
    return { turns, removed: 0, beforeTokens, afterTokens: beforeTokens, mode };
  }

  const keepCount = mode === 'aggressive' ? 5 : 20;
  if (turns.length <= keepCount) {
    return { turns, removed: 0, beforeTokens, afterTokens: beforeTokens, mode };
  }

  const recentStart = turns.length - keepCount;
  const recent = turns.slice(recentStart);

  if (mode === 'aggressive') {
    const afterTokens = estimateTokens(recent);
    return {
      turns: recent,
      removed: turns.length - recent.length,
      beforeTokens,
      afterTokens,
      mode
    };
  }

  // smart: also keep tagged turns from before the recent window, in their
  // original order, so the LLM sees decisions/corrections/milestones in
  // sequence rather than dumped at the front.
  const preservedOlder = turns.slice(0, recentStart).filter((t) => !!t.tag);
  const kept = [...preservedOlder, ...recent];
  const afterTokens = estimateTokens(kept);
  return {
    turns: kept,
    removed: turns.length - kept.length,
    beforeTokens,
    afterTokens,
    mode
  };
}

/**
 * Build the Anthropic cache_control payload + beta-header for the
 * configured retention hint. Anthropic's documented surface:
 *
 *   short    — type=ephemeral, no ttl (default ~5min)
 *   long     — type=ephemeral, ttl='1h' + beta header
 *   extended — type=ephemeral, ttl='4h' + extended beta header
 *
 * If Anthropic changes the beta headers, this is the one place to keep
 * in sync — callLLM reads the returned `betaHeader` and stamps it.
 */
export function cacheHintForRetention(retention: CacheRetention): CacheControlHint {
  // Anthropic's current ephemeral cache TTL surface accepts ONLY '5m'
  // (default — omitted) and '1h' (via the extended-cache-ttl beta). 4h
  // hasn't shipped on this API path yet; we keep the operator-facing
  // "extended" label and fall back to '1h' under the hood so the
  // selection round-trips a valid request. When 4h ships we lift the
  // floor on this branch in one place.
  switch (retention) {
    case 'short':
      return {
        cacheControl: { type: 'ephemeral' },
        betaHeader: null,
        label: 'short (~5min, default)'
      };
    case 'long':
      return {
        cacheControl: { type: 'ephemeral', ttl: '1h' },
        betaHeader: 'extended-cache-ttl-2025-04-11',
        label: 'long (1h)'
      };
    case 'extended':
      return {
        cacheControl: { type: 'ephemeral', ttl: '1h' },
        betaHeader: 'extended-cache-ttl-2025-04-11',
        label: 'extended (1h — 4h pending API support)'
      };
  }
}

/**
 * Sift recent turns for the bullets that belong in MEMORY.md, write the
 * block, and return what was extracted so the caller can log + report.
 *
 * "Important" = tagged turn or matches one of the keep-patterns. We cap
 * the output at the last 10 such hits so MEMORY.md doesn't bloat
 * unboundedly on a long session.
 */
export interface PruneResult {
  written: boolean;
  bullets: string[];
  path: string;
  reason?: string;
}

export function pruneToMemory(
  turns: Turn[],
  oldSessionId: string,
  memoryPath: string = DEFAULT_MEMORY_PATH,
  now: Date = new Date()
): PruneResult {
  const tagged = turns.map(tagTurn).filter((t) => t.tag !== null);
  // Even untagged turns can be worth keeping if they contain a numeric
  // commitment, a URL, or an absolute date. Tier-2 heuristics, applied
  // only when tier-1 (KEEP_PATTERNS) didn't hit on that turn already.
  for (const t of turns) {
    if (tagged.some((tt) => tt === t)) continue;
    if (/\b\d{4}-\d{2}-\d{2}\b|https?:\/\/\S+|\b\d+%/.test(t.content)) {
      tagged.push({ ...t, tag: 'milestone' });
    }
  }
  if (tagged.length === 0) {
    return { written: false, bullets: [], path: memoryPath, reason: 'no important turns to extract' };
  }
  const bullets = tagged.slice(-10).map((t) => {
    const speaker = t.role === 'user' ? 'Michael' : 'Jon';
    const oneLine = t.content.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? t.content;
    const trimmed = oneLine.length > 240 ? oneLine.slice(0, 237) + '…' : oneLine;
    return `- **${speaker}** [${t.tag}] — ${trimmed}`;
  });
  const stamp = now.toISOString().replace('T', ' ').slice(0, 19);
  const block =
    `\n## Pruned from ThunderGate session \`${oldSessionId}\` — ${stamp}\n\n` +
    bullets.join('\n') + '\n';
  try {
    mkdirSync(dirname(memoryPath), { recursive: true });
    appendFileSync(memoryPath, block);
    return { written: true, bullets, path: memoryPath };
  } catch (err) {
    return {
      written: false,
      bullets,
      path: memoryPath,
      reason: `append failed: ${(err as Error).message}`
    };
  }
}

/**
 * Convenience accessor — surfaces the context block whether or not the
 * operator's config.json was written before the schema added it. Calling
 * `cfg.context` on a legacy load returns undefined; this returns sane
 * defaults instead so downstream code doesn't have to null-check.
 */
export function effectiveContextConfig(cfg: Config): Config['context'] {
  return cfg.context ?? {
    sessionTtl: '1h',
    cacheRetention: 'long',
    compaction: 'smart',
    maxTokens: 150000,
    pruneOnReset: true
  };
}

/** Stable env helper for `context status` token-usage approximation. */
export function memoryPathFor(_cfg: Config): string {
  // Hard-coded in the task brief; we keep the helper here so future
  // configurability lands in one place.
  return DEFAULT_MEMORY_PATH;
}

// Suppress unused-import noise if a refactor leaves these helpers cold.
void existsSync;
