/**
 * Ghost Jon — standalone calibration harness
 *
 * Free training loop for Ghost Jon. CLI Jon (flat-rate Claude Code) is
 * asked to invent a realistic (Michael-prompt, ideal-Jon-response) pair.
 * The prompt is then fed to the Ghost Jon predictor (Haiku) as if it
 * were a live session turn, and the ideal response from CLI Jon is used
 * as the answer key for scoring. Real Jon (Sonnet) is never touched.
 *
 * Each round writes one entry to `ghost-log.jsonl` exactly like a real
 * shadow turn, so evaluator/Doctor see the calibration in the daily
 * scoreboard. Doctor must keep telling the truth — calibration rows
 * count toward the same metric, by design.
 *
 * The calibrator bypasses the OpenClaw gateway entirely. It calls the
 * Ghost predictor logic directly (mirrored from runtime.callGhostLLM)
 * so it works without ThunderGate running.
 */

import { execSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import type { Config } from '../config/loader.js';
import {
  compareResponses,
  voyageEmbedder,
  type EmbeddingFn,
  type MatchResult
} from './compare.js';
import { getGhostSystemPrompt } from './context.js';
import { GhostEvaluator } from './evaluator.js';
import {
  buildStateSnapshot,
  isStatusQuery,
  type GhostEntry,
  type GhostTurn,
  type StateSnapshotSource
} from './harness.js';

export type CalibrateCategory =
  | 'all'
  | 'slack'
  | 'cli'
  | 'status'
  | 'technical'
  | 'personal';

const ROTATING_CATEGORIES = ['slack', 'cli', 'status', 'technical', 'personal'] as const;

export interface CalibrationPair {
  prompt: string;
  response: string;
  category: string;
}

export interface CalibrationRoundResult {
  round: number;
  category: string;
  prompt: string;
  ideal_response: string;
  ghost_response: string;
  score: number;
  tier: MatchResult['tier'];
  embedding_status: MatchResult['embedding_skipped'];
  latency_ms: number;
}

export interface CalibrationSummary {
  rounds: number;
  avg_score: number;
  tier_breakdown: { tier1: number; tier2: number; tier3: number };
  voyage_hit_rate: number;
  results: CalibrationRoundResult[];
}

const CLAUDE_BIN = '/home/ubuntu/.npm-global/bin/claude';

const PAIR_PROMPT_TEMPLATE =
  'Generate ONE realistic ThunderGate calibration pair as JSON: ' +
  '{"prompt": "...", "response": "..."}. The prompt is something Michael ' +
  'would send Jon on Slack or ThunderCommo. The response is exactly what ' +
  'Jon would say — direct, no filler, Jon voice. Category: [CATEGORY]. ' +
  'Keep response under 200 chars for slack/status/personal, up to 400 for ' +
  'cli/technical. Return ONLY the JSON object, nothing else.';

/**
 * Extra instruction we splice into the pair-generation prompt for the
 * `status` category. Without this, CLI Jon invents numbers for the
 * ideal response while Ghost — now armed with real numbers — reports
 * the actual state, and the two never tier-1 match. Pinning both sides
 * to the same snapshot is what unlocks the exact-match score.
 */
const STATUS_GROUNDING_PREAMBLE =
  "The prompt MUST be a 'how's it going / status / health' style ask. " +
  "The response MUST quote the exact numbers from the snapshot below, " +
  'in Jon voice. Do not invent figures.';

/**
 * Max prior synthetic turns we feed Ghost on each round. 10 entries =
 * 5 user/assistant pairs — matches the "last 3-5 turns" framing in the
 * brief. Synthetic history is incoherent (independent pairs glued
 * together), but the goal is to put Ghost in a session-shaped state, not
 * to test multi-turn reasoning.
 */
const MAX_SYNTHETIC_HISTORY = 10;

export class GhostCalibrator {
  private config: Config;
  private embed: EmbeddingFn | undefined;
  private history: GhostTurn[] = [];
  /**
   * Process start for the calibration run. The cron fires a fresh
   * `node ... ghost calibrate` each time, so this is the *calibration
   * process* uptime, not the long-lived `thundergate` service.
   * Reported under the `calibrator` service-uptime line so operators
   * can tell the two apart.
   */
  private startedAt = Date.now();
  private snapshotSource: StateSnapshotSource;

  constructor(config: Config) {
    this.config = config;
    if (config.voyageApiKey && config.voyageApiKey.length > 0) {
      this.embed = voyageEmbedder(config.voyageApiKey);
    }
    this.snapshotSource = this.buildSnapshotSource();
  }

  async run(rounds: number, category: CalibrateCategory): Promise<CalibrationSummary> {
    this.ensureLogDir();

    const results: CalibrationRoundResult[] = [];
    let totalScore = 0;
    let t1 = 0;
    let t2 = 0;
    let t3 = 0;
    let voyageUsed = 0;
    let voyageEligible = 0;

    for (let i = 1; i <= rounds; i++) {
      const cat =
        category === 'all'
          ? ROTATING_CATEGORIES[(i - 1) % ROTATING_CATEGORIES.length]
          : category;

      // Status rounds get a live snapshot threaded into BOTH the pair
      // generator and Ghost's call. Generating the snapshot once per
      // round keeps "ghost is asked the same question Jon was asked
      // about the same state" coherent — Ghost reading newer numbers
      // than CLI Jon would invent a synthetic mismatch.
      const snapshot = cat === 'status' ? buildStateSnapshot(this.snapshotSource) : null;

      let pair: CalibrationPair;
      try {
        pair = this.generatePair(cat, snapshot);
      } catch (err) {
        console.warn(`  ⚠ Round ${i} (${cat}): pair generation failed — ${(err as Error).message}`);
        continue;
      }

      const historyForCall = this.history.slice();
      const started = Date.now();
      let ghostResponse = '';
      try {
        // Inject when (a) explicitly a status round and we built a
        // snapshot, OR (b) CLI Jon produced a prompt the detector flags
        // status-y under any category (covers the "tell me how things
        // are going" prompt that lands under 'personal').
        const useSnapshot =
          snapshot ?? (isStatusQuery(pair.prompt) ? buildStateSnapshot(this.snapshotSource) : null);
        ghostResponse = await this.callGhost(pair.prompt, historyForCall, useSnapshot ?? undefined);
      } catch (err) {
        ghostResponse = `[ghost error: ${(err as Error).message}]`;
      }
      const latency_ms = Date.now() - started;

      const cmp = await compareResponses(pair.response, ghostResponse, this.embed);

      const entry: GhostEntry = {
        timestamp: Date.now(),
        session_id: 'ghost-calibrate',
        input: pair.prompt,
        openclaw_response: pair.response,
        thundergate_response: ghostResponse || '[ghost: not yet ready]',
        match: cmp.match,
        score: cmp.score,
        match_tier: cmp.tier,
        embedding_status: cmp.embedding_skipped,
        latency_ms
      };
      appendFileSync(this.config.ghost.log_file, JSON.stringify(entry) + '\n');

      results.push({
        round: i,
        category: pair.category,
        prompt: pair.prompt,
        ideal_response: pair.response,
        ghost_response: ghostResponse,
        score: cmp.score,
        tier: cmp.tier,
        embedding_status: cmp.embedding_skipped,
        latency_ms
      });

      totalScore += cmp.score;
      if (cmp.tier === 1) t1++;
      else if (cmp.tier === 2) t2++;
      else if (cmp.tier === 3) t3++;
      if (cmp.embedding_skipped === 'used' || cmp.embedding_skipped === 'cached') {
        voyageUsed++;
      }
      if (cmp.embedding_skipped !== 'not_needed') {
        voyageEligible++;
      }

      // Feed the ideal pair forward — never Ghost's prediction — so the
      // next call sees the conversation Jon would have. Mirrors the real
      // shadow harness's history handling.
      this.history.push({ role: 'user', text: pair.prompt });
      this.history.push({ role: 'assistant', text: pair.response });
      if (this.history.length > MAX_SYNTHETIC_HISTORY) {
        this.history.splice(0, this.history.length - MAX_SYNTHETIC_HISTORY);
      }

      const runningAvg = totalScore / results.length;
      console.log(
        `  [${String(i).padStart(2)}/${rounds}] ${pair.category.padEnd(9)} ` +
        `tier=${cmp.tier} score=${cmp.score.toFixed(2)} ` +
        `avg=${runningAvg.toFixed(3)} lat=${latency_ms}ms ` +
        `emb=${cmp.embedding_skipped}`
      );
    }

    return {
      rounds: results.length,
      avg_score: results.length > 0 ? totalScore / results.length : 0,
      tier_breakdown: { tier1: t1, tier2: t2, tier3: t3 },
      voyage_hit_rate: voyageEligible > 0 ? voyageUsed / voyageEligible : 0,
      results
    };
  }

  /**
   * Spawn CLI Jon non-interactively and ask it for one calibration pair.
   *
   * --print: non-interactive single-shot.
   * --output-format json: known envelope (result field is the text reply).
   * --dangerously-skip-permissions: no interactive permission prompts.
   *
   * `--bare` is intentionally omitted: it disables OAuth/keychain reads
   * and forces ANTHROPIC_API_KEY auth, which the host's CLI Jon doesn't
   * use. Keep CLI Jon on its normal auth path.
   *
   * Sometimes CLI Jon wraps JSON in code fences or adds a preface; the
   * `extractJson` helper digs the object out regardless.
   */
  private generatePair(category: string, stateSnapshot?: string | null): CalibrationPair {
    let prompt = PAIR_PROMPT_TEMPLATE.replace('[CATEGORY]', category);
    // Pin CLI Jon to real numbers on status rounds. The status-grounding
    // preamble + the snapshot are appended *after* the template so the
    // template's "Return ONLY the JSON object" instruction still anchors
    // the end of the prompt.
    if (stateSnapshot) {
      prompt = `${STATUS_GROUNDING_PREAMBLE}\n\n${stateSnapshot}\n\n${prompt}`;
    }
    const out = execSync(
      `${CLAUDE_BIN} --print --output-format json --dangerously-skip-permissions`,
      {
        input: prompt,
        encoding: 'utf-8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 90_000
      }
    );

    let envelope: any;
    try {
      envelope = JSON.parse(out);
    } catch {
      throw new Error('CLI Jon output was not JSON');
    }
    const text = typeof envelope?.result === 'string' ? envelope.result : '';
    if (!text) throw new Error('CLI Jon returned empty result');

    const body = extractJson(text);
    let pair: any;
    try {
      pair = JSON.parse(body);
    } catch {
      throw new Error(`pair body is not JSON: ${body.slice(0, 120)}`);
    }
    if (typeof pair?.prompt !== 'string' || typeof pair?.response !== 'string') {
      throw new Error('pair missing prompt/response strings');
    }
    return { prompt: pair.prompt, response: pair.response, category };
  }

  /**
   * Direct internal call to Ghost Jon's predictor. Mirrors
   * runtime.callGhostLLM — same model, same system prompt, same
   * cache-control discipline — but lives here so the calibrator works
   * without a running gateway. Static system block is marked ephemeral
   * for prompt caching across the calibration run.
   */
  private async callGhost(
    input: string,
    history: GhostTurn[],
    stateSnapshot?: string
  ): Promise<string> {
    const model = this.config.ghost.model;
    const apiKey = this.config.anthropicApiKey;
    if (!apiKey) throw new Error('anthropicApiKey not set');
    if (!(model.startsWith('anthropic/') || model.startsWith('claude-'))) {
      throw new Error(`calibrator only supports Anthropic Ghost models, got: ${model}`);
    }
    const anthropicModel = model.replace(/^anthropic\//, '');
    const system = getGhostSystemPrompt();
    const chat = sanitizeHistory(history);
    chat.push({ role: 'user', content: input });

    // Static system stays cacheable; snapshot rides in a second
    // uncached block so each call sees fresh numbers without
    // invalidating the heavy prefix.
    const systemBlocks: Array<Record<string, unknown>> = [
      {
        type: 'text',
        text: system,
        cache_control: { type: 'ephemeral' }
      }
    ];
    if (stateSnapshot) {
      systemBlocks.push({ type: 'text', text: stateSnapshot });
    }

    const body = {
      model: anthropicModel,
      max_tokens: this.config.ghost.maxTokens,
      temperature: this.config.ghost.temperature,
      system: systemBlocks,
      messages: chat
    };

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      throw new Error(`Ghost LLM ${res.status}: ${await res.text()}`);
    }
    const data: any = await res.json();
    const block = Array.isArray(data.content)
      ? data.content.find((b: any) => b?.type === 'text')
      : null;
    return block?.text ?? '';
  }

  private ensureLogDir(): void {
    const dir = dirname(this.config.ghost.log_file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /**
   * Build a best-effort snapshot source for the calibrator. The
   * calibrator is a one-shot CLI process — it doesn't share state with
   * the long-lived `thundergate` runtime, so we can't read WAL stats /
   * promise counts / live frame directly. We pull what we *can* see
   * from disk (the ghost score file) and from systemctl (service
   * uptime), and leave the rest unpopulated. `buildStateSnapshot`
   * skips lines whose source returned `null`, so the snapshot stays
   * compact instead of advertising "wal=unknown".
   */
  private buildSnapshotSource(): StateSnapshotSource {
    return {
      ghostScore: () => {
        try {
          const evaluator = new GhostEvaluator(this.config);
          const file = evaluator.loadScores();
          if (!file || file.days.length === 0) return null;
          const day = file.days[0];
          return {
            weightedScore: day.weighted_score,
            samples: day.samples,
            matchRate: day.match_rate
          };
        } catch {
          return null;
        }
      },
      serviceUptime: () => {
        const tgUptime = systemctlUptimeMs('thundergate.service');
        const relayUptime = systemctlUptimeMs('thundercomm-relay.service');
        const bridgeUptime = systemctlUptimeMs('openclaw-gateway.service');
        return [
          { name: 'thundergate', uptimeMs: tgUptime },
          { name: 'relay', uptimeMs: relayUptime },
          { name: 'bridge', uptimeMs: bridgeUptime },
          { name: 'calibrator', uptimeMs: Math.max(0, Date.now() - this.startedAt) }
        ];
      },
      now: () => Date.now()
    };
  }
}

/**
 * Best-effort service-uptime probe via `systemctl show -p
 * ActiveEnterTimestampMonotonic`. Returns null on any failure so the
 * snapshot renderer can omit the line cleanly. The monotonic stamp is
 * microseconds since boot; we convert to ms-since-now using
 * /proc/uptime to avoid wall-clock skew.
 */
function systemctlUptimeMs(unit: string): number | null {
  try {
    const raw = execSync(
      `systemctl show -p ActiveEnterTimestampMonotonic --value ${unit} 2>/dev/null || true`,
      { encoding: 'utf-8', timeout: 1500 }
    ).trim();
    const stamp = parseInt(raw, 10);
    if (!Number.isFinite(stamp) || stamp <= 0) return null;
    // /proc/uptime first field is seconds since boot, fractional. The
    // monotonic timestamp is microseconds since boot.
    const procUptime = readFileSyncSafe('/proc/uptime');
    if (!procUptime) return null;
    const bootSecs = parseFloat(procUptime.split(/\s+/)[0]);
    if (!Number.isFinite(bootSecs)) return null;
    const bootMs = bootSecs * 1000;
    const activeMs = stamp / 1000;
    const upMs = bootMs - activeMs;
    return upMs > 0 ? Math.round(upMs) : null;
  } catch {
    return null;
  }
}

function readFileSyncSafe(p: string): string | null {
  try {
    return readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

function sanitizeHistory(
  history: GhostTurn[]
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const cleaned: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const turn of history) {
    const text = (turn.text ?? '').trim();
    if (!text) continue;
    const last = cleaned[cleaned.length - 1];
    if (last && last.role === turn.role) {
      last.content = text;
    } else {
      cleaned.push({ role: turn.role, content: text });
    }
  }
  while (cleaned.length > 0 && cleaned[0].role !== 'user') {
    cleaned.shift();
  }
  return cleaned;
}

/**
 * CLI Jon mostly returns bare JSON, but sometimes wraps it in ```json
 * fences or adds a one-line preface. Strip fences and crop to the first
 * `{` … last `}` so the JSON.parse downstream sees a clean body.
 */
function extractJson(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) return s.slice(first, last + 1);
  return s;
}
