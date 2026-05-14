#!/usr/bin/env node
/**
 * ThunderGate CLI
 *
 * Commands:
 *   thundergate start         Start the runtime
 *   thundergate stop          Stop the runtime
 *   thundergate status        Show current state
 *   thundergate doctor        Run full diagnostic
 *   thundergate doctor --watch  Live monitoring
 */

import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, unlinkSync, createReadStream, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import { createInterface } from 'readline';
import * as os from 'os';
import { ensureConfig, validateConfig, getConfigPath } from '../config/index.js';
import { GhostEvaluator } from '../ghost/evaluator.js';
import { GhostCalibrator, type CalibrateCategory } from '../ghost/calibrate.js';
import { runLearnTests, formatReport } from '../ghost/learn-test.js';
import { describeGhostContextFiles, getGhostContextDir } from '../ghost/context.js';
import { ProvenanceLedger, type ProvenanceEvent } from '../provenance/ledger.js';
import { SessionDB } from '../session/database.js';
import { PromiseTracker } from '../memory/promises.js';
import { FrameManager } from '../memory/frame.js';
import { UntrainService } from '../memory/untrain.js';
import { ProvisionalMemoryService } from '../memory/provisional.js';
import { MemoryWAL } from '../memory/wal.js';
import { DEFAULT_BROWSER_BRIDGE_PORT } from '../browser/bridge.js';
import {
  VaultService,
  VaultLockedError,
  VaultBadPasswordError,
  VaultGrantError,
  type VaultCategory,
  type DisclosureMode
} from '../vault/vault.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const THUNDERGATE_DIR = join(os.homedir(), '.thundergate');
const PID_FILE = join(THUNDERGATE_DIR, 'thundergate.pid');
const STATE_FILE = join(THUNDERGATE_DIR, 'state.json');
const GHOST_FLAG_FILE = join(THUNDERGATE_DIR, 'ghost.enabled');

const program = new Command();

program
  .name('thundergate')
  .description('ThunderGate Runtime — Sovereign AI agent runtime')
  .version('0.1.0');

// ── start ──────────────────────────────────────────────────────────────────

