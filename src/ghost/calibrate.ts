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
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { Config } from '../config/loader.js';
import {
  compareResponses,
  voyageEmbedder,
  type EmbeddingFn,
  type MatchResult
} from './compare.js';
import { getGhostSystemPrompt } from './context.js';
import type { GhostEntry, GhostTurn } from './harness.js';

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

  constructor(config: Config) {
    this.config = config;
    if (config.voyageApiKey && config.voyageApiKey.length > 0) {
      this.embed = voyageEmbedder(config.voyageApiKey);
    }
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

      let pair: CalibrationPair;
      try {
        pair = this.generatePair(cat);
      } catch (err) {
        console.warn(`  ⚠ Round ${i} (${cat}): pair generation failed — ${(err as Error).message}`);
        continue;
      }

      const historyForCall = this.history.slice();
      const started = Date.now();
      let ghostResponse = '';
      try {
        ghostResponse = await this.callGhost(pair.prompt, historyForCall);
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
  private generatePair(category: string): CalibrationPair {
    const prompt = PAIR_PROMPT_TEMPLATE.replace('[CATEGORY]', category);
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
  private async callGhost(input: string, history: GhostTurn[]): Promise<string> {
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

    const body = {
      model: anthropicModel,
      max_tokens: this.config.ghost.maxTokens,
      temperature: this.config.ghost.temperature,
      system: [
        {
          type: 'text',
          text: system,
          cache_control: { type: 'ephemeral' }
        }
      ],
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
