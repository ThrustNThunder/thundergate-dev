/**
 * Ghost Jon — shadow-mode harness
 *
 * Runs ThunderGate alongside OpenClaw on the same inputs. ThunderGate's
 * answers are written to a log file but NEVER delivered. Operators read
 * the log; after seven straight days of clean doctor checks Michael
 * flips the cutover.
 *
 * Constraints (locked principles):
 *   - READ ONLY against OpenClaw — never write back to its session files
 *   - Never deliver responses anywhere
 *   - Never modify ThunderGate's primary state machine
 *   - Doctor mode must always tell the truth — no happy-path lying
 *
 * Watching strategy:
 *   - fs.watchFile (polling) — reliable on Linux for append-only JSONL,
 *     unlike fs.watch which often misses appends.
 *   - Watch every *.jsonl in the OpenClaw sessions directory, not just
 *     one — covers ThunderCommo, Slack, WhatsApp, cron, etc.
 *   - Periodic rescan picks up newly created sessions.
 */

import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unwatchFile,
  watchFile
} from 'fs';
import { basename, dirname, join } from 'path';
import { createInterface } from 'readline';
import type { Config } from '../config/loader.js';
import {
  compareResponses,
  voyageEmbedder,
  type EmbeddingFn,
  type MatchResult
} from './compare.js';

export interface GhostEntry {
  timestamp: number;
  session_id: string;
  input: string;
  openclaw_response: string | null;
  thundergate_response: string;
  match: boolean;
  /**
   * Tiered comparator score (0..1). `match` is `score >= 0.75`. Older
   * log lines pre-dating the tiered metric won't have this field; the
   * evaluator falls back to the binary `match` value when it's absent.
   */
  score?: number;
  /** Which tier produced the verdict — useful for doctor diagnostics. */
  match_tier?: 1 | 2 | 3;
  /**
   * Tier-3 (Voyage) status for this pair. `used` = real API call.
   * `cached` = pair seen before, served from the LRU. `not_needed` =
   * tier 1 or strong tier-2 short-circuited. `no_key` = embedder
   * unavailable. `error` = call failed and tier-2 was returned. Lets
   * Doctor compute tier-3 usage rate without re-streaming the log.
   */
  embedding_status?: 'not_needed' | 'no_key' | 'error' | 'used' | 'cached';
  latency_ms: number;
}

/**
 * A turn the harness has already seen in this session. The Ghost predictor
 * needs prior (user, assistant) pairs to mirror Jon's voice and stay
 * grounded in references the live agent already resolved.
 */
export interface GhostTurn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Optional extras for a single shadow call. Today this carries the
 * "current system state" block we inject for status-type prompts so
 * Ghost predicts the same numbers Jon would. Held as an options bag so
 * future per-call signals (device hint, frame metadata, …) land without
 * another signature break.
 */
export interface GhostResponderOpts {
  /**
   * Multi-line snapshot of live ThunderGate state — ghost score, WAL,
   * promises, frame, services, inference mode. The implementer is
   * expected to prepend this to the system prompt under a "Current
   * System State" header so the LLM treats it as ground truth, not
   * conversational context.
   */
  stateSnapshot?: string;
}

export type GhostResponder = (
  input: string,
  history: GhostTurn[],
  opts?: GhostResponderOpts
) => Promise<string>;

/**
 * Source of truth for a single state-snapshot rendering. The harness
 * carries no direct refs to runtime substrate — runtime constructs one
 * of these and passes it in. The calibrator builds a minimal variant
 * from the evaluator + process uptime so calibration runs without a
 * live gateway also benefit from real numbers.
 *
 * Every field is optional: snapshots degrade gracefully when a source
 * is unavailable. Missing values render as `unknown` instead of being
 * fabricated — Doctor must keep telling the truth.
 */
export interface StateSnapshotSource {
  /** Latest weighted score + sample count for *today*. */
  ghostScore?: () => { weightedScore: number; samples: number; matchRate: number } | null;
  /** WAL counters: hot rows, last rotation epoch ms. */
  walStats?: () => { hotRows: number; lastRotationAt: number | null } | null;
  /** Count of currently open promises. */
  openPromiseCount?: () => number | null;
  /** Current frame topic + status (e.g. "ghost-tier1 / ACTIVE"). */
  currentFrame?: () => { topic: string; status: string } | null;
  /** LocalInference mode + breaker state. */
  inferenceState?: () => { mode: string; breakerOpen: boolean; reachable: boolean } | null;
  /** Service uptime breakdown — service name → uptime ms (or null if unknown). */
  serviceUptime?: () => Array<{ name: string; uptimeMs: number | null }>;
  /** Wall-clock at the moment the snapshot is built. */
  now?: () => number;
}

