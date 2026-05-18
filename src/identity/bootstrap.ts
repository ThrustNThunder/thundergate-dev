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

const LEGACY_JON_WORKSPACE = '/home/ubuntu/.openclaw/workspace';
const AGENTS_BASE = '/home/ubuntu/.openclaw/agents';
const MEMORY_HEAD_LINES = 150;

/**
 * Resolve the identity-files root for an agent.
 *
 * For agentId='jon', the historical `~/.openclaw/workspace/` location wins
 * when present — that's where Jon's SOUL/USER/MEMORY have always lived, and
 * the existing Jon instance must continue working byte-identically. For any
 * other agent (Mack, Rex, …), files live under `~/.openclaw/agents/<id>/`.
 *
 * Falls back to the per-agent path if the legacy workspace files are missing,
 * so a future migration that moves Jon's files into `~/.openclaw/agents/jon/`
 * works without code changes.
 */
function identityRoot(agentId: string): string {
  if (agentId === 'jon') {
    const legacySoul = join(LEGACY_JON_WORKSPACE, 'SOUL.md');
    if (existsSync(legacySoul)) return LEGACY_JON_WORKSPACE;
  }
  return join(AGENTS_BASE, agentId);
}

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
export function loadIdentity(now: Date = new Date(), agentId: string = 'jon'): IdentityLoadResult {
  const root = identityRoot(agentId);
  const sources: Array<{ name: string; path: string; transform?: (raw: string) => string }> = [
    { name: 'SOUL', path: join(root, 'SOUL.md') },
    { name: 'USER', path: join(root, 'USER.md') },
    {
      name: 'MEMORY',
      path: join(root, 'MEMORY.md'),
      transform: (raw) => raw.split('\n').slice(0, MEMORY_HEAD_LINES).join('\n')
    },
    {
      name: 'TODAY',
      path: join(root, 'memory', `${todayStamp(now)}.md`)
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

  const header = identityHeader(now, agentId);
  const toolsBlock = toolCapabilitiesBlock();
  const systemPrompt = sections.length > 0
    ? [header, ...sections, toolsBlock].join('\n\n')
    : [header, toolsBlock].join('\n\n'); // Even with all files missing we still ship the framing header.

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
function identityHeader(now: Date, agentId: string): string {
  const isoDate = now.toISOString().slice(0, 10);
  if (agentId === 'jon') {
    return [
      'You are Jon — Michael Lovell\'s AI partner inside ThunderBase.',
      '',
      'You are not "Claude" generically. You are the same Jon that runs on Slack, ThunderCommo, and the OpenClaw gateway — the surfaces all share one runtime, one session model, and one identity (ThunderGate Design Principle 31). Whichever surface this message arrived from, respond as Jon — not as a generic assistant.',
      '',
      `Today is ${isoDate}. The files below define who you are, who Michael is, and what's been going on. Read them and act accordingly.`
    ].join('\n');
  }
  const display = agentId.charAt(0).toUpperCase() + agentId.slice(1);
  return [
    `You are ${display}. The files below define who you are and what's been going on.`,
    '',
    `Today is ${isoDate}. Read the SOUL/USER/MEMORY files below and act accordingly.`
  ].join('\n');
}

function formatSection(name: string, path: string, body: string): string {
  return `# ${name} — ${path}\n\n${body.trim()}`;
}

/**
 * Tool-tag instructions for the TUI surface. The TUI scans assistant messages
 * for these self-closing tags, executes the matching `thundergate browser ...`
 * subcommand, and feeds the result back into the conversation as the next
 * user turn prefixed with `[Browser result: ...]`. Anything outside that
 * exact tag syntax is treated as plain text.
 */
function toolCapabilitiesBlock(): string {
  return [
    '# TOOLS — ThunderBrowser',
    '',
    'You have access to ThunderBrowser. When you need to look something up, check a page, or verify information, use these tool tags in your response:',
    '- <tool:browser_navigate url="https://example.com"/>',
    '- <tool:browser_read/>',
    '- <tool:browser_extract selector="h1"/>',
    '- <tool:browser_eval expression="document.title"/>',
    '- <tool:browser_state/>',
    '',
    'The TUI will execute these and return results to you as the next turn, prefixed with `[Browser result: ...]`. You can then use the results in your follow-up response.',
    '',
    'IMPORTANT: Never access /home/ubuntu/.openclaw/ files. Never modify OpenClaw configuration.'
  ].join('\n');
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
