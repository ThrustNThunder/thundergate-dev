/**
 * Ghost Jon — shadow-mode harness
 *
 * Runs ThunderGate alongside OpenClaw on the same inputs. ThunderGate's
 * answers are written to a log file but NEVER delivered. Operators read
 * the log; after seven straight days of clean doctor checks Michael
 * flips the cutover.
 *
 * Constraints (locked principles):
 *   - READ ONLY against OpenClaw — never write back to its session file
 *   - Never deliver responses anywhere
 *   - Never modify ThunderGate's primary state machine
 *   - Doctor mode must always tell the truth — no happy-path lying
 */

import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  statSync,
  watch,
  type FSWatcher
} from 'fs';
import { dirname } from 'path';
import { createInterface } from 'readline';
import type { Config } from '../config/loader.js';

export interface GhostEntry {
  timestamp: number;
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

export class GhostHarness {
  private config: Config;
  private logFile: string;
  private sessionFile: string;
  private watcher: FSWatcher | null = null;
  private respond: GhostResponder;
  private running = false;
  private pendingInput: { text: string; ts: number } | null = null;
  private fileOffset = 0;
  private processedCount = 0;
  private startedAt: number | null = null;
  private lastError: string | null = null;

  constructor(config: Config, respond: GhostResponder) {
    this.config = config;
    this.sessionFile = config.ghost.openclaw_session;
    this.logFile = config.ghost.log_file;
    this.respond = respond;
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.ensureLogDir();

    if (!existsSync(this.sessionFile)) {
      this.lastError = `OpenClaw session file not found: ${this.sessionFile}`;
      console.warn(`  ⚠ Ghost: ${this.lastError}`);
      // Still mark running so status reflects intent — fs.watch can't
      // attach to a missing path, so we'll retry on each tick.
    } else {
      // Start at end-of-file: we shadow new traffic, not history.
      this.fileOffset = statSync(this.sessionFile).size;
      this.attachWatcher();
    }

    this.running = true;
    this.startedAt = Date.now();
    console.log(`  ✓ Ghost harness running, log: ${this.logFile}`);
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
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
    sessionFile: string;
    logFile: string;
    lastError: string | null;
  } {
    return {
      running: this.running,
      processed: this.processedCount,
      startedAt: this.startedAt,
      sessionFile: this.sessionFile,
      logFile: this.logFile,
      lastError: this.lastError
    };
  }

  // ── File watching ───────────────────────────────────────────────────────

  private attachWatcher(): void {
    try {
      this.watcher = watch(this.sessionFile, { persistent: false }, (event) => {
        if (event !== 'change') return;
        this.drain().catch((err) => {
          this.lastError = `drain failed: ${(err as Error).message}`;
          console.error('  ✗ Ghost drain error:', err);
        });
      });
    } catch (err) {
      this.lastError = `watcher attach failed: ${(err as Error).message}`;
      console.warn(`  ⚠ Ghost: ${this.lastError}`);
    }
  }

  /**
   * Read everything new since fileOffset, parse JSONL, react to user
   * messages by asking ThunderGate, react to assistant messages by
   * pairing them with the most recent input and writing a ghost entry.
   */
  private async drain(): Promise<void> {
    if (!existsSync(this.sessionFile)) return;
    const size = statSync(this.sessionFile).size;
    if (size <= this.fileOffset) {
      // Truncation/rotation — reset to start.
      if (size < this.fileOffset) this.fileOffset = 0;
      else return;
    }

    const stream = createReadStream(this.sessionFile, {
      start: this.fileOffset,
      end: size - 1
    });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      const parsed = parseLine(line);
      if (!parsed) continue;

      if (parsed.role === 'user') {
        this.pendingInput = { text: parsed.text, ts: parsed.ts };
        // Fire ThunderGate in parallel with OpenClaw — we still wait for
        // OpenClaw's response to arrive before logging the pair.
        this.askThunderGate(parsed.text, parsed.ts).catch((err) => {
          console.warn('  ⚠ Ghost ThunderGate response failed:', (err as Error).message);
        });
      } else if (parsed.role === 'assistant' && this.pendingInput) {
        this.pairWithOpenClaw(parsed.text);
      }
    }
    this.fileOffset = size;
  }

  private tgResponses = new Map<string, { response: string; latency_ms: number }>();

  private async askThunderGate(input: string, ts: number): Promise<void> {
    const started = Date.now();
    let response = '';
    try {
      response = await this.respond(input);
    } catch (err) {
      response = `[ghost error: ${(err as Error).message}]`;
    }
    const latency_ms = Date.now() - started;
    this.tgResponses.set(this.keyFor(input, ts), { response, latency_ms });
  }

  private pairWithOpenClaw(openclawResponse: string): void {
    const pending = this.pendingInput;
    if (!pending) return;
    this.pendingInput = null;

    const key = this.keyFor(pending.text, pending.ts);
    const tg = this.tgResponses.get(key);
    this.tgResponses.delete(key);

    // If TG hasn't completed yet, log what we have and mark latency=-1
    // so the evaluator can see the slowness rather than us silently
    // dropping the pair. Doctor must tell the truth.
    const entry: GhostEntry = {
      timestamp: Date.now(),
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

  private keyFor(input: string, ts: number): string {
    return `${ts}:${input.slice(0, 64)}`;
  }

  private ensureLogDir(): void {
    const dir = dirname(this.logFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * OpenClaw session lines come in a few shapes. Be liberal in what we
 * accept — any object with a recognizable role + textual content works.
 */
function parseLine(line: string): ParsedOpenclawLine | null {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }

  const role = (obj.role || obj.type || obj.message?.role || '').toString();
  const ts = Number(obj.timestamp ?? obj.ts ?? Date.now());

  let text = '';
  if (typeof obj.content === 'string') text = obj.content;
  else if (typeof obj.text === 'string') text = obj.text;
  else if (typeof obj.message?.content === 'string') text = obj.message.content;
  else if (Array.isArray(obj.content)) {
    text = obj.content
      .filter((p: any) => typeof p?.text === 'string')
      .map((p: any) => p.text)
      .join('\n');
  } else if (Array.isArray(obj.message?.content)) {
    text = obj.message.content
      .filter((p: any) => typeof p?.text === 'string')
      .map((p: any) => p.text)
      .join('\n');
  }

  if (!text) return null;

  if (role === 'user' || role === 'human') {
    return { role: 'user', text, ts };
  }
  if (role === 'assistant' || role === 'agent' || role === 'ai') {
    return { role: 'assistant', text, ts };
  }
  if (role === 'system') return { role: 'system', text, ts };
  if (role === 'tool' || role === 'tool_result') return { role: 'tool', text, ts };
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