/**
 * Keywords that trip status-query detection. Matched case-insensitively
 * against the user input. The list is small and conservative on
 * purpose — false-positives turn ordinary turns into status briefings
 * and tank semantic match; we'd rather miss a few than over-fire.
 */
const STATUS_QUERY_KEYWORDS = [
  "how's",
  "hows",
  'ghost',
  'status',
  'score',
  'health',
  'update',
  "what's running",
  'whats running',
  'any updates',
  'wal',
  'doctor',
  'uptime'
] as const;

/**
 * True when an inbound looks like a "what's the system doing right now"
 * ask. Matched against a lowercased single-line normalization of the
 * input. Word-bounded for short keywords so "scoreboard" doesn't fire
 * "score", but multi-word phrases match by substring (they already
 * carry enough specificity).
 */
export function isStatusQuery(input: string): boolean {
  if (!input) return false;
  const t = input.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return false;
  for (const kw of STATUS_QUERY_KEYWORDS) {
    if (kw.includes(' ') || kw.includes("'")) {
      if (t.includes(kw)) return true;
    } else {
      const re = new RegExp(`\\b${kw}\\b`);
      if (re.test(t)) return true;
    }
  }
  return false;
}

/**
 * Render a "Current System State" snapshot from the available sources.
 * The output is a Markdown block intended to be prepended to the Ghost
 * system prompt under a `## Current System State` header. Lines a
 * source cannot populate are omitted entirely (rather than rendered as
 * "n/a") so the snapshot stays compact when the gateway is partially
 * up.
 *
 * Returns `null` when no source contributes — callers can skip the
 * prepend cleanly without producing an orphan header.
 */
export function buildStateSnapshot(source: StateSnapshotSource): string | null {
  const lines: string[] = [];
  const now = source.now ? source.now() : Date.now();

  try {
    const s = source.ghostScore?.();
    if (s) {
      lines.push(
        `- ghost: weighted_score=${s.weightedScore.toFixed(2)} ` +
        `samples=${s.samples} match_rate=${s.matchRate.toFixed(2)}`
      );
    }
  } catch {
    /* one bad source must not poison the whole snapshot */
  }

  try {
    const w = source.walStats?.();
    if (w) {
      const rot = w.lastRotationAt
        ? `${Math.round((now - w.lastRotationAt) / 60_000)}m ago`
        : 'never';
      lines.push(`- wal: hot_rows=${w.hotRows} last_rotation=${rot}`);
    }
  } catch {
    /* swallow */
  }

  try {
    const p = source.openPromiseCount?.();
    if (typeof p === 'number') {
      lines.push(`- promises: open=${p}`);
    }
  } catch {
    /* swallow */
  }

  try {
    const f = source.currentFrame?.();
    if (f) {
      lines.push(`- frame: ${f.topic} (${f.status})`);
    }
  } catch {
    /* swallow */
  }

  try {
    const i = source.inferenceState?.();
    if (i) {
      lines.push(
        `- inference: mode=${i.mode} reachable=${i.reachable} ` +
        `breaker=${i.breakerOpen ? 'OPEN' : 'closed'}`
      );
    }
  } catch {
    /* swallow */
  }

  try {
    const services = source.serviceUptime?.();
    if (services && services.length > 0) {
      const rendered = services
        .map((s) => {
          if (s.uptimeMs == null) return `${s.name}=?`;
          const mins = Math.round(s.uptimeMs / 60_000);
          return `${s.name}=${mins}m`;
        })
        .join(' ');
      lines.push(`- services: ${rendered}`);
    }
  } catch {
    /* swallow */
  }

  if (lines.length === 0) return null;

  return ['## Current System State', '', ...lines].join('\n');
}

interface ParsedOpenclawLine {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  ts: number;
}

interface SessionState {
  path: string;
  sessionId: string;
  offset: number;
  pendingInput: { text: string; ts: number } | null;
  /**
   * Completed turns for this session, oldest first. Trimmed to
   * MAX_HISTORY_TURNS — enough context for the predictor without bloating
   * every shadow call. A "completed" turn is a user+assistant pair where
   * both sides have arrived; we push the user first, then update the
   * trailing entry when the assistant line lands.
   */
  history: GhostTurn[];
}

