/**
 * Ghost Jon — evaluator and scoring
 *
 * Reads ghost-log.jsonl and produces a daily health snapshot. Doctor mode
 * pulls these numbers as one of its inputs to decide cutover-readiness.
 *
 * Scoring is deliberately simple — three axes, all observable, all
 * truthful. We do not estimate things we can't measure.
 */

import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'fs';
import { dirname } from 'path';
import { createInterface } from 'readline';
import type { Config } from '../config/loader.js';
import type { GhostEntry } from './harness.js';

export interface GhostDailyScore {
  date: string;                  // YYYY-MM-DD
  samples: number;
  match_rate: number;            // 0..1, fraction where match=true
  median_latency_ms: number;     // ThunderGate latency
  median_openclaw_chars: number;
  median_thundergate_chars: number;
  error_rate: number;            // 0..1, fraction with [ghost error] markers
  status: 'green' | 'yellow' | 'red';
}

export interface GhostScoreFile {
  updated_at: number;
  days: GhostDailyScore[];        // newest first
  consecutive_clean_days: number; // green days in a row, ending today
}

export class GhostEvaluator {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Stream ghost-log.jsonl and bucket entries by local date.
   */
  async readEntries(): Promise<GhostEntry[]> {
    const path = this.config.ghost.log_file;
    if (!existsSync(path)) return [];
    const out: GhostEntry[] = [];
    const stream = createReadStream(path);
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as GhostEntry);
      } catch {
        /* skip malformed line — log can co-exist with truncations */
      }
    }
    return out;
  }

  /**
   * Compute a per-day score. Status thresholds:
   *   green  — match_rate ≥ 0.7, error_rate < 0.05, samples ≥ 5
   *   yellow — match_rate ≥ 0.5, error_rate < 0.15
   *   red    — anything worse, or fewer than 5 samples (insufficient data)
   *
   * Doctor reports "red" honestly when there isn't enough data; we don't
   * pretend low-sample days look green just to keep the streak.
   */
  async computeScores(): Promise<GhostScoreFile> {
    const entries = await this.readEntries();
    const byDay = new Map<string, GhostEntry[]>();
    for (const e of entries) {
      const d = isoDate(e.timestamp);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d)!.push(e);
    }

    const days: GhostDailyScore[] = [...byDay.entries()]
      .map(([date, list]) => scoreDay(date, list))
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    const consecutive_clean_days = streakOfGreen(days);

    const file: GhostScoreFile = {
      updated_at: Date.now(),
      days,
      consecutive_clean_days
    };

    this.writeScores(file);
    return file;
  }

  /**
   * Read the most recent scores file from disk without recomputing.
   * Doctor uses this so it never blocks on log-streaming.
   */
  loadScores(): GhostScoreFile | null {
    const path = this.config.ghost.scores_file;
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as GhostScoreFile;
    } catch {
      return null;
    }
  }

  private writeScores(file: GhostScoreFile): void {
    const path = this.config.ghost.scores_file;
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(file, null, 2));
  }
}

// ── Scoring ────────────────────────────────────────────────────────────────

function scoreDay(date: string, list: GhostEntry[]): GhostDailyScore {
  const samples = list.length;
  const matched = list.filter((e) => e.match).length;
  const errors = list.filter((e) => /\[ghost.*error/i.test(e.thundergate_response)).length;
  const lat = list.map((e) => e.latency_ms).filter((n) => n >= 0);

  const ocChars = list
    .map((e) => (e.openclaw_response ?? '').length)
    .filter((n) => n > 0);
  const tgChars = list.map((e) => (e.thundergate_response ?? '').length).filter((n) => n > 0);

  const match_rate = samples > 0 ? matched / samples : 0;
  const error_rate = samples > 0 ? errors / samples : 0;

  let status: GhostDailyScore['status'] = 'red';
  if (samples >= 5 && match_rate >= 0.7 && error_rate < 0.05) status = 'green';
  else if (samples >= 5 && match_rate >= 0.5 && error_rate < 0.15) status = 'yellow';

  return {
    date,
    samples,
    match_rate: round(match_rate, 3),
    median_latency_ms: median(lat),
    median_openclaw_chars: median(ocChars),
    median_thundergate_chars: median(tgChars),
    error_rate: round(error_rate, 3),
    status
  };
}

function streakOfGreen(days: GhostDailyScore[]): number {
  // days is newest-first; count greens until first non-green or gap.
  let streak = 0;
  let cursor = todayIso();
  for (const day of days) {
    if (day.date !== cursor) {
      // Gap in coverage — treat as broken streak. Truth over optimism.
      break;
    }
    if (day.status !== 'green') break;
    streak++;
    cursor = previousIso(cursor);
  }
  return streak;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function isoDate(ts: number): string {
  const d = new Date(ts);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  ].join('-');
}

function todayIso(): string {
  return isoDate(Date.now());
}

function previousIso(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(y, m - 1, d);
  t.setDate(t.getDate() - 1);
  return isoDate(t.getTime());
}
