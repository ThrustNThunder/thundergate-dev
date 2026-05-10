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
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import * as os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const THUNDERGATE_DIR = join(os.homedir(), '.thundergate');
const PID_FILE = join(THUNDERGATE_DIR, 'thundergate.pid');
const STATE_FILE = join(THUNDERGATE_DIR, 'state.json');

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