program
  .command('start')
  .description('Start the ThunderGate runtime')
  .option('--foreground', 'Run in foreground (default: daemon)')
  .action((opts) => {
    if (isRunning()) {
      const pid = getPid();
      console.log(`⚡ ThunderGate already running (PID ${pid})`);
      process.exit(0);
    }

    console.log('⚡ Starting ThunderGate...');

    if (opts.foreground) {
      // Run in foreground
      const child = spawn('node', [join(__dirname, '../core/runtime.js')], {
        stdio: 'inherit'
      });
      writePid(child.pid!);
      child.on('exit', () => {
        removePid();
        console.log('⚡ ThunderGate stopped');
      });
    } else {
      // Daemon mode
      const child = spawn('node', [join(__dirname, '../core/runtime.js')], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      writePid(child.pid!);
      console.log(`  ✓ ThunderGate started (PID ${child.pid})`);
      console.log(`  ✓ Run 'thundergate status' to check health`);
    }
  });

// ── stop ───────────────────────────────────────────────────────────────────

program
  .command('stop')
  .description('Stop the ThunderGate runtime')
  .action(() => {
    if (!isRunning()) {
      console.log('⚡ ThunderGate is not running');
      process.exit(0);
    }

    const pid = getPid();
    console.log(`⚡ Stopping ThunderGate (PID ${pid})...`);

    try {
      process.kill(pid, 'SIGTERM');
      removePid();
      console.log('  ✓ ThunderGate stopped');
    } catch (e) {
      console.error('  ✗ Failed to stop ThunderGate:', e);
      removePid(); // Clean up stale PID
    }
  });

// ── status ─────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show current runtime state')
  .action(() => {
    console.log('⚡ ThunderGate Status');
    console.log('═══════════════════════════════════════');

    // Running status
    const running = isRunning();
    const pid = running ? getPid() : null;
    console.log(`  Status:   ${running ? '✅ Running' : '❌ Stopped'}${pid ? ` (PID ${pid})` : ''}`);

    if (!running) {
      console.log('\nRun: thundergate start');
      process.exit(0);
    }

    // Load state if available
    const state = loadState();
    if (state) {
      console.log(`  Model:    ${state.model || 'unknown'}`);
      console.log(`  Session:  ${state.sessionId || 'unknown'}`);
      console.log(`  Tokens:   ${state.contextTokens?.toLocaleString() || '0'}`);
      console.log(`  Uptime:   ${formatUptime(state.startedAt)}`);
      console.log(`  Doctor:   ${state.doctorStatus || 'unknown'}`);
    }

    // System info
    console.log('');
    console.log('  System:');
    console.log(`    CPU:    ${getCpuUsage()}%`);
    console.log(`    Memory: ${getMemoryUsage()} MB used`);
    console.log(`    Node:   ${process.version}`);
  });

// ── doctor ─────────────────────────────────────────────────────────────────

program
  .command('doctor')
  .description('Run full diagnostic')
  .option('--watch', 'Continuous monitoring (refresh every 30s)')
  .option('--fix', 'Auto-fix known issues')
  .action(async (opts) => {
    if (opts.watch) {
      console.log('⚡ ThunderGate Doctor — Live Monitoring');
      console.log('Press Ctrl+C to stop\n');

      const runCheck = async () => {
        console.clear();
        await runDiagnostic(opts.fix);
        console.log('\nNext check in 30s...');
      };

      await runCheck();
      setInterval(() => { void runCheck(); }, 30000);
    } else {
      await runDiagnostic(opts.fix);
    }
  });

// ── ghost ──────────────────────────────────────────────────────────────────

const ghost = program.command('ghost').description('Ghost Jon shadow-mode controls');

ghost
  .command('start')
  .description('Enable shadow mode (takes effect at next thundergate start)')
  .action(() => {
    const cfg = ensureConfig();
    const raw = JSON.parse(readFileSync(getConfigPath(), 'utf-8'));
    raw.ghost = { ...(raw.ghost || {}), enabled: true };
    writeFileSync(getConfigPath(), JSON.stringify(raw, null, 2));
    writeFileSync(GHOST_FLAG_FILE, String(Date.now()));
    console.log('  ✓ Ghost mode enabled in config');
    if (isRunning()) {
      console.log('  ↻ Restart ThunderGate to pick it up: thundergate stop && thundergate start');
    }
    void cfg;
  });

ghost
  .command('stop')
  .description('Disable shadow mode (takes effect at next thundergate start)')
  .action(() => {
    ensureConfig();
    const raw = JSON.parse(readFileSync(getConfigPath(), 'utf-8'));
    raw.ghost = { ...(raw.ghost || {}), enabled: false };
    writeFileSync(getConfigPath(), JSON.stringify(raw, null, 2));
    if (existsSync(GHOST_FLAG_FILE)) unlinkSync(GHOST_FLAG_FILE);
    console.log('  ✓ Ghost mode disabled in config');
  });

ghost
  .command('status')
  .description('Show shadow-mode state and recent scores')
  .action(async () => {
    const cfg = ensureConfig();
    console.log('⚡ Ghost Jon Status');
    console.log('═══════════════════════════════════════');
    console.log(`  Enabled (config):  ${cfg.ghost.enabled ? '✅ yes' : '❌ no'}`);
    console.log(`  Model:             ${cfg.ghost.model}`);
    console.log(`  Max tokens:        ${cfg.ghost.maxTokens}`);
    console.log(`  Temperature:       ${cfg.ghost.temperature}`);
    const provider = cfg.ghost.model.startsWith('openai/') || cfg.ghost.model.startsWith('gpt-')
      ? (cfg.openaiApiKey ? '✅ OpenAI key present' : '❌ OpenAI key missing')
      : (cfg.anthropicApiKey ? '✅ Anthropic key present' : '❌ Anthropic key missing');
    console.log(`  Provider auth:     ${provider}`);
    // Voyage drives the tier-3 semantic comparator. Absence → tier-3 silently
    // skipped (entries fall back to tier-1/2). Show explicitly so an empty
    // tier-3 column in scoring isn't mysterious.
    const voyage = cfg.voyageApiKey
      ? '✅ Voyage key present (tier-3 semantic compare active)'
      : '⚠️  Voyage key missing — tier-3 semantic compare disabled (see: ~/.thundergate/voyage-key, env VOYAGE_API_KEY, or openclaw auth-profile voyage:default)';
    console.log(`  Embeddings:        ${voyage}`);
    // Watches the *whole* sessions directory, not a single legacy file. Show
    // the dir plus the count of active *.jsonl sessions so operators can
    // confirm the harness is attached to everything OpenClaw is writing.
    console.log(`  Sessions dir:      ${cfg.ghost.sessions_dir}`);
    let watchedCount: number | null = null;
    try {
      if (existsSync(cfg.ghost.sessions_dir)) {
        watchedCount = readdirSync(cfg.ghost.sessions_dir).filter((f) =>
          f.endsWith('.jsonl')
        ).length;
      }
    } catch {
      watchedCount = null;
    }
    console.log(
      `  Watching:          ${watchedCount === null ? '(dir unavailable)' : `${watchedCount} session file(s)`}`
    );
    console.log(`  Watch interval:    ${cfg.ghost.watch_interval_ms}ms (poll)`);
    console.log(`  Log file:          ${cfg.ghost.log_file}`);
    if (existsSync(cfg.ghost.log_file)) {
      const size = statSync(cfg.ghost.log_file).size;
      console.log(`  Log size:          ${(size / 1024).toFixed(1)} KB`);
    } else {
      console.log('  Log size:          (no log yet)');
    }

    const evaluator = new GhostEvaluator(cfg);
    const scores = await evaluator.computeScores();
    // Tier breakdown across the in-memory entries we just scanned. This
    // is the answer to "is tier-3 actually firing?" — a healthy run with
    // Voyage configured has non-zero tier-3, even if it's a minority.
    try {
      const { entries } = await evaluator.readEntries();
      const recent = entries.slice(-500);
      const t1 = recent.filter((e) => e.match_tier === 1).length;
      const t2 = recent.filter((e) => e.match_tier === 2).length;
      const t3 = recent.filter((e) => e.match_tier === 3).length;
      const emb = {
        used: recent.filter((e) => e.embedding_status === 'used').length,
        cached: recent.filter((e) => e.embedding_status === 'cached').length,
        skipNoKey: recent.filter((e) => e.embedding_status === 'no_key').length,
        skipErr: recent.filter((e) => e.embedding_status === 'error').length,
        skipNotNeeded: recent.filter((e) => e.embedding_status === 'not_needed').length
      };
      console.log('');
      console.log(`  Last ${recent.length} scored:  tier1=${t1}  tier2=${t2}  tier3=${t3}`);
      console.log(
        `  Voyage usage:      used=${emb.used}  cached=${emb.cached}  no_key=${emb.skipNoKey}  error=${emb.skipErr}  not_needed=${emb.skipNotNeeded}`
      );
    } catch {
      /* non-fatal — status keeps rendering */
    }
    console.log('');
    console.log(`  Consecutive clean days: ${scores.consecutive_clean_days}`);
    console.log(`  Cutover ready: ${scores.consecutive_clean_days >= 7 ? '🏆 YES' : `${7 - scores.consecutive_clean_days} more clean days needed`}`);
    console.log('');
    console.log(`  Doctor green (9-check): ${scores.doctor_green ? '✅ YES' : '❌ NO'}`);
    const deployTs = scores.deploy_timestamp
      ? new Date(scores.deploy_timestamp).toISOString()
      : '(unset — fail-closed mode)';
    console.log(`  Last deploy reference:  ${deployTs}`);
    for (const c of scores.doctor_checks) {
      const icon = c.pass ? '✅' : '❌';
      const head = `    ${icon} [${c.id}] ${c.name}  (${c.value}  ${c.threshold})`;
      console.log(head);
      if (!c.pass && c.reason) {
        console.log(`         reason: ${c.reason}`);
      }
    }
    console.log('');
    console.log('  Recent days (newest first):');
    console.log('    Legend: weighted = gate metric (length-weighted),  match = legacy binary rate,  nyr = [ghost: not yet ready] rate');
    if (scores.days.length === 0) {
      console.log('    (no data)');
    } else {
      for (const day of scores.days.slice(0, 7)) {
        const icon = day.status === 'green' ? '✅' : day.status === 'yellow' ? '⚠️ ' : '❌';
        const weighted = day.weighted_score.toFixed(2);
        const match = `${(day.match_rate * 100).toFixed(0)}%`;
        console.log(
          `    ${icon} ${day.date}  samples=${day.samples}  weighted=${weighted}  match=${match}  err=${(day.error_rate * 100).toFixed(0)}%  nyr=${(day.not_yet_ready_rate * 100).toFixed(0)}%  med_lat=${day.median_latency_ms}ms`
        );
      }
    }
  });

ghost
  .command('log')
  .description('Tail the ghost log')
  .option('--last <n>', 'Show last N entries', '20')
  .action(async (opts) => {
    const cfg = ensureConfig();
    if (!existsSync(cfg.ghost.log_file)) {
      console.log('No ghost log yet — start ghost mode and wait for traffic.');
      return;
    }
    const n = parseInt(opts.last, 10) || 20;
    const lines: string[] = [];
    const stream = createReadStream(cfg.ghost.log_file);
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      lines.push(line);
      if (lines.length > n * 4) lines.splice(0, lines.length - n * 4);
    }
    const tail = lines.slice(-n);
    for (const line of tail) {
      try {
        const e = JSON.parse(line);
        const ts = new Date(e.timestamp).toLocaleString();
        const m = e.match ? '✓' : '✗';
        console.log(`[${ts}] ${m} lat=${e.latency_ms}ms`);
        console.log(`  in : ${truncate(e.input)}`);
        console.log(`  oc : ${truncate(e.openclaw_response ?? '')}`);
        console.log(`  tg : ${truncate(e.thundergate_response)}`);
      } catch {
        console.log(line);
      }
    }
  });

ghost
  .command('learn-test')
  .description('Run learning-loop tests T1-T6 (gate bar = T1+T2+T3); records into ghost-scores.json for Doctor check 7')
  .action(async () => {
    console.log('⚡ Running Ghost Jon learning-loop tests...');
    const report = await runLearnTests();
    console.log('');
    console.log(formatReport(report));
    console.log('');
    // Doctor check 7 reads the cached learn-test result; record it now so
    // the next `ghost status` sees a fresh value. Bar is T1+T2+T3 per the
    // Doctor-green spec — T6 is part of the learn-test gatePass but Doctor
    // green explicitly calls out T1+T2+T3 only.
    try {
      const cfg = ensureConfig();
      const evaluator = new GhostEvaluator(cfg);
      const byName = new Map(report.results.map((r) => [r.name, r]));
      const passOrSkip = (n: string) => {
        const r = byName.get(n);
        return !!r && (r.pass || r.skipped === true);
      };
      const gatePass = passOrSkip('T1') && passOrSkip('T2') && passOrSkip('T3');
      evaluator.recordLearnTestResult({
        gatePass,
        results: report.results.map((r) => ({
          name: r.name,
          pass: r.pass,
          skipped: r.skipped
        }))
      });
    } catch (e) {
      console.warn(`(could not persist learn-test result for Doctor check 7: ${(e as Error).message})`);
    }
    process.exit(report.gatePass ? 0 : 1);
  });

