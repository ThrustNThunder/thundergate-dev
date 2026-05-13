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
  statSync,
  writeFileSync
} from 'fs';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import type { Config } from '../config/loader.js';
import type { GhostEntry } from './harness.js';

export interface GhostDailyScore {
  date: string;                  // YYYY-MM-DD
  samples: number;
  /**
   * Legacy binary match rate (fraction of pairs where `match === true`).
   * Kept for historical display continuity — the gate logic is now
   * driven by `weighted_score` below.
   */
  match_rate: number;
  /**
   * Length-weighted mean of per-pair tiered scores. Short acks contribute
   * little; substantive responses dominate. This is what doctor reads.
   *
   *   weight_i = log2(1 + max(openclaw_chars_i, thundergate_chars_i))
   *   weighted_score = Σ(weight_i * score_i) / Σ(weight_i)
   */
  weighted_score: number;
  median_latency_ms: number;     // ThunderGate latency
  median_openclaw_chars: number;
  median_thundergate_chars: number;
  error_rate: number;            // 0..1, fraction with [ghost error] markers
  /**
   * Doctor-green check 4: fraction of the day's entries whose
   * thundergate_response is literally `[ghost: not yet ready]`. High
   * rates mean the harness is logging pairs before Haiku has had time
   * to reply — that's a pairing-timing bug, not a quality regression.
   */
  not_yet_ready_rate: number;
  status: 'green' | 'yellow' | 'red';
}

export interface LearnTestSummary {
  /**
   * gatePass = T1 + T2 + T3 all green (T6 currently not part of the
   * Doctor-green check; see task5 build notes for the rationale).
   * `null` = never run, or the cached result is older than 25h.
   */
  gate_pass: boolean | null;
  last_run_at: number | null;
  stale: boolean;
  results?: Array<{ name: string; pass: boolean; skipped?: boolean }>;
}

export interface DoctorCheckResult {
  id: number;          // 1..9
  name: string;
  pass: boolean;
  value: string;       // human-readable observed value
  threshold: string;   // human-readable threshold the value is compared to
  reason?: string;     // populated on fail to point at the specific cause
}

export interface GhostScoreFile {
  updated_at: number;
  days: GhostDailyScore[];        // newest first
  consecutive_clean_days: number; // green days in a row, ending today
  /**
   * Reference timestamp for "since last deploy" checks (5 and 6). Resolved
   * from the mtime of `~/.thundergate/last-deploy` if present; otherwise
   * 0, which makes every error count — fail-closed is the desired default.
   */
  deploy_timestamp: number;
  /** Doctor-green check 5. */
  fk_errors_since_deploy: number;
  /** Doctor-green check 6. */
  jsonl_parse_failures_since_deploy: number;
  /** Doctor-green check 7 (cached; re-run nightly). */
  learn_test: LearnTestSummary;
  /** Doctor-green check 8: harness uptime over the previous 24h, in hours. */
  harness_uptime_hours_24h: number;
  /** Per-check breakdown for `ghost status` and audit. */
  doctor_checks: DoctorCheckResult[];
  /** AND of all 9 checks. */
  doctor_green: boolean;
}

const LEARN_TEST_FRESH_WINDOW_MS = 25 * 60 * 60 * 1000; // 25h — nightly + slack
const UPTIME_WINDOW_MS = 24 * 60 * 60 * 1000;
const NOT_YET_READY_MARKER = '[ghost: not yet ready]';
// FK error markers in either:
//   - thundergate_response  → `[ghost error: ... FOREIGN KEY ...]` per
//     harness.ts:289 error wrapper.
//   - openclaw_response     → defensive, in case the upstream pipeline
//     ever surfaces FK violations there.
const FK_ERROR_PATTERN = /foreign key/i;

