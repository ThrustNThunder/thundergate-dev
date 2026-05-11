/**
 * Ghost Jon — system-prompt context loader
 *
 * Loads the four trimmed Ghost Jon context files from the configured
 * workspace directory, concatenates them with section headers, and
 * returns the assembled string as Ghost Jon's system prompt.
 *
 * Load order is deliberate — GHOST_ADDENDUM first so the shadow-mode
 * rules anchor everything that follows (no real actions, no fabricated
 * tools, respond as Jon would respond). SOUL → USER → IDENTITY then
 * stack the voice and the facts.
 *
 * Files are watched via fs.watchFile (polling — fs.watch is unreliable
 * on Linux for small files). Any mtime/size change triggers a 5-second
 * debounced reload so the next shadow call picks up the new content
 * without restarting the harness. The assembled prompt is cached
 * between reloads so the hot path is a single map lookup.
 *
 * Cache discipline: keep the system block static across calls so
 * Anthropic prompt caching can amortize it. Do not interleave per-call
 * context here.
 */

import { existsSync, readFileSync, statSync, unwatchFile, watchFile } from 'fs';
import { join } from 'path';
import type { SessionDB } from '../session/database.js';

const GHOST_FILES = [
  'GJ_GHOST_ADDENDUM.md', // shadow-role rules — must be first
  'GJ_SOUL.md',
  'GJ_USER.md',
  'GJ_IDENTITY.md'
] as const;

const DEFAULT_GHOST_DIR = '/home/ubuntu/.openclaw/workspace/ghost-jon';
const RELOAD_DEBOUNCE_MS = 5_000;
const WATCH_INTERVAL_MS = 2_000;
const RECENT_MEMORIES_LIMIT = 10;

let ghostDir: string = DEFAULT_GHOST_DIR;
// The static cache holds the file-derived portion of the prompt. We
// intentionally split this from the memories section: GJ_* files change
// rarely (and trigger a debounced reload), but memories change every
// time the trigger engine writes one — re-reading from the DB on each
// call keeps behavior responsive without trashing prompt caching for
// the heavy static block.
let cachedStaticPrompt: string | null = null;
let watchersAttached = false;
let reloadTimer: NodeJS.Timeout | null = null;
let ghostDB: SessionDB | null = null;

/**
 * Override the directory the loader reads from. Useful for tests; the
 * runtime keeps the default. Calling this resets the cache and detaches
 * any existing watchers so the next read picks up the new dir.
 */
export function setGhostContextDir(dir: string): void {
  if (dir === ghostDir && cachedStaticPrompt !== null) return;
  detachWatchers();
  ghostDir = dir;
  cachedStaticPrompt = null;
  watchersAttached = false;
}

/**
 * Wire the session DB into the loader so recent memories can be pulled
 * into the system prompt at assemble time. Without this the loader runs
 * file-only and the learning loop is write-only — Michael's corrections
 * never reach Ghost's inference path.
 *
 * Pass `null` to detach (used by tests).
 */
export function setGhostContextDB(db: SessionDB | null): void {
  ghostDB = db;
}

/**
 * Return the fully assembled Ghost Jon system prompt: static file
 * content (cached, watcher-reloaded) plus a fresh read of recent
 * memories from the session DB. Memories live in a separate "Recent
 * Memories" section so a future memory write doesn't invalidate the
 * cache of the heavy static block.
 *
 * Missing files are tolerated — they're noted inline ("[missing: name]")
 * rather than thrown, so the shadow path never crashes mid-turn.
 */
export function getGhostSystemPrompt(): string {
  if (cachedStaticPrompt === null) {
    cachedStaticPrompt = assembleStaticPrompt();
  }
  if (!watchersAttached) {
    attachWatchers();
    watchersAttached = true;
  }
  const memoriesSection = assembleMemoriesSection();
  if (!memoriesSection) return cachedStaticPrompt;
  // Memories prepended so a fresh correction lands above the
  // soul/identity material at inference time — the brief specifies this
  // ordering ("prepend them to the system prompt under a ## Recent
  // Memories section"). Loses some cache hit rate when memories change
  // frequently; the trade is worth it for behavior change to actually
  // close the loop.
  return `${memoriesSection}\n\n${cachedStaticPrompt}`;
}