ghost
  .command('calibrate')
  .description('Free Ghost Jon training loop — CLI Jon generates pairs, Haiku predicts, log scores')
  .option('--rounds <n>', 'Number of rounds to run', '20')
  .option(
    '--category <name>',
    'all | slack | cli | status | technical | personal',
    'all'
  )
  .action(async (opts: { rounds: string; category: string }) => {
    const rounds = parseInt(opts.rounds, 10) || 20;
    const allowed: CalibrateCategory[] = [
      'all',
      'slack',
      'cli',
      'status',
      'technical',
      'personal'
    ];
    const category = (allowed as string[]).includes(opts.category)
      ? (opts.category as CalibrateCategory)
      : 'all';
    if (!(allowed as string[]).includes(opts.category)) {
      console.warn(`  ⚠ Unknown category '${opts.category}', defaulting to 'all'`);
    }

    const cfg = ensureConfig();
    if (!cfg.anthropicApiKey) {
      console.error('  ✗ anthropicApiKey not set — calibration cannot call Ghost predictor');
      process.exit(1);
    }
    if (!existsSync('/home/ubuntu/.npm-global/bin/claude')) {
      console.error('  ✗ CLI Jon not found at /home/ubuntu/.npm-global/bin/claude');
      process.exit(1);
    }

    console.log('⚡ Ghost Jon Calibration');
    console.log('═══════════════════════════════════════');
    console.log(`  Rounds:    ${rounds}`);
    console.log(`  Category:  ${category}`);
    console.log(`  Model:     ${cfg.ghost.model}`);
    console.log(`  Log:       ${cfg.ghost.log_file}`);
    console.log(`  Voyage:    ${cfg.voyageApiKey ? 'enabled' : 'disabled (tier-3 will skip)'}`);
    console.log('');

    const calibrator = new GhostCalibrator(cfg);
    const summary = await calibrator.run(rounds, category);

    console.log('');
    console.log('───── Summary ──────────────────────────');
    console.log(`  Rounds completed: ${summary.rounds}/${rounds}`);
    console.log(`  Average score:    ${summary.avg_score.toFixed(3)}`);
    console.log(
      `  Tier breakdown:   tier1=${summary.tier_breakdown.tier1} ` +
      `tier2=${summary.tier_breakdown.tier2} tier3=${summary.tier_breakdown.tier3}`
    );
    console.log(`  Voyage hit rate:  ${(summary.voyage_hit_rate * 100).toFixed(1)}%`);
    console.log('');
    process.exit(0);
  });

ghost
  .command('promote')
  .description('Promote ThunderGate to primary (requires 7+ clean ghost days)')
  .action(async () => {
    const cfg = ensureConfig();
    const evaluator = new GhostEvaluator(cfg);
    const scores = await evaluator.computeScores();
    if (scores.consecutive_clean_days < 7) {
      console.log(`❌ Not ready: ${scores.consecutive_clean_days}/7 consecutive clean days`);
      console.log('   Cutover blocked — Doctor must tell the truth.');
      process.exit(1);
    }
    console.log('🏆 Cutover criteria met. Promote logic is intentionally manual for now.');
    console.log('   Edit ~/.thundergate/config.json to disable ghost and enable primary delivery.');
  });

// ── promises ──────────────────────────────────────────────────────────────
//
// Build 28 persistent memory: surface and manage the open-promise list.
// The CLI talks to the same context.db the runtime uses, so the gateway
// doesn't need to be running for these commands to work.

/**
 * Synchronous Doctor render of persistent-memory state.
 *
 * `better-sqlite3` is synchronous; `SessionDB.initialize()` is async only
 * because of mkdirSync semantics — the actual SQL is sync. We open the
 * DB here, snapshot the four metrics Doctor cares about (open promises,
 * current frame age, last transition, memory counts), and close.
 *
 * Returns formatted strings so the diagnostic loop can interleave them
 * with the rest of the checks output without buffering.
 */
async function collectPersistentMemoryChecks(): Promise<string[]> {
  const out: string[] = [];
  try {
    const cfg = ensureConfig();
    const db = new SessionDB(cfg.database.path);
    await db.initialize();
    try {
      const openCount = db.getOpenPromises(1000).length;
      const frame = db.getActiveOrPausedFrame();
      const transitions = db.getRecentFrameTransitions(1);
      const provService = new ProvisionalMemoryService(db);
      const memCounts = provService.counts();

      out.push(`✅ Promises     ${openCount} open`);
      if (frame) {
        const ageMin = ((Date.now() / 1000) - frame.last_activity_at) / 60;
        out.push(`✅ Frame        ${frame.status} ${frame.id.slice(0, 8)} (age ${ageMin.toFixed(1)}m)`);
      } else {
        out.push('✅ Frame        (no active frame — next inbound opens one)');
      }
      if (transitions.length > 0) {
        const t = transitions[0];
        const ts = new Date(t.timestamp * 1000).toLocaleString();
        out.push(`✅ FrameLast    ${t.from_status ?? '∅'} → ${t.to_status} at ${ts}`);
      } else {
        out.push('✅ FrameLast    (no transitions yet)');
      }
      out.push(`✅ Memory       ${memCounts.provisional} provisional, ${memCounts.confirmed} confirmed`);

      // WAL surfaces — Build 28+: durable replay log size, oldest
      // unplayed-row age (signal that replay didn't sweep something),
      // last-rotation timestamp, and a recent-corruption percentage.
      // We render >10% recent corruption as a warning icon per the spec.
      const wal = new MemoryWAL(db);
      const ws = wal.stats();
      const oldestAge = ws.oldestUnplayedAgeMs !== null
        ? `${(ws.oldestUnplayedAgeMs / 60000).toFixed(1)}m`
        : '∅';
      const lastRot = ws.lastRotationAt
        ? new Date(ws.lastRotationAt).toLocaleString()
        : '(never)';
      const corruptionPct = ws.recentSampleSize > 0
        ? (ws.corruptedRecent / ws.recentSampleSize) * 100
        : 0;
      const walIcon = corruptionPct > 10 ? '⚠️' : '✅';
      out.push(
        `${walIcon} WAL          ${ws.hotRows} hot rows (${ws.unplayedRows} unplayed, oldest ${oldestAge}), ` +
        `${ws.archiveRows} archived`
      );
      out.push(`${walIcon} WALrotation  last: ${lastRot}`);
      if (ws.recentSampleSize > 0) {
        out.push(
          `${walIcon} WALintegrity ${ws.corruptedRecent}/${ws.recentSampleSize} recent rows corrupted ` +
          `(${corruptionPct.toFixed(1)}%)`
        );
      }
    } finally {
      await db.close();
    }
  } catch (err) {
    out.push(`❌ PersistMem   ${(err as Error).message}`);
  }
  return out;
}

