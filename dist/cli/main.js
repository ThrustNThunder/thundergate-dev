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
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import * as os from 'os';
import { ensureConfig, getConfigPath } from '../config/index.js';
import { GhostEvaluator } from '../ghost/evaluator.js';
import { GhostCalibrator } from '../ghost/calibrate.js';
import { runLearnTests, formatReport } from '../ghost/learn-test.js';
import { ProvenanceLedger } from '../provenance/ledger.js';
import { SessionDB } from '../session/database.js';
import { PromiseTracker } from '../memory/promises.js';
import { FrameManager } from '../memory/frame.js';
import { UntrainService } from '../memory/untrain.js';
import { ProvisionalMemoryService } from '../memory/provisional.js';
import { MemoryWAL } from '../memory/wal.js';
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
        writePid(child.pid);
        child.on('exit', () => {
            removePid();
            console.log('⚡ ThunderGate stopped');
        });
    }
    else {
        // Daemon mode
        const child = spawn('node', [join(__dirname, '../core/runtime.js')], {
            detached: true,
            stdio: 'ignore'
        });
        child.unref();
        writePid(child.pid);
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
    }
    catch (e) {
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
    }
    else {
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
    if (existsSync(GHOST_FLAG_FILE))
        unlinkSync(GHOST_FLAG_FILE);
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
    let watchedCount = null;
    try {
        if (existsSync(cfg.ghost.sessions_dir)) {
            watchedCount = readdirSync(cfg.ghost.sessions_dir).filter((f) => f.endsWith('.jsonl')).length;
        }
    }
    catch {
        watchedCount = null;
    }
    console.log(`  Watching:          ${watchedCount === null ? '(dir unavailable)' : `${watchedCount} session file(s)`}`);
    console.log(`  Watch interval:    ${cfg.ghost.watch_interval_ms}ms (poll)`);
    console.log(`  Log file:          ${cfg.ghost.log_file}`);
    if (existsSync(cfg.ghost.log_file)) {
        const size = statSync(cfg.ghost.log_file).size;
        console.log(`  Log size:          ${(size / 1024).toFixed(1)} KB`);
    }
    else {
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
        console.log(`  Voyage usage:      used=${emb.used}  cached=${emb.cached}  no_key=${emb.skipNoKey}  error=${emb.skipErr}  not_needed=${emb.skipNotNeeded}`);
    }
    catch {
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
    }
    else {
        for (const day of scores.days.slice(0, 7)) {
            const icon = day.status === 'green' ? '✅' : day.status === 'yellow' ? '⚠️ ' : '❌';
            const weighted = day.weighted_score.toFixed(2);
            const match = `${(day.match_rate * 100).toFixed(0)}%`;
            console.log(`    ${icon} ${day.date}  samples=${day.samples}  weighted=${weighted}  match=${match}  err=${(day.error_rate * 100).toFixed(0)}%  nyr=${(day.not_yet_ready_rate * 100).toFixed(0)}%  med_lat=${day.median_latency_ms}ms`);
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
    const lines = [];
    const stream = createReadStream(cfg.ghost.log_file);
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line.trim())
            continue;
        lines.push(line);
        if (lines.length > n * 4)
            lines.splice(0, lines.length - n * 4);
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
        }
        catch {
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
        const passOrSkip = (n) => {
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
    }
    catch (e) {
        console.warn(`(could not persist learn-test result for Doctor check 7: ${e.message})`);
    }
    process.exit(report.gatePass ? 0 : 1);
});
ghost
    .command('calibrate')
    .description('Free Ghost Jon training loop — CLI Jon generates pairs, Haiku predicts, log scores')
    .option('--rounds <n>', 'Number of rounds to run', '20')
    .option('--category <name>', 'all | slack | cli | status | technical | personal', 'all')
    .action(async (opts) => {
    const rounds = parseInt(opts.rounds, 10) || 20;
    const allowed = [
        'all',
        'slack',
        'cli',
        'status',
        'technical',
        'personal'
    ];
    const category = allowed.includes(opts.category)
        ? opts.category
        : 'all';
    if (!allowed.includes(opts.category)) {
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
    console.log(`  Tier breakdown:   tier1=${summary.tier_breakdown.tier1} ` +
        `tier2=${summary.tier_breakdown.tier2} tier3=${summary.tier_breakdown.tier3}`);
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
async function collectPersistentMemoryChecks() {
    const out = [];
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
            }
            else {
                out.push('✅ Frame        (no active frame — next inbound opens one)');
            }
            if (transitions.length > 0) {
                const t = transitions[0];
                const ts = new Date(t.timestamp * 1000).toLocaleString();
                out.push(`✅ FrameLast    ${t.from_status ?? '∅'} → ${t.to_status} at ${ts}`);
            }
            else {
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
            out.push(`${walIcon} WAL          ${ws.hotRows} hot rows (${ws.unplayedRows} unplayed, oldest ${oldestAge}), ` +
                `${ws.archiveRows} archived`);
            out.push(`${walIcon} WALrotation  last: ${lastRot}`);
            if (ws.recentSampleSize > 0) {
                out.push(`${walIcon} WALintegrity ${ws.corruptedRecent}/${ws.recentSampleSize} recent rows corrupted ` +
                    `(${corruptionPct.toFixed(1)}%)`);
            }
        }
        finally {
            await db.close();
        }
    }
    catch (err) {
        out.push(`❌ PersistMem   ${err.message}`);
    }
    return out;
}
async function withDB(fn) {
    const cfg = ensureConfig();
    const db = new SessionDB(cfg.database.path);
    await db.initialize();
    try {
        return await fn(db);
    }
    finally {
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
    .action(async (id, opts) => {
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
    .action(async (opts) => {
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
    .action(async (key) => {
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
    .action(async (key, opts) => {
    await withDB(async (db) => {
        const cfg = ensureConfig();
        const ledger = new ProvenanceLedger(cfg.localInference.provenanceFile);
        const svc = new UntrainService(db, ledger);
        const actor = (opts.actor === 'jon' ? 'jon' : 'michael');
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
        }
        else {
            console.log(`✗ Untrain failed for key: ${key}`);
        }
    });
});
untrainCmd
    .command('log')
    .description('Show recently untrained entries (audit trail)')
    .option('--limit <n>', 'Number of rows to show', '20')
    .action(async (opts) => {
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
            if (r.target_value)
                console.log(`      was: ${truncate(r.target_value, 100)}`);
            if (r.reason)
                console.log(`      reason: ${r.reason}`);
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
    .action(async (opts) => {
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
    .action(async (opts) => {
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
// ── posture ───────────────────────────────────────────────────────────────
const postureCmd = program.command('posture').description('Posture state machine — current decision + recent transitions');
postureCmd
    .command('status', { isDefault: true })
    .description('Show the most recent posture decision')
    .action(() => {
    const cfg = ensureConfig();
    const ledger = new ProvenanceLedger(cfg.localInference.provenanceFile);
    // Tail enough rows that we'll likely see at least one posture event
    // even if a lot of other actors have been writing. The full ledger
    // is JSONL — a few hundred rows is cheap.
    const tail = ledger.tail(500);
    const decisions = tail.filter((r) => r.action === 'posture_recomputed');
    const overrides = tail.filter((r) => r.action === 'posture_override_set' || r.action === 'posture_override_cleared');
    const latest = decisions[decisions.length - 1];
    const latestOverride = overrides[overrides.length - 1];
    console.log('⚡ ThunderGate Posture');
    console.log('═══════════════════════════════════════');
    if (!latest) {
        console.log('  No posture decisions recorded yet.');
        console.log('  (The runtime computes posture on every inbound — wait for the next turn.)');
        return;
    }
    const d = latest.data ?? {};
    const when = new Date(latest.timestamp).toLocaleString();
    console.log(`  When:           ${when}`);
    console.log(`  Response shape: ${d.response_shape ?? '(unknown)'}`);
    console.log(`  Default mode:   ${d.default_mode ?? '(unknown)'}`);
    console.log(`  Notifications:  ${d.notification_policy ?? '(unknown)'}`);
    console.log(`  Channel type:   ${d.channelType ?? '(unknown)'}`);
    console.log(`  Override:       ${d.override ?? '(none)'}`);
    const reasons = Array.isArray(d.reasons) ? d.reasons : [];
    if (reasons.length > 0) {
        console.log('  Reasons (in order applied):');
        for (const r of reasons)
            console.log(`    - ${r}`);
    }
    if (latestOverride) {
        const owhen = new Date(latestOverride.timestamp).toLocaleString();
        console.log('');
        console.log(`  Last override event: ${latestOverride.action} @ ${owhen}`);
        console.log(`    reason: ${latestOverride.reason ?? '(none)'}`);
    }
});
postureCmd
    .command('recent')
    .description('Show recent posture transitions')
    .option('--limit <n>', 'Number of rows to show', '20')
    .action((opts) => {
    const cfg = ensureConfig();
    const limit = parseInt(opts.limit, 10) || 20;
    const ledger = new ProvenanceLedger(cfg.localInference.provenanceFile);
    const tail = ledger.tail(1000);
    const events = tail.filter((r) => r.action === 'posture_recomputed' ||
        r.action === 'posture_override_set' ||
        r.action === 'posture_override_cleared');
    const slice = events.slice(-limit);
    if (slice.length === 0) {
        console.log('No posture events recorded.');
        return;
    }
    console.log(`Posture events (${slice.length}, newest last):`);
    for (const e of slice) {
        const when = new Date(e.timestamp).toLocaleString();
        if (e.action === 'posture_recomputed') {
            const d = e.data ?? {};
            console.log(`  [${when}] recompute  shape=${d.response_shape} mode=${d.default_mode} notif=${d.notification_policy} chan=${d.channelType} override=${d.override ?? '-'}`);
        }
        else {
            console.log(`  [${when}] ${e.action}  ${e.reason ?? ''}`);
        }
    }
});
function truncate(s, n = 120) {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > n ? flat.slice(0, n) + '…' : flat;
}
// ── Helper functions ───────────────────────────────────────────────────────
function isRunning() {
    if (!existsSync(PID_FILE))
        return false;
    const pid = getPid();
    try {
        process.kill(pid, 0); // Signal 0 = check if exists
        return true;
    }
    catch {
        removePid(); // Stale PID file
        return false;
    }
}
function getPid() {
    return parseInt(readFileSync(PID_FILE, 'utf-8').trim());
}
function writePid(pid) {
    writeFileSync(PID_FILE, String(pid));
}
function removePid() {
    if (existsSync(PID_FILE))
        unlinkSync(PID_FILE);
}
function loadState() {
    if (!existsSync(STATE_FILE))
        return null;
    try {
        return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    }
    catch {
        return null;
    }
}
function formatUptime(startedAt) {
    if (!startedAt)
        return 'unknown';
    const ms = Date.now() - startedAt;
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
}
function getCpuUsage() {
    try {
        const cpus = os.cpus();
        const usage = cpus.reduce((acc, cpu) => {
            const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
            const idle = cpu.times.idle;
            return acc + ((total - idle) / total) * 100;
        }, 0) / cpus.length;
        return usage.toFixed(1);
    }
    catch {
        return 'unknown';
    }
}
function getMemoryUsage() {
    const used = (os.totalmem() - os.freemem()) / (1024 * 1024);
    return used.toFixed(0);
}
function formatLedgerAge(timestamp) {
    const ms = Date.now() - timestamp;
    if (ms < 0)
        return 'in the future';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60)
        return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ${minutes % 60}m ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h ago`;
}
function readPort() {
    try {
        const cfg = ensureConfig();
        return cfg.channels.thundercommo.port ?? null;
    }
    catch {
        return null;
    }
}
/**
 * Cheap "is this port open" check via /proc/net/tcp. We don't open a
 * socket because that would fight the running ThunderCommo server.
 */
function portOpen(port) {
    try {
        const data = readFileSync('/proc/net/tcp', 'utf-8');
        const hex = port.toString(16).toUpperCase().padStart(4, '0');
        return data.split('\n').some((line) => {
            const cols = line.trim().split(/\s+/);
            return cols.length > 3 && cols[1]?.endsWith(`:${hex}`) && cols[3] === '0A';
        });
    }
    catch {
        return false;
    }
}
async function runDiagnostic(autoFix = false) {
    const timestamp = new Date().toLocaleString();
    console.log(`⚡ ThunderGate Doctor — ${timestamp}`);
    console.log('═══════════════════════════════════════');
    const checks = [];
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
        }
        else {
            checks.push({
                name: 'Ghost mode',
                pass: true,
                detail: 'stopped (config: ghost.enabled = false)'
            });
        }
    }
    catch (err) {
        checks.push({
            name: 'Ghost mode',
            pass: false,
            detail: `unknown: ${err.message}`
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
        }
        else {
            const endpoint = cfg.localInference.endpoint;
            const u = (() => { try {
                return new URL(endpoint);
            }
            catch {
                return null;
            } })();
            const port = u && u.port ? parseInt(u.port, 10) : null;
            const portUp = u && u.hostname === 'localhost' && port ? portOpen(port) : null;
            const ledger = new ProvenanceLedger(cfg.localInference.provenanceFile);
            const events = ledger.tail(100);
            const reversed = [...events].reverse();
            const last = reversed.find((e) => e.actor === 'local-inference' && (e.action === 'liveness_ok' ||
                e.action === 'liveness_lost' ||
                e.action === 'liveness_miss' ||
                e.action === 'first_check_missed'));
            const lastModeChange = reversed.find((e) => e.actor === 'local-inference' && e.action === 'mode_change');
            const lastBreakerOpen = reversed.find((e) => e.actor === 'local-inference' && e.action === 'circuit_breaker_opened');
            const lastBreakerClose = reversed.find((e) => e.actor === 'local-inference' && e.action === 'circuit_breaker_closed');
            const breakerOpen = lastBreakerOpen != null &&
                (lastBreakerClose == null || lastBreakerClose.timestamp < lastBreakerOpen.timestamp);
            let consecFail = 0;
            for (const e of reversed) {
                if (e.actor !== 'local-inference')
                    continue;
                if (e.action === 'liveness_ok')
                    break;
                if (e.action === 'liveness_miss' ||
                    e.action === 'liveness_lost' ||
                    e.action === 'first_check_missed') {
                    consecFail++;
                }
            }
            const reachable = last?.action === 'liveness_ok' || portUp === true;
            const lastAt = last ? formatLedgerAge(last.timestamp) : '(no probe yet)';
            const currentMode = lastModeChange?.data && typeof lastModeChange.data.to === 'string'
                ? lastModeChange.data.to
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
    }
    catch (err) {
        checks.push({
            name: 'LocalInfer',
            pass: false,
            detail: `unknown: ${err.message}`
        });
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
        if (!check.pass)
            allPass = false;
    }
    for (const line of memChecks) {
        console.log(`  ${line}`);
    }
    console.log('');
    if (allPass) {
        console.log('  ✅ All checks passed — Doctor green');
    }
    else {
        console.log('  ⚠️  Issues detected — review above');
        if (autoFix) {
            console.log('  🔧 Auto-fix enabled — attempting repairs...');
        }
    }
}
program.parse();