export class GhostEvaluator {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Stream ghost-log.jsonl and bucket entries by local date.
   *
   * Parse failures used to be silently swallowed. Doctor-green check 6
   * needs the count, so we now return it alongside the entries.
   */
  async readEntries(): Promise<{ entries: GhostEntry[]; parseFailures: number }> {
    const path = this.config.ghost.log_file;
    if (!existsSync(path)) return { entries: [], parseFailures: 0 };
    const out: GhostEntry[] = [];
    let parseFailures = 0;
    const stream = createReadStream(path);
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as GhostEntry);
      } catch {
        parseFailures += 1;
      }
    }
    return { entries: out, parseFailures };
  }

  /**
   * Compute a per-day score. Status thresholds (driven by the new
   * length-weighted score, not the legacy binary match rate):
   *   green  — weighted_score ≥ 0.45, error_rate < 0.05, samples ≥ 10
   *   yellow — weighted_score ≥ 0.35, error_rate < 0.15, samples ≥ 10
   *   red    — anything worse, or fewer than 10 samples (insufficient data)
   *
   * Why 0.45 (down from 0.75): Ghost Jon is a *runtime* gate — it proves
   * the routing, context delivery, and end-to-end plumbing work. It is
   * not a model-quality gate. Today we run Haiku-backed ThunderGate
   * against Sonnet-backed OpenClaw, so an inherent capability gap caps
   * resemblance well below the 0.75 figure that came from same-model
   * baselining. 0.45 is the minimum-resemblance floor at which a Haiku
   * reply is recognizably on-topic relative to its Sonnet pair.
   *
   * Samples floor raised from 5 → 10: 5 was too noisy to call a day clean.
   * Doctor reports "red" honestly when there isn't enough data; we don't
   * pretend low-sample days look green just to keep the streak.
   */
  async computeScores(): Promise<GhostScoreFile> {
    const { entries, parseFailures } = await this.readEntries();
    const byDay = new Map<string, GhostEntry[]>();
    for (const e of entries) {
      // Pressure-test sessions are synthetic — they have no real OpenClaw
      // reply to compare against, so they always score match=0. Exclude
      // them from daily scoring or they corrupt the 7-day clean clock.
      if (typeof e.session_id === 'string' && e.session_id.startsWith('ghost-test-')) continue;
      const d = isoDate(e.timestamp);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d)!.push(e);
    }

    const days: GhostDailyScore[] = [...byDay.entries()]
      .map(([date, list]) => scoreDay(date, list))
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    const consecutive_clean_days = streakOfGreen(days);

    // ── 9-check Doctor green ───────────────────────────────────────────────
    const prior = this.loadScores();
    const deploy_timestamp = resolveDeployTimestamp();
    const fk_errors_since_deploy = countFkErrorsSince(entries, deploy_timestamp);
    // JSONL parse failures: we can't attach per-failure timestamps because
    // the malformed lines have none. The closest honest answer is "all
    // parse failures observed in the current scan of the live log". If the
    // log was rotated/truncated at deploy time, this equals the post-deploy
    // count; if not, it includes pre-deploy failures too. Pessimistic-leaning
    // is the desired direction here (fail-closed).
    const jsonl_parse_failures_since_deploy = parseFailures;
    const learn_test = freshenLearnTestSummary(prior?.learn_test);
    const harness_uptime_hours_24h = resolveHarnessUptimeHours24h();

    const today = days[0] && days[0].date === todayIso() ? days[0] : null;
    const doctor_checks = buildDoctorChecks({
      today,
      recentDays: days.slice(0, 7),
      fkErrorsSinceDeploy: fk_errors_since_deploy,
      jsonlParseFailuresSinceDeploy: jsonl_parse_failures_since_deploy,
      learnTest: learn_test,
      uptimeHours24h: harness_uptime_hours_24h
    });
    const doctor_green = doctor_checks.every((c) => c.pass);

    const file: GhostScoreFile = {
      updated_at: Date.now(),
      days,
      consecutive_clean_days,
      deploy_timestamp,
      fk_errors_since_deploy,
      jsonl_parse_failures_since_deploy,
      learn_test,
      harness_uptime_hours_24h,
      doctor_checks,
      doctor_green
    };

    this.writeScores(file);
    return file;
  }

  /**
   * Record a learn-test run result into the scores file. Called by the
   * `ghost learn-test` CLI (and intended for the nightly cron) so the
   * 9-check Doctor green has a fresh value for check 7.
   */
  recordLearnTestResult(summary: {
    gatePass: boolean;
    results: Array<{ name: string; pass: boolean; skipped?: boolean }>;
  }): void {
    const prior = this.loadScores();
    const learn_test: LearnTestSummary = {
      gate_pass: summary.gatePass,
      last_run_at: Date.now(),
      stale: false,
      results: summary.results
    };
    const next: GhostScoreFile = prior
      ? { ...prior, learn_test, updated_at: Date.now() }
      : {
          updated_at: Date.now(),
          days: [],
          consecutive_clean_days: 0,
          deploy_timestamp: resolveDeployTimestamp(),
          fk_errors_since_deploy: 0,
          jsonl_parse_failures_since_deploy: 0,
          learn_test,
          harness_uptime_hours_24h: 0,
          doctor_checks: [],
          doctor_green: false
        };
    // Re-derive doctor_checks/doctor_green if we have a `today` entry on
    // hand, so consumers reading the file right after a learn-test run see
    // a consistent doctor_green.
    if (next.days.length > 0 && next.days[0].date === todayIso()) {
      next.doctor_checks = buildDoctorChecks({
        today: next.days[0],
        recentDays: next.days.slice(0, 7),
        fkErrorsSinceDeploy: next.fk_errors_since_deploy,
        jsonlParseFailuresSinceDeploy: next.jsonl_parse_failures_since_deploy,
        learnTest: next.learn_test,
        uptimeHours24h: next.harness_uptime_hours_24h
      });
      next.doctor_green = next.doctor_checks.every((c) => c.pass);
    }
    this.writeScores(next);
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
  const notYetReady = list.filter((e) => e.thundergate_response === NOT_YET_READY_MARKER).length;
  const lat = list.map((e) => e.latency_ms).filter((n) => n >= 0);

  const ocChars = list
    .map((e) => (e.openclaw_response ?? '').length)
    .filter((n) => n > 0);
  const tgChars = list.map((e) => (e.thundergate_response ?? '').length).filter((n) => n > 0);

  const match_rate = samples > 0 ? matched / samples : 0;
  const error_rate = samples > 0 ? errors / samples : 0;
  const not_yet_ready_rate = samples > 0 ? notYetReady / samples : 0;
  const weighted_score = computeWeightedScore(list);

  // Per-day status (legacy 3-check green) feeds the 7-day streak.
  // The fuller 9-check Doctor green lives on `GhostScoreFile`, not here.
  let status: GhostDailyScore['status'] = 'red';
  if (samples >= 10 && weighted_score >= 0.45 && error_rate < 0.05) status = 'green';
  else if (samples >= 10 && weighted_score >= 0.35 && error_rate < 0.15) status = 'yellow';

  return {
    date,
    samples,
    match_rate: round(match_rate, 3),
    weighted_score: round(weighted_score, 3),
    median_latency_ms: median(lat),
    median_openclaw_chars: median(ocChars),
    median_thundergate_chars: median(tgChars),
    error_rate: round(error_rate, 3),
    not_yet_ready_rate: round(not_yet_ready_rate, 3),
    status
  };
}

