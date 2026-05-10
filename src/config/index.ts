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
    openclaw_session:
      '/home/ubuntu/.openclaw/agents/main/sessions/agent:main:main.jsonl',
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
    if (!cfg.ghost.openclaw_session) {
      problems.push('ghost.openclaw_session missing');
    }
    if (!cfg.ghost.log_file) problems.push('ghost.log_file missing');
  }

  return problems;
}