const RESCAN_INTERVAL_MS = 30_000;
/**
 * Max prior turns we feed Ghost. 16 entries = ~8 user/assistant pairs.
 * Big enough that "what was the CC discussion?" stays in window; small
 * enough that Haiku stays fast and the per-call payload doesn't balloon.
 * The static SOUL/USER/IDENTITY/ADDENDUM block is cached in the system
 * prompt, so only this tail varies per call.
 */
const MAX_HISTORY_TURNS = 16;

export class GhostHarness {
  private config: Config;
  private logFile: string;
  private sessionsDir: string;
  private watchIntervalMs: number;
  private respond: GhostResponder;
  private snapshotSource: StateSnapshotSource | null;
  private running = false;
  private sessions = new Map<string, SessionState>();
  private rescanTimer: NodeJS.Timeout | null = null;
  private processedCount = 0;
  private startedAt: number | null = null;
  private lastError: string | null = null;
  private tgResponses = new Map<string, { response: string; latency_ms: number }>();
  private embed: EmbeddingFn | undefined;
  private embeddingSkipLogged = false;

  constructor(
    config: Config,
    respond: GhostResponder,
    snapshotSource?: StateSnapshotSource
  ) {
    this.config = config;
    this.sessionsDir = config.ghost.sessions_dir;
    this.watchIntervalMs = config.ghost.watch_interval_ms;
    this.logFile = config.ghost.log_file;
    this.respond = respond;
    this.snapshotSource = snapshotSource ?? null;
    // Tier-3 of the comparator hits Voyage's embeddings endpoint. If no
    // key is configured the comparator silently degrades to tier-2 and
    // tags the entry so doctor can see we skipped.
    if (config.voyageApiKey && config.voyageApiKey.length > 0) {
      this.embed = voyageEmbedder(config.voyageApiKey);
    }
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.ensureLogDir();

    if (!existsSync(this.sessionsDir)) {
      this.lastError = `OpenClaw sessions dir not found: ${this.sessionsDir}`;
      console.warn(`  ⚠ Ghost: ${this.lastError}`);
    } else {
      this.scanAndAttach();
    }

    this.rescanTimer = setInterval(() => {
      this.scanAndAttach();
    }, RESCAN_INTERVAL_MS);
    this.rescanTimer.unref?.();

    this.running = true;
    this.startedAt = Date.now();
    console.log(`  ✓ Ghost harness running, log: ${this.logFile}`);
    console.log(`  ✓ Watching ${this.sessions.size} session(s) in ${this.sessionsDir}`);
  }

