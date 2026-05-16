/**
 * ThunderGate Config — Phase 3 entry point
 *
 * One config. One source of truth. Re-exports the loader plus a helper
 * that materializes a default config.json on first run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import * as os from 'os';
import { Config, loadConfig } from './loader.js';

export { Config, loadConfig } from './loader.js';

const THUNDERGATE_DIR = join(os.homedir(), '.thundergate');
const CONFIG_FILE = join(THUNDERGATE_DIR, 'config.json');

/**
 * Phase 3 config schema, written verbatim on first run.
 * Tokens come from the brief — operators rotate by editing this file.
 */
const PHASE3_DEFAULT = {
  version: '0.1.0',
  runtime: {
    openclaw_session_file:
      '/home/ubuntu/.openclaw/agents/main/sessions/agent:main:main.jsonl',
    context_file: join(THUNDERGATE_DIR, 'context.jsonl'),
    model: 'anthropic/claude-sonnet-4-6'
  },
  channels: {
    thundercommo: {
      enabled: true,
      port: 8765,
      relay_url: 'wss://relay.thunderai.us',
      tokens: {
        michael: '4ca1100a180ad68a94b004056e56fd39c81bdccb742d2926',
        alex: 'alex-thundercommo-4a365924ea69066effbb9ed88fead6c7'
      }
    }
  },
  ghost: {
    enabled: false,
    sessions_dir: '/home/ubuntu/.openclaw/agents/main/sessions/',
    watch_interval_ms: 2000,
    log_file: join(THUNDERGATE_DIR, 'ghost-log.jsonl'),
    scores_file: join(THUNDERGATE_DIR, 'ghost-scores.json'),
    model: 'anthropic/claude-haiku-4-5-20251001',
    maxTokens: 512,
    temperature: 0.3
  }
};

const OPENCLAW_AUTH_FILE = join(
  os.homedir(),
  '.openclaw/agents/main/agent/auth-profiles.json'
);

/**
 * Best-effort: pull the Anthropic API key out of OpenClaw's auth-profiles
 * so ThunderGate can talk to Claude without requiring the operator to
 * also export ANTHROPIC_API_KEY. Silent on failure — caller falls back
 * to env var or empty string.
 */
function readOpenclawAnthropicKey(): string | null {
  try {
    const raw = JSON.parse(readFileSync(OPENCLAW_AUTH_FILE, 'utf-8'));
    const key = raw?.profiles?.['anthropic:default']?.key;
    return typeof key === 'string' && key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

/**
 * Mirror for Voyage. Voyage (Anthropic-owned) uses a separate API key;
 * OpenClaw's auth-profiles store it under `voyage:default` when present.
 * If it isn't, we fall back to the `~/.thundergate/voyage-key` file —
 * an operator-friendly drop-in that avoids editing config.json with a
 * secret and surviving `git status` cleanly.
 */
function readOpenclawVoyageKey(): string | null {
  try {
    const raw = JSON.parse(readFileSync(OPENCLAW_AUTH_FILE, 'utf-8'));
    const key = raw?.profiles?.['voyage:default']?.key;
    if (typeof key === 'string' && key.length > 0) return key;
  } catch {
    /* ignore */
  }
  const dropIn = join(THUNDERGATE_DIR, 'voyage-key');
  try {
    if (existsSync(dropIn)) {
      const txt = readFileSync(dropIn, 'utf-8').trim();
      if (txt.length > 0) return txt;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Write the Phase 3 default config to disk if no config file exists yet.
 * Returns the resolved config either way.
 */
export function ensureConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(PHASE3_DEFAULT, null, 2));
  }
  const cfg = loadConfig(CONFIG_FILE);

  // Phase 4: if no Anthropic key was supplied via env or config.json,
  // borrow the one OpenClaw is already using.
  if (!cfg.anthropicApiKey) {
    const fromOpenclaw = readOpenclawAnthropicKey();
    if (fromOpenclaw) cfg.anthropicApiKey = fromOpenclaw;
  }

  // Same fallback chain for Voyage. Ghost Jon's tier-3 semantic comparator
  // wants this key — when missing, tier-3 silently degrades but Doctor
  // surfaces the absence (see ghost status command).
  if (!cfg.voyageApiKey) {
    const fromOpenclaw = readOpenclawVoyageKey();
    if (fromOpenclaw) cfg.voyageApiKey = fromOpenclaw;
  }

  return cfg;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function readRawConfig(): Record<string, unknown> | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Validate that the loaded config has the bits Phase 3 actually needs.
 * Returns a list of human-readable problems — empty list = valid.
 */
export function validateConfig(cfg: Config): string[] {
  const problems: string[] = [];

  if (!cfg.runtime?.openclaw_session_file) {
    problems.push('runtime.openclaw_session_file missing');
  }
  if (!cfg.runtime?.context_file) {
    problems.push('runtime.context_file missing');
  }

  const tc = cfg.channels?.thundercommo;
  if (tc?.enabled) {
    if (!tc.port) problems.push('channels.thundercommo.port missing');
    if (!tc.tokens || Object.keys(tc.tokens).length === 0) {
      problems.push('channels.thundercommo.tokens empty — no peers can auth');
    }
  }

  if (cfg.ghost?.enabled) {
    if (!cfg.ghost.sessions_dir) {
      problems.push('ghost.sessions_dir missing');
    }
    if (!cfg.ghost.watch_interval_ms || cfg.ghost.watch_interval_ms < 100) {
      problems.push('ghost.watch_interval_ms missing or < 100ms');
    }
    if (!cfg.ghost.log_file) problems.push('ghost.log_file missing');
  }

  if (cfg.context) {
    if (!CONTEXT_TTL_VALUES.includes(cfg.context.sessionTtl)) {
      problems.push(`context.sessionTtl must be one of ${CONTEXT_TTL_VALUES.join(', ')}`);
    }
    if (!CONTEXT_CACHE_VALUES.includes(cfg.context.cacheRetention)) {
      problems.push(`context.cacheRetention must be one of ${CONTEXT_CACHE_VALUES.join(', ')}`);
    }
    if (!CONTEXT_COMPACTION_VALUES.includes(cfg.context.compaction)) {
      problems.push(`context.compaction must be one of ${CONTEXT_COMPACTION_VALUES.join(', ')}`);
    }
    if (typeof cfg.context.maxTokens !== 'number' || cfg.context.maxTokens <= 0) {
      problems.push('context.maxTokens must be a positive number');
    }
    if (cfg.context.maxTokens > 200_000) {
      problems.push('context.maxTokens must not exceed 200000 (Anthropic window)');
    }
  }

  return problems;
}

export const CONTEXT_TTL_VALUES = ['30m', '1h', '2h', '4h', 'unlimited'] as const;
export const CONTEXT_CACHE_VALUES = ['short', 'long', 'extended'] as const;
export const CONTEXT_COMPACTION_VALUES = ['smart', 'aggressive', 'none'] as const;

/**
 * Mutate the on-disk config.json under a single dotted-path key. We read
 * raw (preserving the operator's edits and comments-as-keys), splice the
 * new value in, and write back. The merged-with-defaults Config object
 * is rebuilt on next loadConfig — we deliberately do NOT serialize the
 * full merged Config because it would balloon every operator's config.json
 * with defaults they never asked for.
 */
export function saveConfigField(dottedPath: string, value: unknown): void {
  const raw = readRawConfig() ?? {};
  const parts = dottedPath.split('.');
  let cursor: Record<string, unknown> = raw;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof cursor[k] !== 'object' || cursor[k] === null) {
      cursor[k] = {};
    }
    cursor = cursor[k] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2));
}