// ── 9-check Doctor green ────────────────────────────────────────────────────

interface DoctorCheckInputs {
  today: GhostDailyScore | null;
  recentDays: GhostDailyScore[];   // newest-first, used by the trend check
  fkErrorsSinceDeploy: number;
  jsonlParseFailuresSinceDeploy: number;
  learnTest: LearnTestSummary;
  uptimeHours24h: number;
}

function buildDoctorChecks(inputs: DoctorCheckInputs): DoctorCheckResult[] {
  const today = inputs.today;
  const out: DoctorCheckResult[] = [];

  // 1. Weighted day score ≥ 0.45
  //    Ghost Jon is a runtime/routing gate, not a model-output-quality gate.
  //    ThunderGate (Haiku) vs OpenClaw (Sonnet) has an inherent capability
  //    gap; the previous 0.75 figure came from same-model baselining and is
  //    unreachable under the current model pair. 0.45 is the
  //    minimum-resemblance floor we treat as "the runtime is delivering
  //    context correctly and Haiku is responding on-topic." Re-baseline if
  //    the model pair changes.
  out.push({
    id: 1,
    name: 'weighted_score ≥ 0.45',
    pass: today != null && today.weighted_score >= 0.45,
    value: today ? today.weighted_score.toFixed(3) : 'n/a',
    threshold: '≥ 0.45',
    reason: today == null ? 'no entries for today' : undefined
  });

  // 2. Error rate < 0.05
  out.push({
    id: 2,
    name: 'error_rate < 0.05',
    pass: today != null && today.error_rate < 0.05,
    value: today ? today.error_rate.toFixed(3) : 'n/a',
    threshold: '< 0.05',
    reason: today == null ? 'no entries for today' : undefined
  });

  // 3. Samples ≥ 10
  out.push({
    id: 3,
    name: 'samples ≥ 10',
    pass: today != null && today.samples >= 10,
    value: today ? String(today.samples) : '0',
    threshold: '≥ 10',
    reason: today == null ? 'no entries for today' : undefined
  });

  // 4. [ghost: not yet ready] rate < 0.02
  out.push({
    id: 4,
    name: 'not_yet_ready_rate < 0.02',
    pass: today != null && today.not_yet_ready_rate < 0.02,
    value: today ? today.not_yet_ready_rate.toFixed(3) : 'n/a',
    threshold: '< 0.02',
    reason: today == null ? 'no entries for today' : undefined
  });

  // 5. Zero FK errors newer than last deploy
  out.push({
    id: 5,
    name: 'fk_errors_since_deploy == 0',
    pass: inputs.fkErrorsSinceDeploy === 0,
    value: String(inputs.fkErrorsSinceDeploy),
    threshold: '== 0',
    reason: inputs.fkErrorsSinceDeploy > 0
      ? 'FOREIGN KEY constraint failures present after last deploy — DB schema regression'
      : undefined
  });

  // 6. Zero JSONL parse failures newer than last deploy
  out.push({
    id: 6,
    name: 'jsonl_parse_failures_since_deploy == 0',
    pass: inputs.jsonlParseFailuresSinceDeploy === 0,
    value: String(inputs.jsonlParseFailuresSinceDeploy),
    threshold: '== 0',
    reason: inputs.jsonlParseFailuresSinceDeploy > 0
      ? 'malformed lines in ghost-log.jsonl — writer-side corruption or partial flush'
      : undefined
  });

  // 7. Learning-loop tests T1+T2+T3 passing on deployed build (re-run nightly)
  out.push({
    id: 7,
    name: 'learn_test gate (T1+T2+T3)',
    pass: inputs.learnTest.gate_pass === true && !inputs.learnTest.stale,
    value: formatLearnTestValue(inputs.learnTest),
    threshold: 'pass within last 25h',
    reason:
      inputs.learnTest.gate_pass === null
        ? 'no learn-test run recorded — run `thundergate ghost learn-test`'
        : inputs.learnTest.stale
          ? 'cached learn-test result older than 25h — re-run nightly'
          : inputs.learnTest.gate_pass === false
            ? 'one or more of T1/T2/T3 failed on the deployed build'
            : undefined
  });

  // 8. Harness uptime ≥ 23h of previous 24
  out.push({
    id: 8,
    name: 'harness_uptime ≥ 23h / 24h',
    pass: inputs.uptimeHours24h >= 23,
    value: `${inputs.uptimeHours24h.toFixed(2)}h`,
    threshold: '≥ 23h',
    reason:
      inputs.uptimeHours24h < 23
        ? 'harness restart or downtime within the last 24h'
        : undefined
  });

  // 9. Learning trend: latest day's weighted_score ≥ oldest day in the
  //    7-day window. We don't ask the score to be high here — that's
  //    check 1's job. We ask that the learning loop isn't *regressing*:
  //    today should be at least as good as 7 days ago. Skipped (passes)
  //    until we have 7 distinct days of data — there's nothing to trend
  //    against before then.
  const recent = inputs.recentDays;
  if (recent.length < 7) {
    out.push({
      id: 9,
      name: 'learning_trend',
      pass: true,
      value: `skipped (${recent.length} day${recent.length === 1 ? '' : 's'} of data)`,
      threshold: 'day7 ≥ day1 (≥ 7 days required)',
      reason: 'not enough history yet — re-check once 7 days of entries exist'
    });
  } else {
    const day7 = recent[0];          // newest-first
    const day1 = recent[6];
    const delta = day7.weighted_score - day1.weighted_score;
    const trendPass = day7.weighted_score >= day1.weighted_score;
    out.push({
      id: 9,
      name: 'learning_trend',
      pass: trendPass,
      value:
        `day1=${day1.weighted_score.toFixed(3)} → day7=${day7.weighted_score.toFixed(3)} ` +
        `(${delta >= 0 ? '+' : ''}${delta.toFixed(3)})`,
      threshold: 'day7 ≥ day1',
      reason: trendPass
        ? undefined
        : 'weighted_score is lower than 7 days ago — learning loop is regressing'
    });
  }

  return out;
}