  async stop(): Promise<void> {
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = null;
    }
    for (const path of this.sessions.keys()) {
      try {
        unwatchFile(path);
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
    this.running = false;
    this.startedAt = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  getStats(): {
    running: boolean;
    processed: number;
    startedAt: number | null;
    sessionsDir: string;
    sessionCount: number;
    logFile: string;
    lastError: string | null;
  } {
    return {
      running: this.running,
      processed: this.processedCount,
      startedAt: this.startedAt,
      sessionsDir: this.sessionsDir,
      sessionCount: this.sessions.size,
      logFile: this.logFile,
      lastError: this.lastError
    };
  }

  // ── Session discovery & watching ──────────────────────────────────────────

  /**
   * Scan the sessions directory and start watching any *.jsonl file we
   * haven't seen before. Newly discovered files start at end-of-file —
   * we shadow new traffic, not history.
   *
   * Filenames like `<id>.jsonl.reset.<ts>` and `<id>.jsonl.deleted.<ts>`
   * are intentionally skipped — they're frozen archives, not active.
   */
  private scanAndAttach(): void {
    let entries: string[];
    try {
      entries = readdirSync(this.sessionsDir);
    } catch (err) {
      this.lastError = `sessions dir read failed: ${(err as Error).message}`;
      return;
    }

    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      // Skip synthetic pressure-test sessions — they carry no real OpenClaw
      // counterpart so their fuzzy-match rate is always 0 and would tank
      // the daily score (and the 7-day clean clock) for whatever day the
      // test ran.
      if (name.startsWith('ghost-test-')) continue;
      const path = join(this.sessionsDir, name);
      if (this.sessions.has(path)) continue;

      let size = 0;
      try {
        size = statSync(path).size;
      } catch {
        continue;
      }

      const sessionId = basename(name, '.jsonl');
      this.sessions.set(path, {
        path,
        sessionId,
        offset: size,
        pendingInput: null,
        history: []
      });
      this.attachWatcher(path);
    }
  }

  private attachWatcher(path: string): void {
    try {
      watchFile(
        path,
        { interval: this.watchIntervalMs, persistent: false },
        (curr, prev) => {
          if (curr.size === prev.size && curr.mtimeMs === prev.mtimeMs) return;
          this.drain(path).catch((err) => {
            this.lastError = `drain failed (${basename(path)}): ${(err as Error).message}`;
            console.error('  ✗ Ghost drain error:', err);
          });
        }
      );
    } catch (err) {
      this.lastError = `watcher attach failed (${basename(path)}): ${(err as Error).message}`;
      console.warn(`  ⚠ Ghost: ${this.lastError}`);
    }
  }

  /**
   * Read everything appended to one session since its last offset, parse
   * JSONL, react to human messages by asking ThunderGate, react to
   * assistant messages by pairing them with the most recent input from
   * this same session and writing a ghost entry.
   */
  private async drain(path: string): Promise<void> {
    const session = this.sessions.get(path);
    if (!session) return;
    if (!existsSync(path)) return;

    const size = statSync(path).size;
    if (size <= session.offset) {
      // Truncation/rotation — reset to start.
      if (size < session.offset) session.offset = 0;
      else return;
    }

    const stream = createReadStream(path, {
      start: session.offset,
      end: size - 1
    });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      const parsed = parseLine(line);
      if (!parsed) continue;

      if (parsed.role === 'user') {
        session.pendingInput = { text: parsed.text, ts: parsed.ts };
        // Snapshot history at the moment of fire so Ghost sees the same
        // context Jon had when he wrote his reply. A later assistant line
        // that arrives before Ghost finishes must NOT leak into the
        // prediction — that would let Ghost copy from the answer key.
        const historyForCall = session.history.slice();
        // Fire ThunderGate in parallel with OpenClaw — we still wait for
        // OpenClaw's response to arrive before logging the pair.
        this.askThunderGate(
          session.sessionId,
          parsed.text,
          parsed.ts,
          historyForCall
        ).catch((err) => {
          console.warn('  ⚠ Ghost ThunderGate response failed:', (err as Error).message);
        });
      } else if (parsed.role === 'assistant' && session.pendingInput) {
        this.pairWithOpenClaw(session, parsed.text).catch((err) => {
          console.error('  ✗ Ghost pair error:', err);
        });
      }
      // Skip system and tool messages — those are not human input.
    }
    session.offset = size;
  }

  private async askThunderGate(
    sessionId: string,
    input: string,
    ts: number,
    history: GhostTurn[]
  ): Promise<void> {
    const started = Date.now();
    let response = '';
    try {
      // Status-type prompts get a live state injection. Without it,
      // Ghost invents numbers and can never tier-1 against Jon's real
      // answer. Snapshot is built lazily — non-status turns pay
      // nothing.
      let opts: GhostResponderOpts | undefined;
      if (this.snapshotSource && isStatusQuery(input)) {
        const snap = buildStateSnapshot(this.snapshotSource);
        if (snap) opts = { stateSnapshot: snap };
      }
      response = await this.respond(input, history, opts);
    } catch (err) {
      response = `[ghost error: ${(err as Error).message}]`;
    }
    const latency_ms = Date.now() - started;
    this.tgResponses.set(this.keyFor(sessionId, input, ts), { response, latency_ms });
  }

