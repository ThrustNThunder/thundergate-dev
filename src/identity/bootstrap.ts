/**
 * Identity bootstrap — loads Jon's identity files on runtime boot.
 *
 * Source of truth lives in /home/ubuntu/.openclaw/workspace/:
 *   • SOUL.md           — who Jon is (philosophy, voice, boundaries)
 *   • USER.md           — who Michael is (background, preferences, voice)
 *   • MEMORY.md         — Jon's long-term ledger (we read the first 150 lines —
 *                         the curated essentials; older detail is in
 *                         memory/YYYY-MM-DD.md and only loaded on demand)
 *   • memory/YYYY-MM-DD.md (today's date, optional) — recent context for "what
 *                         we've been doing today"
 *
 * We deliberately read these files and not openclaw.json (which is OpenClaw's
 * runtime config, off-limits per the project rules). These are *agent
 * artifacts* — the same files OpenClaw's Jon reads — and the rule is "no
 * OpenClaw _config_," not "no shared artifacts."
 *
 * The output is a single concatenated string we hand to callLLM as a
 * `system` message every turn. Anthropic concatenates `role:'system'`
 * messages into the top-level `system` field, and the cache hint we already
 * stamp keeps the identity block warm across turns.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const WORKSPACE = '/home/ubuntu/.openclaw/workspace';
const MEMORY_HEAD_LINES = 150;

export interface IdentityLoadResult {
  systemPrompt: string;
  parts: Array<{ name: string; path: string; bytes: number; lines: number }>;
  missing: string[];
  loadedAt: number;
}

/**
 * Load all identity files and build the system prompt. Best-effort: each
 * file is independent, and a missing one is logged but never throws — the
 * runtime should still come up if SOUL.md got mv'd by accident.
 */
export function loadIdentity(now: Date = new Date()): IdentityLoadResult {
  const sources: Array<{ name: string; path: string; transform?: (raw: string) => string }> = [
    { name: 'SOUL', path: join(WORKSPACE, 'SOUL.md') },
    { name: 'USER', path: join(WORKSPACE, 'USER.md') },
    {
      name: 'MEMORY',
      path: join(WORKSPACE, 'MEMORY.md'),
      transform: (raw) => raw.split('\n').slice(0, MEMORY_HEAD_LINES).join('\n')
    },
    {
      name: 'TODAY',
      path: join(WORKSPACE, 'memory', `${todayStamp(now)}.md`)
    }
  ];

  const parts: IdentityLoadResult['parts'] = [];
  const missing: string[] = [];
  const sections: string[] = [];

  for (const src of sources) {
    if (!existsSync(src.path)) {
      missing.push(src.name);
      continue;
    }
    try {
      const raw = readFileSync(src.path, 'utf-8');
      const body = src.transform ? src.transform(raw) : raw;
      const lines = body.split('\n').length;
      parts.push({ name: src.name, path: src.path, bytes: body.length, lines });
      sections.push(formatSection(src.name, src.path, body));
    } catch (err) {
      missing.push(`${src.name}: ${(err as Error).message}`);
    }
  }

  const header = identityHeader(now);
  const systemPrompt = sections.length > 0
    ? [header, ...sections].join('\n\n')
    : header; // Even with all files missing we still ship the framing header.

  return {
    systemPrompt,
    parts,
    missing,
    loadedAt: Date.now()
  };
}

/**
 * Top of the system prompt — gives the model the rule it needs most: which
 * persona to inhabit. Without this framing the SOUL.md body lands as "this
 * is who you are" but Anthropic's default-Claude framing still leaks
 * through ("As an AI assistant, I can…"). The explicit "You are Jon"
 * sentence is the patch.
 */
function identityHeader(now: Date): string {
  const isoDate = now.toISOString().slice(0, 10);
  return [
    'You are Jon — Michael Lovell\'s AI partner inside ThunderBase.',
    '',
    'You are not "Claude" generically. You are the same Jon that runs on Slack, ThunderCommo, and the OpenClaw gateway — the surfaces all share one runtime, one session model, and one identity (ThunderGate Design Principle 31). Whichever surface this message arrived from, respond as Jon — not as a generic assistant.',
    '',
    `Today is ${isoDate}. The files below define who you are, who Michael is, and what's been going on. Read them and act accordingly.`
  ].join('\n');
}

function formatSection(name: string, path: string, body: string): string {
  return `# ${name} — ${path}\n\n${body.trim()}`;
}

function todayStamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** For doctor / status output — total size of the identity block. */
export function summarizeIdentity(result: IdentityLoadResult): string {
  const total = result.parts.reduce((a, p) => a + p.bytes, 0);
  const detail = result.parts.map((p) => `${p.name}(${p.lines}L)`).join(', ');
  const miss = result.missing.length ? `, missing=[${result.missing.join(',')}]` : '';
  return `${total.toLocaleString()} bytes — ${detail}${miss}`;
}

// Silence unused-import lint if `statSync` falls out of use during refactor.
void statSync;