function formatLearnTestValue(lt: LearnTestSummary): string {
  if (lt.gate_pass === null) return 'never run';
  const ts = lt.last_run_at ? new Date(lt.last_run_at).toISOString() : '?';
  const stale = lt.stale ? ' (stale)' : '';
  return `${lt.gate_pass ? 'PASS' : 'FAIL'} @ ${ts}${stale}`;
}

function countFkErrorsSince(entries: GhostEntry[], deployTs: number): number {
  let n = 0;
  for (const e of entries) {
    if (e.timestamp < deployTs) continue;
    if (FK_ERROR_PATTERN.test(e.thundergate_response)) {
      n += 1;
      continue;
    }
    if (typeof e.openclaw_response === 'string' && FK_ERROR_PATTERN.test(e.openclaw_response)) {
      n += 1;
    }
  }
  return n;
}

function resolveDeployTimestamp(): number {
  // Convention: touching `~/.thundergate/last-deploy` records a deploy.
  // Doctor checks 5 and 6 only count errors with timestamp >= this value.
  // Falling back to 0 deliberately counts every historical error — the
  // safer default for a never-stamped install.
  const home = process.env.HOME ?? '';
  const marker = join(home, '.thundergate', 'last-deploy');
  if (!existsSync(marker)) return 0;
  try {
    return statSync(marker).mtimeMs;
  } catch {
    return 0;
  }
}