  /**
   * Pair OpenClaw's response with ThunderGate's shadow response. The LLM
   * call is async and can outlast OpenClaw's reply (Haiku currently ~2-3s,
   * but tail can be longer). If the shadow response hasn't landed yet,
   * poll for up to 30s before giving up. Doctor must tell the truth — a
   * `[ghost: not yet ready]` after waiting is honest; a premature one
   * masks working pairs as failures and tanks the match rate.
   */
  private async pairWithOpenClaw(
    session: SessionState,
    openclawResponse: string
  ): Promise<void> {
    const pending = session.pendingInput;
    if (!pending) return;
    session.pendingInput = null;

    const key = this.keyFor(session.sessionId, pending.text, pending.ts);

    const maxWaitMs = 30_000;
    const pollMs = 100;
    const deadline = Date.now() + maxWaitMs;
    let tg = this.tgResponses.get(key);
    while (!tg && Date.now() < deadline) {
      await sleep(pollMs);
      tg = this.tgResponses.get(key);
    }
    this.tgResponses.delete(key);

    let comparison: MatchResult | null = null;
    if (tg) {
      try {
        comparison = await compareResponses(openclawResponse, tg.response, this.embed);
      } catch (err) {
        this.lastError = `compare failed: ${(err as Error).message}`;
        comparison = null;
      }
      if (
        comparison &&
        comparison.embedding_skipped === 'no_key' &&
        !this.embeddingSkipLogged
      ) {
        // One-shot info log per process — don't spam stdout for every pair.
        console.log('  ℹ Ghost: voyageApiKey not set; tier-3 cosine skipped, using tier-1/2 only.');
        this.embeddingSkipLogged = true;
      }
    }

    const entry: GhostEntry = {
      timestamp: Date.now(),
      session_id: session.sessionId,
      input: pending.text,
      openclaw_response: openclawResponse,
      thundergate_response: tg?.response ?? '[ghost: not yet ready]',
      match: comparison ? comparison.match : false,
      score: comparison ? comparison.score : 0,
      match_tier: comparison ? comparison.tier : undefined,
      embedding_status: comparison ? comparison.embedding_skipped : undefined,
      latency_ms: tg?.latency_ms ?? -1
    };

    // Commit the completed pair to per-session history. We feed Jon's
    // actual reply forward — never Ghost's — so the predictor's next
    // call sees the same conversation Jon sees. Trim from the head to
    // keep the window bounded.
    session.history.push({ role: 'user', text: pending.text });
    session.history.push({ role: 'assistant', text: openclawResponse });
    if (session.history.length > MAX_HISTORY_TURNS) {
      session.history.splice(0, session.history.length - MAX_HISTORY_TURNS);
    }

    try {
      appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
      this.processedCount++;
    } catch (err) {
      this.lastError = `log write failed: ${(err as Error).message}`;
      console.error('  ✗ Ghost log write failed:', err);
    }
  }

  private keyFor(sessionId: string, input: string, ts: number): string {
    return `${sessionId}:${ts}:${input.slice(0, 64)}`;
  }

  private ensureLogDir(): void {
    const dir = dirname(this.logFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * OpenClaw session lines come in a few shapes. Be liberal in what we
 * accept — any object with a recognizable role + textual content works.
 *
 * OpenClaw v3 wraps the role under `message.role` and uses a top-level
 * `type: "message"` envelope; older formats put role at the top level.
 * We prefer the inner role and fall back to top-level.
 */
function parseLine(line: string): ParsedOpenclawLine | null {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }

  let rawRole = '';
  if (typeof obj.message?.role === 'string') rawRole = obj.message.role;
  else if (typeof obj.role === 'string') rawRole = obj.role;
  else if (typeof obj.sender_type === 'string') rawRole = obj.sender_type;
  else if (typeof obj.type === 'string') {
    const t = obj.type;
    if (
      t === 'user' ||
      t === 'human' ||
      t === 'assistant' ||
      t === 'agent' ||
      t === 'ai' ||
      t === 'system' ||
      t === 'tool' ||
      t === 'tool_result'
    ) {
      rawRole = t;
    }
  }
  rawRole = rawRole.toLowerCase();

  const ts = Number(obj.timestamp ?? obj.ts ?? Date.now());

  let text = '';
  if (Array.isArray(obj.message?.content)) {
    text = obj.message.content
      .filter((p: any) => typeof p?.text === 'string')
      .map((p: any) => p.text)
      .join('\n');
  } else if (typeof obj.message?.content === 'string') {
    text = obj.message.content;
  } else if (typeof obj.content === 'string') {
    text = obj.content;
  } else if (Array.isArray(obj.content)) {
    text = obj.content
      .filter((p: any) => typeof p?.text === 'string')
      .map((p: any) => p.text)
      .join('\n');
  } else if (typeof obj.text === 'string') {
    text = obj.text;
  }

  if (!text) return null;

  if (rawRole === 'user' || rawRole === 'human') {
    return { role: 'user', text, ts };
  }
  if (rawRole === 'assistant' || rawRole === 'agent' || rawRole === 'ai') {
    return { role: 'assistant', text, ts };
  }
  if (rawRole === 'system') return { role: 'system', text, ts };
  if (rawRole === 'tool' || rawRole === 'tool_result') return { role: 'tool', text, ts };
  return null;
}

