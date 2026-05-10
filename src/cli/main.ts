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
import { existsSync, readFileSync, writeFileSync, unlinkSync, createReadStream, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import { createInterface } from 'readline';
import * as os from 'os';
import { ensureConfig, validateConfig, getConfigPath } from '../config/index.js';
import { GhostEvaluator } from '../ghost/evaluator.js';

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
  .action((opts) => {
    if (opts.watch) {
      console.log('⚡ ThunderGate Doctor — Live Monitoring');
      console.log('Press Ctrl+C to stop\n');

      const runCheck = () => {
        console.clear();
        runDiagnostic(opts.fix);
        console.log('\nNext check in 30s...');
      };

      runCheck();
      setInterval(runCheck, 30000);
    } else {
      runDiagnostic(opts.fix);
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
    console.log(`  OpenClaw session:  ${cfg.ghost.openclaw_session}`);
    console.log(`  Log file:          ${cfg.ghost.log_file}`);
    if (existsSync(cfg.ghost.log_file)) {
      const size = statSync(cfg.ghost.log_file).size;
      console.log(`  Log size:          ${(size / 1024).toFixed(1)} KB`);
    } else {
      console.log('  Log size:          (no log yet)');
    }

    const evaluator = new GhostEvaluator(cfg);
    const scores = await evaluator.computeScores();
    console.log('');
    console.log(`  Consecutive clean days: ${scores.consecutive_clean_days}`);
    console.log(`  Cutover ready: ${scores.consecutive_clean_days >= 7 ? '🏆 YES' : `${7 - scores.consecutive_clean_days} more clean days needed`}`);
    console.log('');
    console.log('  Recent days (newest first):');
    if (scores.days.length === 0) {
      console.log('    (no data)');
    } else {
      for (const day of scores.days.slice(0, 7)) {
        const icon = day.status === 'green' ? '✅' : day.status === 'yellow' ? '⚠️ ' : '❌';
        console.log(`    ${icon} ${day.date}  samples=${day.samples}  match=${(day.match_rate * 100).toFixed(0)}%  err=${(day.error_rate * 100).toFixed(0)}%  med_lat=${day.median_latency_ms}ms`);
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

function runDiagnostic(autoFix: boolean = false): void {
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

  // Display results
  let allPass = true;
  for (const check of checks) {
    const icon = check.pass ? '✅' : '❌';
    console.log(`  ${icon} ${check.name.padEnd(12)} ${check.detail}`);
    if (!check.pass) allPass = false;
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

program.parse();