/**
 * Force a reload of all context files. Returns the new assembled prompt.
 * Exposed for tests and for any future CLI command that wants to refresh
 * Ghost context without bouncing the runtime.
 */
export function reloadGhostContext(): string {
  cachedStaticPrompt = assembleStaticPrompt();
  return getGhostSystemPrompt();
}

function assembleStaticPrompt(): string {
  const sections: string[] = [];
  for (const name of GHOST_FILES) {
    const path = join(ghostDir, name);
    let body: string;
    if (existsSync(path)) {
      try {
        body = readFileSync(path, 'utf-8').trim();
      } catch (err) {
        body = `[ghost-context: failed to read ${name}: ${(err as Error).message}]`;
      }
    } else {
      body = `[ghost-context: missing ${name}]`;
    }
    sections.push(`# ─── ${name} ────────────────────────────────────────\n\n${body}`);
  }
  return sections.join('\n\n');
}

/**
 * Build the "Recent Memories" section from the session DB. Returns an
 * empty string when no DB is wired or no memories exist — callers can
 * concatenate unconditionally without producing an orphan header.
 *
 * Importance order is critical → high → normal → other, then recency.
 * That puts a fresh correction at the top where it actually influences
 * the next response.
 */
function assembleMemoriesSection(): string {
  if (!ghostDB) return '';
  let memories: Array<{ value: string; category: string | null; importance: string }>;
  try {
    memories = ghostDB.getRecentMemories(RECENT_MEMORIES_LIMIT);
  } catch {
    return '';
  }
  if (memories.length === 0) return '';
  const lines: string[] = ['## Recent Memories', ''];
  for (const m of memories) {
    const tag = m.category ? `[${m.category}/${m.importance}]` : `[${m.importance}]`;
    lines.push(`- ${tag} ${m.value}`);
  }
  return lines.join('\n');
}

function attachWatchers(): void {
  for (const name of GHOST_FILES) {
    const path = join(ghostDir, name);
    try {
      watchFile(path, { interval: WATCH_INTERVAL_MS, persistent: false }, (curr, prev) => {
        if (curr.size === prev.size && curr.mtimeMs === prev.mtimeMs) return;
        scheduleReload();
      });
    } catch {
      /* watcher attach failure is non-fatal — cache still works, just won't auto-reload */
    }
  }
}

function detachWatchers(): void {
  if (!watchersAttached) return;
  for (const name of GHOST_FILES) {
    try {
      unwatchFile(join(ghostDir, name));
    } catch {
      /* ignore */
    }
  }
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
}

function scheduleReload(): void {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    try {
      cachedStaticPrompt = assembleStaticPrompt();
    } catch {
      /* leave previous cache in place on failure */
    }
  }, RELOAD_DEBOUNCE_MS);
  reloadTimer.unref?.();
}

/**
 * Test-only helper — drops watchers and cache so a fresh test gets a
 * clean read. Not exported for production paths.
 */
export function _resetGhostContextForTests(): void {
  detachWatchers();
  cachedStaticPrompt = null;
  watchersAttached = false;
  ghostDir = DEFAULT_GHOST_DIR;
  ghostDB = null;
}

/**
 * Returns where the loader is currently reading from. Useful for the
 * `ghost status` CLI command to confirm the path.
 */
export function getGhostContextDir(): string {
  return ghostDir;
}

/**
 * Cheap stat-only probe — returns the list of expected files and whether
 * each exists. Used by `ghost status` so operators can see at a glance
 * whether context is wired.
 */
export function describeGhostContextFiles(): Array<{ name: string; present: boolean; size: number }> {
  return GHOST_FILES.map((name) => {
    const path = join(ghostDir, name);
    if (!existsSync(path)) return { name, present: false, size: 0 };
    try {
      return { name, present: true, size: statSync(path).size };
    } catch {
      return { name, present: false, size: 0 };
    }
  });
}