function resolveHarnessUptimeHours24h(): number {
  // Ghost harness is owned by the ThunderGate runtime process. When the
  // runtime starts, it writes `~/.thundergate/state.json` with `startedAt`.
  // Use that as a proxy for harness start. If the runtime is currently
  // running and started < 24h ago, uptime = (now - startedAt); if started
  // ≥ 24h ago, uptime = 24h. A recent restart correctly drops uptime.
  //
  // This is a floor: it under-reports uptime across crash-restart cycles
  // within the same 24h window (treats only the most recent run as up).
  // The conservative direction is correct — false reds beat false greens.
  const home = process.env.HOME ?? '';
  const statePath = join(home, '.thundergate', 'state.json');
  if (!existsSync(statePath)) return 0;
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as { startedAt?: number };
    if (!state.startedAt || state.startedAt <= 0) return 0;
    const upMs = Math.max(0, Date.now() - state.startedAt);
    return Math.min(UPTIME_WINDOW_MS, upMs) / (60 * 60 * 1000);
  } catch {
    return 0;
  }
}

function freshenLearnTestSummary(prior: LearnTestSummary | undefined): LearnTestSummary {
  if (!prior || !prior.last_run_at) {
    return { gate_pass: null, last_run_at: null, stale: true };
  }
  const age = Date.now() - prior.last_run_at;
  const stale = age > LEARN_TEST_FRESH_WINDOW_MS;
  return { ...prior, stale };
}

/**
 * Length-weighted mean of per-pair scores.
 *
 *   weight_i = log2(1 + max(openclaw_chars_i, thundergate_chars_i))
 *   weighted_score = Σ(weight_i * score_i) / Σ(weight_i)
 *
 * Older log entries pre-date `score`; for those we fall back to the
 * binary `match` value (1 if matched, 0 otherwise). That keeps history
 * loadable without retroactively rewriting the JSONL.
 */
function computeWeightedScore(list: GhostEntry[]): number {
  let num = 0;
  let den = 0;
  for (const e of list) {
    const oc = (e.openclaw_response ?? '').length;
    const tg = (e.thundergate_response ?? '').length;
    const maxLen = Math.max(oc, tg);
    if (maxLen === 0) continue;
    const w = Math.log2(1 + maxLen);
    const s = typeof e.score === 'number' ? e.score : (e.match ? 1 : 0);
    num += w * s;
    den += w;
  }
  return den > 0 ? num / den : 0;
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
