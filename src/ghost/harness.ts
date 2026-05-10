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

export interface GhostEntry {
  timestamp: number;
  session_id: string;
  input: string;
  openclaw_response: string | null;
  thundergate_response: string;
  match: boolean;
  latency_ms: number;
}

export type GhostResponder = (input: string) => Promise<string>;

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
}

const RESCAN_INTERVAL_MS = 30_000;

export class GhostHarness {
  private config: Config;
  private logFile: string;
  private sessionsDir: string;
  private watchIntervalMs: number;
  private respond: GhostResponder;
  private running = false;
  private sessions = new Map<string, SessionState>();
  private rescanTimer: NodeJS.Timeout | null = null;
  private processedCount = 0;
  private startedAt: number | null = null;
  private lastError: string | null = null;
  private tgResponses = new Map<string, { response: string; latency_ms: number }>();

  constructor(config: Config, respond: GhostResponder) {
    this.config = config;
    this.sessionsDir = config.ghost.sessions_dir;
    this.watchIntervalMs = config.ghost.watch_interval_ms;
    this.logFile = config.ghost.log_file;
    this.respond = respond;
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
      const path = join(this.sessionsDir, name);
      if (this.sessions.has(path)) continue;

      let size = 0;
      try {
        size = statSync(path).size;
      } catch {
        continue;
      }

      const sessionId = basename(name, '.jsonl');
      this.sessions.set(path, { path, sessionId, offset: size, pendingInput: null });
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
        // Fire ThunderGate in parallel with OpenClaw — we still wait for
        // OpenClaw's response to arrive before logging the pair.
        this.askThunderGate(session.sessionId, parsed.text, parsed.ts).catch((err) => {
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
    ts: number
  ): Promise<void> {
    const started = Date.now();
    let response = '';
    try {
      response = await this.respond(input);
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

    const entry: GhostEntry = {
      timestamp: Date.now(),
      session_id: session.sessionId,
      input: pending.text,
      openclaw_response: openclawResponse,
      thundergate_response: tg?.response ?? '[ghost: not yet ready]',
      match: tg ? fuzzyMatch(openclawResponse, tg.response) : false,
      latency_ms: tg?.latency_ms ?? -1
    };

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

/**
 * Cheap heuristic — true if the two responses share enough lowercase
 * tokens to plausibly agree. Real evaluation happens in evaluator.ts.
 */
function fuzzyMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const norm = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4)
    );
  const sa = norm(a);
  const sb = norm(b);
  if (sa.size === 0 || sb.size === 0) return false;
  let overlap = 0;
  for (const tok of sa) if (sb.has(tok)) overlap++;
  const union = sa.size + sb.size - overlap;
  return union > 0 && overlap / union >= 0.3;
}