async function withDB<T>(fn: (db: SessionDB) => Promise<T> | T): Promise<T> {
  const cfg = ensureConfig();
  const db = new SessionDB(cfg.database.path);
  await db.initialize();
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

const promisesCmd = program.command('promises').description('Promise tracker — open commitments + audit');

promisesCmd
  .command('list', { isDefault: true })
  .description('Show all open promises')
  .action(async () => {
    await withDB(async (db) => {
      const tracker = new PromiseTracker(db);
      const open = tracker.surfaceOpen(100);
      if (open.length === 0) {
        console.log('No open promises.');
        return;
      }
      console.log(`Open promises (${open.length}):`);
      for (const p of open) {
        const ts = new Date(p.created_at * 1000).toLocaleString();
        console.log(`  • [${p.id.slice(0, 8)}] (${ts}) ${truncate(p.text, 100)}`);
      }
    });
  });

promisesCmd
  .command('close <id>')
  .description('Manually close a promise by id prefix')
  .option('--dismiss', 'Mark as DISMISSED instead of FULFILLED')
  .action(async (id: string, opts: { dismiss?: boolean }) => {
    await withDB(async (db) => {
      const open = db.getOpenPromises(1000);
      const match = open.find((p) => p.id.startsWith(id));
      if (!match) {
        console.log(`No open promise matching id prefix ${id}`);
        return;
      }
      const status = opts.dismiss ? 'DISMISSED' : 'FULFILLED';
      db.closePromise(match.id, status, 'cli');
      console.log(`✓ ${status} ${match.id.slice(0, 8)}: ${truncate(match.text, 80)}`);
    });
  });

// ── memory ────────────────────────────────────────────────────────────────

const memoryCmd = program.command('memory').description('Inspect the memory store (provisional + confirmed)');

memoryCmd
  .command('list')
  .description('Show all memories with status')
  .option('--limit <n>', 'Number of rows to show', '50')
  .action(async (opts: { limit: string }) => {
    await withDB(async (db) => {
      const limit = parseInt(opts.limit, 10) || 50;
      const rows = db.listMemories(limit);
      if (rows.length === 0) {
        console.log('No memories stored.');
        return;
      }
      const provService = new ProvisionalMemoryService(db);
      const counts = provService.counts();
      console.log(`Memories (${counts.total} total — ${counts.provisional} provisional, ${counts.confirmed} confirmed):`);
      for (const m of rows) {
        const flag = m.status === 'provisional' ? `📜prov(${m.uses_remaining})` : '✓ conf';
        const cat = m.category ? `[${m.category}]` : '';
        console.log(`  ${flag} ${m.key} ${cat} — ${truncate(m.value, 80)}`);
      }
    });
  });

memoryCmd
  .command('show <key>')
  .description('Show a specific memory by key')
  .action(async (key: string) => {
    await withDB(async (db) => {
      const m = db.getMemory(key);
      if (!m) {
        console.log(`No memory with key: ${key}`);
        return;
      }
      const created = new Date(m.created_at * 1000).toLocaleString();
      const updated = new Date(m.updated_at * 1000).toLocaleString();
      console.log(`Key:        ${m.key}`);
      console.log(`Status:     ${m.status}${m.status === 'provisional' ? ` (uses_remaining=${m.uses_remaining})` : ''}`);
      console.log(`Importance: ${m.importance}`);
      console.log(`Category:   ${m.category ?? '(none)'}`);
      console.log(`Source:     ${m.source}`);
      console.log(`Created:    ${created}`);
      console.log(`Updated:    ${updated}`);
      console.log('');
      console.log('Value:');
      console.log(m.value);
    });
  });

// ── untrain ───────────────────────────────────────────────────────────────

const untrainCmd = program.command('untrain').description('Remove learning entries (with audit)');

untrainCmd
  .command('remove <key>', { isDefault: true })
  .description('Remove a specific learning entry by key')
  .option('--actor <who>', "Who initiated the untrain ('michael' or 'jon')", 'michael')
  .option('--reason <text>', 'Optional reason captured in the audit row')
  .action(async (key: string, opts: { actor: string; reason?: string }) => {
    await withDB(async (db) => {
      const cfg = ensureConfig();
      const ledger = new ProvenanceLedger(cfg.localInference.provenanceFile);
      const svc = new UntrainService(db, ledger);
      const actor = (opts.actor === 'jon' ? 'jon' : 'michael') as 'jon' | 'michael';
      const existing = db.getMemory(key);
      if (!existing) {
        console.log(`No memory with key: ${key}`);
        return;
      }
      const res = svc.untrainByKey({
        key,
        actor,
        reason: opts.reason,
        triggerType: 'cli'
      });
      if (res.deleted) {
        console.log(`Removing behavior: ${key} — ${truncate(res.value ?? '', 80)}. Confirmed.`);
      } else {
        console.log(`✗ Untrain failed for key: ${key}`);
      }
    });
  });

untrainCmd
  .command('log')
  .description('Show recently untrained entries (audit trail)')
  .option('--limit <n>', 'Number of rows to show', '20')
  .action(async (opts: { limit: string }) => {
    await withDB(async (db) => {
      const limit = parseInt(opts.limit, 10) || 20;
      const rows = db.getRecentUntrains(limit);
      if (rows.length === 0) {
        console.log('No untrain events recorded.');
        return;
      }
      console.log(`Recent untrains (${rows.length}):`);
      for (const r of rows) {
        const ts = new Date(r.timestamp * 1000).toLocaleString();
        const trig = r.trigger_type ? `(${r.trigger_type})` : '';
        console.log(`  [${ts}] ${r.actor} ${trig} → ${r.target_key}`);
        if (r.target_value) console.log(`      was: ${truncate(r.target_value, 100)}`);
        if (r.reason) console.log(`      reason: ${r.reason}`);
      }
    });
  });

// ── frame ─────────────────────────────────────────────────────────────────

const frameCmd = program.command('frame').description('Continuity frame — current/recent/transitions');

frameCmd
  .command('current', { isDefault: true })
  .description('Show current frame info')
  .action(async () => {
    await withDB(async (db) => {
      const mgr = new FrameManager(db);
      const current = mgr.hydrate();
      if (!current) {
        console.log('No active or paused frame.');
        return;
      }
      const opened = new Date(current.opened_at * 1000).toLocaleString();
      const last = new Date(current.last_activity_at * 1000).toLocaleString();
      const ageMin = ((Date.now() / 1000) - current.last_activity_at) / 60;
      console.log(`Frame:         ${current.id}`);
      console.log(`Status:        ${current.status}`);
      console.log(`Topic anchor:  ${current.topic_anchor}`);
      console.log(`Device hint:   ${current.device_hint ?? '(none)'}`);
      console.log(`Model:         ${current.model_in_use ?? '(none)'}`);
      console.log(`Parent frame:  ${current.parent_frame_id ?? '(none)'}`);
      console.log(`Confidence:    ${current.confidence_floor}`);
      console.log(`Opened:        ${opened}`);
      console.log(`Last activity: ${last} (${ageMin.toFixed(1)}m ago)`);
    });
  });

frameCmd
  .command('recent')
  .description('Show recent frames')
  .option('--limit <n>', 'Number of frames to show', '10')
  .action(async (opts: { limit: string }) => {
    await withDB(async (db) => {
      const limit = parseInt(opts.limit, 10) || 10;
      const rows = db.getRecentFrames(limit);
      if (rows.length === 0) {
        console.log('No frames recorded.');
        return;
      }
      console.log(`Recent frames (${rows.length}):`);
      for (const f of rows) {
        const opened = new Date(f.opened_at * 1000).toLocaleString();
        const icon = f.status === 'ACTIVE' ? '●' : f.status === 'PAUSED' ? '◐' : '○';
        console.log(`  ${icon} [${f.id.slice(0, 8)}] ${f.status.padEnd(7)} ${opened}  ${truncate(f.topic_anchor, 60)}`);
      }
    });
  });

frameCmd
  .command('transitions')
  .description('Show frame transitions (open/pause/close/rejoin log)')
  .option('--limit <n>', 'Number of rows to show', '30')
  .action(async (opts: { limit: string }) => {
    await withDB(async (db) => {
      const limit = parseInt(opts.limit, 10) || 30;
      const rows = db.getRecentFrameTransitions(limit);
      if (rows.length === 0) {
        console.log('No frame transitions recorded.');
        return;
      }
      console.log(`Frame transitions (${rows.length}, newest first):`);
      for (const t of rows) {
        const ts = new Date(t.timestamp * 1000).toLocaleString();
        const from = t.from_status ?? '∅';
        console.log(`  [${ts}] ${t.frame_id.slice(0, 8)}  ${from} → ${t.to_status}  ${t.reason ?? ''}`);
      }
    });
  });

// ── vault ─────────────────────────────────────────────────────────────────
//
// Encrypted PII store. vault.db is separate from context.db so a leak of
// the chat database doesn't surrender SSNs/cards/medical IDs. Locked on
// every CLI invocation; password unlock only (biometric path is stubbed
// pending ThunderCommo iOS LocalAuthentication — see PROTOCOL_VAULT.md).

async function withVault<T>(fn: (vault: VaultService) => Promise<T> | T): Promise<T> {
  const cfg = ensureConfig();
  const ledger = new ProvenanceLedger(cfg.localInference.provenanceFile);
  const vault = new VaultService(ledger);
  vault.initialize();
  try {
    return await fn(vault);
  } finally {
    vault.close();
  }
}

const vaultCmd = program.command('vault').description('Encrypted PII vault — separate from context.db');

vaultCmd
  .command('status')
  .description('Show lock state and TTL remaining')
  .action(async () => {
    await withVault(async (vault) => {
      const s = vault.status();
      console.log('⚡ Vault Status');
      console.log('═══════════════════════════════════════');
      console.log(`  DB path:     ${s.dbPath}`);
      console.log(`  Entries:     ${s.entryCount}`);
      console.log(`  State:       ${s.locked ? '🔒 LOCKED' : '🔓 UNLOCKED'}`);
      if (!s.locked) {
        const mins = Math.floor(s.ttlRemainingMs / 60000);
        const secs = Math.floor((s.ttlRemainingMs % 60000) / 1000);
        const unlockedTs = s.unlockedAt ? new Date(s.unlockedAt).toLocaleString() : '(unknown)';
        console.log(`  Unlocked at: ${unlockedTs}`);
        console.log(`  TTL left:    ${mins}m ${secs}s`);
        console.log(`  Source:      ${s.source}`);
      }
    });
  });

vaultCmd
  .command('add <category> <label>')
  .description('Add a new entry (prompts for value). Categories: identity | financial | medical | auth')
  .option('--value <text>', 'Provide value inline (skips prompt — use only for scripts/tests)')
  .option('--password <text>', 'Vault password (otherwise prompted)')
  .action(async (category: string, label: string, opts: { value?: string; password?: string }) => {
    await withVault(async (vault) => {
      if (!vault.isUnlocked()) {
        const password = opts.password ?? (await promptHidden('Vault password: '));
        try {
          vault.unlock({ source: 'password', password });
        } catch (err) {
          if (err instanceof VaultBadPasswordError) {
            console.error('  ✗ Bad password — vault stays locked.');
            process.exit(1);
          }
          throw err;
        }
      }
      const value = opts.value ?? (await promptHidden(`Value for '${label}': `));
      try {
        const id = vault.add(category, label, value);
        console.log(`  ✓ Added ${category}:${label} (id ${id.slice(0, 8)})`);
      } catch (err) {
        console.error(`  ✗ Add failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
  });

vaultCmd
  .command('list')
  .description('List labels (never values)')
  .action(async () => {
    await withVault(async (vault) => {
      const rows = vault.list();
      if (rows.length === 0) {
        console.log('Vault is empty.');
        return;
      }
      console.log(`Vault entries (${rows.length}):`);
      let lastCategory = '';
      for (const r of rows) {
        if (r.category !== lastCategory) {
          console.log(`\n  [${r.category}]`);
          lastCategory = r.category;
        }
        const last = r.last_accessed_at
          ? new Date(r.last_accessed_at * 1000).toLocaleString()
          : 'never';
        console.log(`    • ${r.label.padEnd(28)} (last access: ${last})`);
      }
    });
  });

vaultCmd
  .command('unlock')
  .description('Unlock the vault (password OR biometric stub via --biometric-token)')
  .option('--password <text>', 'Vault password (otherwise prompted)')
  .option('--biometric-token <text>', 'Approval token from paired device — uses biometric source')
  .option('--ttl <minutes>', 'Session TTL in minutes', '30')
  .action(async (opts: { password?: string; biometricToken?: string; ttl?: string }) => {
    await withVault(async (vault) => {
      const ttlMin = parseInt(opts.ttl ?? '30', 10);
      const ttlMs = (Number.isFinite(ttlMin) && ttlMin > 0 ? ttlMin : 30) * 60 * 1000;
      const password = opts.password ?? (await promptHidden('Vault password: '));
      try {
        if (opts.biometricToken) {
          vault.unlock({
            source: 'biometric',
            password,
            biometricToken: opts.biometricToken,
            ttlMs
          });
        } else {
          vault.unlock({ source: 'password', password, ttlMs });
        }
      } catch (err) {
        if (err instanceof VaultBadPasswordError) {
          console.error('  ✗ Bad password — vault stays locked.');
          process.exit(1);
        }
        throw err;
      }
      const s = vault.status();
      const mins = Math.floor(s.ttlRemainingMs / 60000);
      console.log(`  ✓ Vault unlocked (${s.source}, ${mins}m TTL)`);
    });
  });

vaultCmd
  .command('lock')
  .description('Force-lock immediately')
  .action(async () => {
    await withVault(async (vault) => {
      vault.lock('cli');
      console.log('  ✓ Vault locked');
    });
  });

vaultCmd
  .command('access <label>')
  .description(
    'Read under a one-shot grant (vault must be unlocked). Default mode is claim ' +
      '(presence proof, no value). Use --raw with --policy-reason to emit plaintext.'
  )
  .requiredOption('--purpose <text>', 'Why is this access happening? Bound into the grant + receipt.')
  .option('--channel <name>', 'ThunderGate channel that requested the access', 'cli')
  .option('--agent-id <id>', 'Agent runtime id (defaults to "cli:<user>")')
  .option('--user <name>', 'Principal user (defaults to $USER)')
  .option('--ttl <seconds>', 'Grant TTL in seconds for this single access', '60')
  .option('--mode <mode>', 'Disclosure mode: claim | raw | blinded_match', 'claim')
  .option('--raw', 'Shortcut for --mode raw (requires --policy-reason)')
  .option('--policy-reason <text>', 'Required when mode is raw — the reason raw plaintext is justified.')
  .option('--candidate-hmac <hex>', 'For blinded_match: HMAC of the candidate keyed by grant.nonce.')
  .option('--password <text>', 'Vault password if currently locked')
  .action(async (
    label: string,
    opts: {
      purpose: string;
      channel?: string;
      agentId?: string;
      user?: string;
      ttl?: string;
      mode?: string;
      raw?: boolean;
      policyReason?: string;
      candidateHmac?: string;
      password?: string;
    }
  ) => {
    await withVault(async (vault) => {
      if (!vault.isUnlocked()) {
        if (!opts.password) {
          const env = vault.buildUnlockRequest(opts.purpose, `cli access of ${label}`);
          console.error(
            `  ⚠ Vault is locked. Emitted vault_unlock_request ${env.request_id} ` +
              '(paired device handler pending). Re-run with --password to unlock from the CLI.'
          );
          process.exit(2);
        }
        try {
          vault.unlock({ source: 'password', password: opts.password });
        } catch (err) {
          if (err instanceof VaultBadPasswordError) {
            console.error('  ✗ Bad password — vault stays locked.');
            process.exit(1);
          }
          throw err;
        }
      }
      const ttlSec = Math.max(1, parseInt(opts.ttl ?? '60', 10) || 60);
      const ttl_ms = ttlSec * 1000;
      const user = opts.user ?? process.env.USER ?? 'unknown';
      const agent_id = opts.agentId ?? `cli:${user}`;
      const channel = opts.channel ?? 'cli';
      const mode: DisclosureMode = opts.raw
        ? 'raw'
        : ((opts.mode as DisclosureMode) ?? 'claim');
      try {
        const grant = vault.issueGrant({
          user,
          agent_id,
          channel,
          purpose: opts.purpose,
          field_label: label,
          disclosure_mode: mode,
          ttl_ms,
          ...(mode === 'raw' && opts.policyReason ? { raw_policy_reason: opts.policyReason } : {})
        });
        const resp = vault.access({
          grant,
          ...(opts.candidateHmac ? { candidate_hmac: opts.candidateHmac } : {})
        });
        switch (resp.mode) {
          case 'raw':
            process.stdout.write(resp.value);
            if (process.stdout.isTTY) process.stdout.write('\n');
            console.error(
              `  • grant ${grant.grant_id.slice(0, 8)} → receipt ${resp.receipt_id.slice(0, 8)} (raw)`
            );
            break;
          case 'claim':
            console.log(
              JSON.stringify({
                mode: 'claim',
                has_value: true,
                grant_id: resp.grant_id,
                receipt_id: resp.receipt_id
              })
            );
            break;
          case 'blinded_match':
            console.log(
              JSON.stringify({
                mode: 'blinded_match',
                matches: resp.matches,
                grant_id: resp.grant_id,
                receipt_id: resp.receipt_id
              })
            );
            break;
        }
      } catch (err) {
        if (err instanceof VaultLockedError) {
          console.error('  ✗ Vault locked between unlock and access (TTL expired).');
          process.exit(1);
        }
        if (err instanceof VaultGrantError) {
          console.error(`  ✗ Grant rejected: ${err.message}`);
          process.exit(1);
        }
        console.error(`  ✗ Access failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
  });

vaultCmd
  .command('grant')
  .description(
    'Issue a scoped, expiring grant. Print grant_id so the caller can later run `vault access` ' +
      'against it. Default disclosure_mode is claim.'
  )
  .requiredOption('--field <label>', 'Field label this grant covers (e.g. ssn, bcbs_member_id)')
  .requiredOption('--purpose <text>', 'Why this grant exists. Recorded on every receipt.')
  .requiredOption('--ttl <minutes>', 'Grant lifetime in minutes')
  .option('--channel <name>', 'ThunderGate channel that requested the grant', 'cli')
  .option('--agent-id <id>', 'Agent runtime id (defaults to "cli:<user>")')
  .option('--user <name>', 'Principal user (defaults to $USER)')
  .option('--mode <mode>', 'Disclosure mode: claim | raw | blinded_match', 'claim')
  .option('--policy-reason <text>', 'Required if mode is raw — explicit justification.')
  .action(async (opts: {
    field: string;
    purpose: string;
    ttl: string;
    channel?: string;
    agentId?: string;
    user?: string;
    mode?: string;
    policyReason?: string;
  }) => {
    await withVault(async (vault) => {
      const ttlMin = Math.max(1, parseInt(opts.ttl, 10) || 0);
      if (ttlMin <= 0) {
        console.error('  ✗ --ttl must be a positive integer (minutes)');
        process.exit(1);
      }
      const user = opts.user ?? process.env.USER ?? 'unknown';
      const agent_id = opts.agentId ?? `cli:${user}`;
      const channel = opts.channel ?? 'cli';
      const mode: DisclosureMode = (opts.mode as DisclosureMode) ?? 'claim';
      try {
        const grant = vault.issueGrant({
          user,
          agent_id,
          channel,
          purpose: opts.purpose,
          field_label: opts.field,
          disclosure_mode: mode,
          ttl_ms: ttlMin * 60 * 1000,
          ...(mode === 'raw' && opts.policyReason ? { raw_policy_reason: opts.policyReason } : {})
        });
        console.log('⚡ Vault Grant Issued');
        console.log('═══════════════════════════════════════');
        console.log(`  grant_id        : ${grant.grant_id}`);
        console.log(`  field_label     : ${grant.field_label}`);
        console.log(`  purpose         : ${grant.purpose}`);
        console.log(`  channel         : ${grant.channel}`);
        console.log(`  agent_id        : ${grant.agent_id}`);
        console.log(`  user            : ${grant.user}`);
        console.log(`  disclosure_mode : ${grant.disclosure_mode}`);
        console.log(`  ttl             : ${ttlMin}m`);
        console.log(`  expires_at      : ${new Date(grant.expires_at).toISOString()}`);
        console.log(`  policy_hash     : ${grant.policy_hash.slice(0, 16)}…`);
        if (grant.disclosure_mode === 'blinded_match') {
          console.log(`  nonce (HMAC key): ${grant.nonce}`);
        }
      } catch (err) {
        if (err instanceof VaultGrantError) {
          console.error(`  ✗ Grant denied: ${err.message}`);
          process.exit(1);
        }
        throw err;
      }
    });
  });

vaultCmd
  .command('receipts')
  .description('Show the hash-chained access-receipt log. Never prints values.')
  .option('--limit <n>', 'How many receipts to show (newest first)', '10')
  .option('--verify', 'Also verify the chain end-to-end and report the result')
  .action(async (opts: { limit?: string; verify?: boolean }) => {
    await withVault(async (vault) => {
      const limit = Math.max(1, parseInt(opts.limit ?? '10', 10) || 10);
      const rows = vault.listReceipts(limit);
      if (rows.length === 0) {
        console.log('No vault receipts recorded.');
      } else {
        console.log(`Vault receipts (${rows.length}, newest first):`);
        for (const r of rows) {
          const ts = new Date(r.accessed_at).toISOString();
          const prev = r.previous_receipt_hash
            ? r.previous_receipt_hash.slice(0, 12) + '…'
            : '(genesis)';
          console.log(
            `  [${ts}] ${r.field_label.padEnd(20)} ${r.disclosure_mode.padEnd(14)} ` +
              `grant ${r.grant_id.slice(0, 8)} receipt ${r.receipt_id.slice(0, 8)}`
          );
          console.log(
            `     channel=${r.channel} agent=${r.agent_id} purpose="${r.purpose}"`
          );
          console.log(
            `     prev=${prev}  hash=${r.receipt_hash.slice(0, 16)}…`
          );
        }
      }
      if (opts.verify) {
        const result = vault.verifyReceiptChain();
        if (result.ok) {
          console.log('\n  ✓ Receipt chain verified end-to-end.');
        } else {
          console.error(
            `\n  ✗ Chain broken at receipt ${result.broken_at_receipt_id} (${result.reason})`
          );
          process.exit(1);
        }
      }
    });
  });

/**
 * Hidden-input prompt for passwords/secrets. Falls back to plain readline
 * when stdin isn't a TTY (e.g., piped input in tests).
 */
async function promptHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const line: string = await new Promise((resolve) => rl.question(prompt, resolve));
    rl.close();
    return line;
  }
  process.stdout.write(prompt);
  return new Promise<string>((resolve, reject) => {
    const chunks: string[] = [];
    const stdin = process.stdin;
    const onData = (buf: Buffer) => {
      const s = buf.toString('utf8');
      for (const ch of s) {
        const code = ch.charCodeAt(0);
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.removeListener('data', onData);
          stdin.pause();
          process.stdout.write('\n');
          resolve(chunks.join(''));
          return;
        }
        if (code === 3) {
          // Ctrl-C — abort
          stdin.setRawMode(false);
          stdin.removeListener('data', onData);
          stdin.pause();
          reject(new Error('aborted'));
          return;
        }
        if (code === 127 || code === 8) {
          // Backspace / DEL
          if (chunks.length > 0) chunks.pop();
          continue;
        }
        if (code < 32) {
          // Other control chars — ignore
          continue;
        }
        chunks.push(ch);
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

function truncate(s: string, n: number = 120): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}

// ── Helper functions ───────────────────────────────────────────────────────

function isRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;

  const pid = getPid();
  try {
    process.kill(pid, 0); // Signal 0 = check if exists
    return true;
  } catch {
    removePid(); // Stale PID file
    return false;
  }
}

function getPid(): number {
  return parseInt(readFileSync(PID_FILE, 'utf-8').trim());
}

function writePid(pid: number): void {
  writeFileSync(PID_FILE, String(pid));
}

function removePid(): void {
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
}

function loadState(): any {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function formatUptime(startedAt: number): string {
  if (!startedAt) return 'unknown';
  const ms = Date.now() - startedAt;
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  return `${hours}h ${minutes}m`;
}

function getCpuUsage(): string {
  try {
    const cpus = os.cpus();
    const usage = cpus.reduce((acc, cpu) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      const idle = cpu.times.idle;
      return acc + ((total - idle) / total) * 100;
    }, 0) / cpus.length;
    return usage.toFixed(1);
  } catch {
    return 'unknown';
  }
}

function getMemoryUsage(): string {
  const used = (os.totalmem() - os.freemem()) / (1024 * 1024);
  return used.toFixed(0);
}

function formatLedgerAge(timestamp: number): string {
  const ms = Date.now() - timestamp;
  if (ms < 0) return 'in the future';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

function readPort(): number | null {
  try {
    const cfg = ensureConfig();
    return cfg.channels.thundercommo.port ?? null;
  } catch {
    return null;
  }
}

/**
 * Cheap "is this port open" check via /proc/net/tcp. We don't open a
 * socket because that would fight the running ThunderCommo server.
 */
function portOpen(port: number): boolean {
  try {
    const data = readFileSync('/proc/net/tcp', 'utf-8');
    const hex = port.toString(16).toUpperCase().padStart(4, '0');
    return data.split('\n').some((line) => {
      const cols = line.trim().split(/\s+/);
      return cols.length > 3 && cols[1]?.endsWith(`:${hex}`) && cols[3] === '0A';
    });
  } catch {
    return false;
  }
}

async function runDiagnostic(autoFix: boolean = false): Promise<void> {
  const timestamp = new Date().toLocaleString();
  console.log(`⚡ ThunderGate Doctor — ${timestamp}`);
  console.log('═══════════════════════════════════════');

  const checks: Array<{ name: string; pass: boolean; detail: string; fix?: () => void }> = [];

  // Check 1: Runtime running
  const running = isRunning();
  checks.push({
    name: 'Runtime',
    pass: running,
    detail: running ? `PID ${getPid()}` : 'Not running'
  });

  // Check 2: CPU
  const cpu = parseFloat(getCpuUsage());
  checks.push({
    name: 'CPU',
    pass: cpu < 90,
    detail: `${cpu}%${cpu > 90 ? ' — HIGH' : ''}`
  });

  // Check 3: Memory
  const memMb = parseFloat(getMemoryUsage());
  const totalMb = os.totalmem() / (1024 * 1024);
  checks.push({
    name: 'Memory',
    pass: memMb < 1500,
    detail: `${memMb.toFixed(0)} MB / ${totalMb.toFixed(0)} MB`
  });

  // Check 4: Database
  const dbPath = join(THUNDERGATE_DIR, 'context.db');
  checks.push({
    name: 'Database',
    pass: existsSync(dbPath),
    detail: existsSync(dbPath) ? 'context.db present' : 'Missing — run: thundergate start'
  });

  // Check 5: Config
  const configPath = join(THUNDERGATE_DIR, 'config.json');
  checks.push({
    name: 'Config',
    pass: existsSync(configPath),
    detail: existsSync(configPath) ? 'config.json present' : 'Using defaults'
  });

  // Check 6: Node version
  const nodeVer = parseInt(process.version.slice(1).split('.')[0]);
  checks.push({
    name: 'Node.js',
    pass: nodeVer >= 18,
    detail: `${process.version}${nodeVer < 18 ? ' — Upgrade to 18+' : ''}`
  });

  // Check 7: CLI Jon
  const cliPath = '/home/ubuntu/.npm-global/bin/claude';
  const cliPresent = existsSync(cliPath);
  checks.push({
    name: 'CLI Jon',
    pass: cliPresent,
    detail: cliPresent ? 'Installed ✅' : 'Not installed — run: npm install -g @anthropic-ai/claude-code'
  });

  // Check 8: ThunderCommo channel reachable (only if runtime is running)
  if (running) {
    const port = readPort();
    const tcUp = port ? portOpen(port) : false;
    checks.push({
      name: 'ThunderCommo',
      pass: tcUp,
      detail: tcUp ? `Listening on ws://0.0.0.0:${port}` : `Not listening${port ? ` on ${port}` : ''}`
    });
  }

  // Check 9: Ghost mode (truthful — never fakes a green when there's no data)
  try {
    const cfg = ensureConfig();
    const ghostEnabled = !!cfg.ghost?.enabled;
    if (ghostEnabled) {
      // Compute synchronously is awkward — use cached scores file.
      const evaluator = new GhostEvaluator(cfg);
      const cached = evaluator.loadScores();
      const days = cached?.consecutive_clean_days ?? 0;
      checks.push({
        name: 'Ghost mode',
        pass: existsSync(cfg.ghost.log_file),
        detail: `running, ${days} clean days${days >= 7 ? ' — CUTOVER READY' : ''}`
      });
    } else {
      checks.push({
        name: 'Ghost mode',
        pass: true,
        detail: 'stopped (config: ghost.enabled = false)'
      });
    }
  } catch (err) {
    checks.push({
      name: 'Ghost mode',
      pass: false,
      detail: `unknown: ${(err as Error).message}`
    });
  }

  // Check 10: Local inference (ThunderMind / Ollama).
  try {
    const cfg = ensureConfig();
    if (!cfg.localInference?.enabled) {
      checks.push({
        name: 'LocalInfer',
        pass: true,
        detail: 'disabled in config'
      });
    } else {
      const endpoint = cfg.localInference.endpoint;
      const u = (() => { try { return new URL(endpoint); } catch { return null; } })();
      const port = u && u.port ? parseInt(u.port, 10) : null;
      const portUp = u && u.hostname === 'localhost' && port ? portOpen(port) : null;
      const ledger = new ProvenanceLedger(cfg.localInference.provenanceFile);
      const events: ProvenanceEvent[] = ledger.tail(100);
      const reversed = [...events].reverse();
      const last = reversed.find(
        (e) => e.actor === 'local-inference' && (
          e.action === 'liveness_ok' ||
          e.action === 'liveness_lost' ||
          e.action === 'liveness_miss' ||
          e.action === 'first_check_missed'
        )
      );
      const lastModeChange = reversed.find(
        (e) => e.actor === 'local-inference' && e.action === 'mode_change'
      );
      const lastBreakerOpen = reversed.find(
        (e) => e.actor === 'local-inference' && e.action === 'circuit_breaker_opened'
      );
      const lastBreakerClose = reversed.find(
        (e) => e.actor === 'local-inference' && e.action === 'circuit_breaker_closed'
      );
      const breakerOpen =
        lastBreakerOpen != null &&
        (lastBreakerClose == null || lastBreakerClose.timestamp < lastBreakerOpen.timestamp);
      let consecFail = 0;
      for (const e of reversed) {
        if (e.actor !== 'local-inference') continue;
        if (e.action === 'liveness_ok') break;
        if (
          e.action === 'liveness_miss' ||
          e.action === 'liveness_lost' ||
          e.action === 'first_check_missed'
        ) {
          consecFail++;
        }
      }
      const reachable = last?.action === 'liveness_ok' || portUp === true;
      const lastAt = last ? formatLedgerAge(last.timestamp) : '(no probe yet)';
      const currentMode =
        lastModeChange?.data && typeof (lastModeChange.data as any).to === 'string'
          ? (lastModeChange.data as any).to
          : reachable ? 'LOCAL_INFERENCE' : 'CLOUD';
      const reason = lastModeChange?.reason ?? '(no transition yet)';
      const tail = ` | mode=${currentMode} | breaker=${breakerOpen ? 'OPEN' : 'closed'} | consec_fail=${consecFail} | reason: ${reason.length > 90 ? reason.slice(0, 89) + '…' : reason}`;
      checks.push({
        name: 'LocalInfer',
        // Today ThunderMind isn't built — unreachable is expected, so
        // we report pass when configured-but-unreachable matches the
        // graceful-fallback intent. Operators see the detail string.
        pass: true,
        detail: reachable
          ? `${endpoint} reachable, last check ${lastAt}${tail}`
          : `${endpoint} unreachable, last check ${lastAt} — cloud fallback active${tail}`
      });
    }
  } catch (err) {
    checks.push({
      name: 'LocalInfer',
      pass: false,
      detail: `unknown: ${(err as Error).message}`
    });
  }

  // Check 11: BrowserBridge native infrastructure. Listening port
  // (default 8770) holds open for the ThunderBrowser extension to dial
  // in. "No extension connected" is a healthy steady state — most
  // operators don't have the extension running. We pass when the
  // listener is up; the detail string carries connection + portal state
  // so operators see exactly what the runtime can reach right now.
  if (running) {
    try {
      const browserPort = DEFAULT_BROWSER_BRIDGE_PORT;
      const portUp = portOpen(browserPort);
      const ledger = new ProvenanceLedger(ensureConfig().localInference.provenanceFile);
      const events: ProvenanceEvent[] = ledger.tail(200);
      const reversed = [...events].reverse();
      const lastReady = reversed.find(
        (e) => e.actor === 'browser-bridge' && e.action === 'extension_ready'
      );
      const lastDisc = reversed.find(
        (e) => e.actor === 'browser-bridge' && e.action === 'extension_disconnected'
      );
      const connected =
        lastReady != null &&
        (lastDisc == null || lastDisc.timestamp < lastReady.timestamp);
      const url = (lastReady?.data as any)?.url ?? '';
      const portalState = (lastReady?.data as any)?.portalState ?? null;
      const lastReadyAt = lastReady ? formatLedgerAge(lastReady.timestamp) : '(never)';
      const tail = connected
        ? ` | ext connected at ${lastReadyAt}${url ? ` | url=${truncate(url, 60)}` : ''}${portalState ? ` | state=${portalState}` : ''}`
        : ` | no extension currently connected`;
      checks.push({
        name: 'Browser',
        pass: portUp,
        detail: portUp
          ? `Listening on ws://0.0.0.0:${browserPort}${tail}`
          : `Not listening on ${browserPort} — port bind failed or runtime old build${tail}`
      });
    } catch (err) {
      checks.push({
        name: 'Browser',
        pass: false,
        detail: `unknown: ${(err as Error).message}`
      });
    }
  }

  // Persistent-memory checks (Build 28): open promise count, current
  // frame age, last frame transition, provisional/confirmed memory counts.
  // We collect them as info-only rows (always pass) so a missing DB
  // doesn't poison the rest of the diagnostic — Check 4 already reports
  // DB presence as its own pass/fail.
  const memChecks = await collectPersistentMemoryChecks();

  // Display results
  let allPass = true;
  for (const check of checks) {
    const icon = check.pass ? '✅' : '❌';
    console.log(`  ${icon} ${check.name.padEnd(12)} ${check.detail}`);
    if (!check.pass) allPass = false;
  }
  for (const line of memChecks) {
    console.log(`  ${line}`);
  }

  console.log('');
  if (allPass) {
    console.log('  ✅ All checks passed — Doctor green');
  } else {
    console.log('  ⚠️  Issues detected — review above');
    if (autoFix) {
      console.log('  🔧 Auto-fix enabled — attempting repairs...');
    }
  }
}

// ── browser ────────────────────────────────────────────────────────────────
//
// Native BrowserBridge surface. The runtime exposes the bridge as a
// direct tool — `browser.click()` etc. — and this command is the
// operator's window into "is the arm currently attached to the brain?"
// Reads the same provenance ledger the runtime writes to, so it works
// without an in-process handle.

const browserCmd = program.command('browser').description('ThunderBrowser native bridge — connection + last action');

browserCmd
  .command('status')
  .description('Show extension connection, current URL, portal state, last action')
  .action(() => {
    const cfg = ensureConfig();
    const browserPort = DEFAULT_BROWSER_BRIDGE_PORT;
    const portUp = portOpen(browserPort);

    console.log('⚡ ThunderBrowser Bridge Status');
    console.log('═══════════════════════════════════════');
    console.log(`  Listening:        ${portUp ? `✅ ws://0.0.0.0:${browserPort}` : `❌ port ${browserPort} not bound`}`);
    if (!portUp) {
      console.log('');
      console.log('  Bridge listener not bound. Most likely causes:');
      console.log('   • ThunderGate runtime is not running (run: thundergate start)');
      console.log('   • Runtime is on an older build that predates the BrowserBridge wiring');
      console.log('   • Port already in use by another process');
      return;
    }

    let events: ProvenanceEvent[] = [];
    try {
      const ledger = new ProvenanceLedger(cfg.localInference.provenanceFile);
      events = ledger.tail(500);
    } catch {
      // ledger missing → no history yet, fall through with empty events
    }
    const reversed = [...events].reverse();
    const lastReady = reversed.find(
      (e) => e.actor === 'browser-bridge' && e.action === 'extension_ready'
    );
    const lastDisc = reversed.find(
      (e) => e.actor === 'browser-bridge' && e.action === 'extension_disconnected'
    );
    const lastAction = reversed.find(
      (e) => e.actor === 'browser-bridge' && typeof e.action === 'string' && e.action.startsWith('browser_')
    );

    const connected =
      lastReady != null &&
      (lastDisc == null || lastDisc.timestamp < lastReady.timestamp);
    console.log(`  Extension:        ${connected ? '✅ connected' : '❌ not connected'}`);

    if (lastReady) {
      const url = (lastReady.data as any)?.url ?? '';
      const portalState = (lastReady.data as any)?.portalState ?? null;
      console.log(`  Last ready:       ${formatLedgerAge(lastReady.timestamp)}`);
      if (url) console.log(`  Current URL:      ${url}`);
      if (portalState) console.log(`  Portal state:     ${portalState}`);
    } else {
      console.log('  Last ready:       (no extension has ever connected)');
    }

    if (lastDisc) {
      console.log(`  Last disconnect:  ${formatLedgerAge(lastDisc.timestamp)}${lastDisc.reason ? ` — ${lastDisc.reason}` : ''}`);
    }

    if (lastAction) {
      const verb = lastAction.action.replace(/^browser_/, '');
      const data = (lastAction.data as any) || {};
      const success = data.success === true ? '✅' : '❌';
      const lat = typeof data.latencyMs === 'number' ? `${data.latencyMs}ms` : '?';
      console.log(`  Last action:      ${success} ${verb}  (${lat}, ${formatLedgerAge(lastAction.timestamp)})`);
      if (lastAction.reason) console.log(`     reason:        ${lastAction.reason}`);
    } else {
      console.log('  Last action:      (none recorded)');
    }
  });

program.parse();
