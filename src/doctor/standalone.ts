/**
 * ThunderGate Doctor — Standalone Health Check
 *
 * Runs independently of the runtime.
 * Called by: thundergate doctor / thundergate doctor --watch
 *
 * Exit codes:
 *   0 = all healthy
 *   1 = issues detected
 */

import { existsSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { loadCheckpoint } from '../checkpoint/save.js';
import { ensureConfig } from '../config/index.js';
import { GhostEvaluator } from '../ghost/evaluator.js';

const THUNDERGATE_DIR = join(os.homedir(), '.thundergate');
const PID_FILE = join(THUNDERGATE_DIR, 'thundergate.pid');
const CHECKPOINT_FILE = join(THUNDERGATE_DIR, 'checkpoint.json');
const DB_FILE = join(THUNDERGATE_DIR, 'context.db');

export interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

export interface HealthReport {
  timestamp: string;
  overallStatus: 'healthy' | 'warning' | 'critical';
  checks: HealthCheck[];
  uptime: string;
  checkpoint: { age: string; tokens: number } | null;
  consecutiveHealthy: number;
  recommendations: string[];
}

/**
 * Run full health diagnostic
 */
export function runHealthCheck(): HealthReport {
  const checks: HealthCheck[] = [];

  // 1. Runtime process
  checks.push(checkRuntime());

  // 2. CPU usage
  checks.push(checkCpu());

  // 3. Memory
  checks.push(checkMemory());

  // 4. Disk space
  checks.push(checkDisk());

  // 5. Database
  checks.push(checkDatabase());

  // 6. Checkpoint
  checks.push(checkCheckpoint());

  // 7. CLI Jon
  checks.push(checkCliJon());

  // 8. Node version
  checks.push(checkNodeVersion());

  // 9. ThunderCommo channel
  checks.push(checkThunderCommo());

  // 10. Ghost mode (truth-telling — never fakes a green when missing data)
  checks.push(checkGhost());

  // Calculate overall status
  const hasFailures = checks.some(c => c.status === 'fail');
  const hasWarnings = checks.some(c => c.status === 'warn');
  const overallStatus = hasFailures ? 'critical' : hasWarnings ? 'warning' : 'healthy';

  // Load checkpoint info
  const checkpoint = loadCheckpoint();
  const checkpointInfo = checkpoint ? {
    age: formatAge(new Date(checkpoint.savedAt).getTime()),
    tokens: checkpoint.contextTokenEstimate
  } : null;

  return {
    timestamp: new Date().toISOString(),
    overallStatus,
    checks,
    uptime: getUptime(),
    checkpoint: checkpointInfo,
    consecutiveHealthy: checkpoint?.consecutiveHealthyChecks || 0,
    recommendations: generateRecommendations(checks)
  };
}

/**
 * Print health report to console
 */
export function printHealthReport(report: HealthReport, compact: boolean = false): void {
  if (!compact) {
    console.log(`⚡ ThunderGate Doctor — ${new Date(report.timestamp).toLocaleString()}`);
    console.log('═══════════════════════════════════════════════════');
  }

  for (const check of report.checks) {
    const icon = check.status === 'pass' ? '✅' : check.status === 'warn' ? '⚠️ ' : '❌';
    console.log(`  ${icon} ${check.name.padEnd(16)} ${check.detail}`);
    if (check.fix && check.status !== 'pass') {
      console.log(`     Fix: ${check.fix}`);
    }
  }

  console.log('');

  // Checkpoint info
  if (report.checkpoint) {
    console.log(`  📦 Checkpoint: ${report.checkpoint.tokens} tokens, ${report.checkpoint.age} old`);
    console.log(`  💚 Consecutive healthy: ${report.consecutiveHealthy} checks`);
    const daysHealthy = (report.consecutiveHealthy * 30000) / (24 * 3600000);
    if (daysHealthy < 7) {
      console.log(`  🎯 Cutover ready in: ${(7 - daysHealthy).toFixed(1)} more days`);
    } else {
      console.log(`  🏆 CUTOVER READY — 7+ days clean!`);
    }
  }

  console.log('');

  // Overall status
  const statusIcon = report.overallStatus === 'healthy' ? '✅' : report.overallStatus === 'warning' ? '⚠️ ' : '❌';
  console.log(`  ${statusIcon} Overall: ${report.overallStatus.toUpperCase()}`);

  // Recommendations
  if (report.recommendations.length > 0) {
    console.log('');
    console.log('  Recommendations:');
    for (const rec of report.recommendations) {
      console.log(`    → ${rec}`);
    }
  }
}

// ── Individual checks ──────────────────────────────────────────────────────

function checkRuntime(): HealthCheck {
  if (!existsSync(PID_FILE)) {
    return { name: 'Runtime', status: 'warn', detail: 'Not running', fix: 'thundergate start' };
  }

  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim());
    process.kill(pid, 0);
    return { name: 'Runtime', status: 'pass', detail: `Running (PID ${pid})` };
  } catch {
    return { name: 'Runtime', status: 'fail', detail: 'Stale PID file', fix: 'thundergate start' };
  }
}

function checkCpu(): HealthCheck {
  const cpus = os.cpus();
  const usage = cpus.reduce((acc, cpu) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    return acc + ((total - cpu.times.idle) / total) * 100;
  }, 0) / cpus.length;

  if (usage > 90) {
    return { name: 'CPU', status: 'fail', detail: `${usage.toFixed(1)}% — CRITICAL`, fix: 'Check for runaway processes' };
  }
  if (usage > 70) {
    return { name: 'CPU', status: 'warn', detail: `${usage.toFixed(1)}% — High` };
  }
  return { name: 'CPU', status: 'pass', detail: `${usage.toFixed(1)}%` };
}

function checkMemory(): HealthCheck {
  const total = os.totalmem();
  const free = os.freemem();
  const usedMb = (total - free) / (1024 * 1024);
  const totalMb = total / (1024 * 1024);
  const pct = (usedMb / totalMb * 100).toFixed(0);

  if (usedMb > 1500) {
    return { name: 'Memory', status: 'fail', detail: `${usedMb.toFixed(0)}MB / ${totalMb.toFixed(0)}MB (${pct}%) — HIGH` };
  }
  if (usedMb > 1000) {
    return { name: 'Memory', status: 'warn', detail: `${usedMb.toFixed(0)}MB / ${totalMb.toFixed(0)}MB (${pct}%)` };
  }
  return { name: 'Memory', status: 'pass', detail: `${usedMb.toFixed(0)}MB / ${totalMb.toFixed(0)}MB (${pct}%)` };
}

function checkDisk(): HealthCheck {
  try {
    const result = execSync("df -h / | tail -1 | awk '{print $5, $4}'", { encoding: 'utf-8' }).trim();
    const [pctStr, available] = result.split(' ');
    const pct = parseInt(pctStr);

    if (pct > 90) {
      return { name: 'Disk', status: 'fail', detail: `${pct}% used, ${available} free — CRITICAL`, fix: 'Free up disk space' };
    }
    if (pct > 80) {
      return { name: 'Disk', status: 'warn', detail: `${pct}% used, ${available} free` };
    }
    return { name: 'Disk', status: 'pass', detail: `${pct}% used, ${available} free` };
  } catch {
    return { name: 'Disk', status: 'warn', detail: 'Could not check disk' };
  }
}

function checkDatabase(): HealthCheck {
  if (!existsSync(DB_FILE)) {
    return { name: 'Database', status: 'warn', detail: 'context.db not found', fix: 'thundergate start (creates DB)' };
  }

  const stat = statSync(DB_FILE);
  const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
  return { name: 'Database', status: 'pass', detail: `context.db (${sizeMb}MB)` };
}

function checkCheckpoint(): HealthCheck {
  if (!existsSync(CHECKPOINT_FILE)) {
    return { name: 'Checkpoint', status: 'warn', detail: 'No checkpoint saved yet', fix: 'thundergate start' };
  }

  const stat = statSync(CHECKPOINT_FILE);
  const ageMs = Date.now() - stat.mtimeMs;
  const ageHours = ageMs / 3600000;

  if (ageHours > 25) {
    return { name: 'Checkpoint', status: 'warn', detail: `${formatAge(stat.mtimeMs)} old — stale` };
  }
  return { name: 'Checkpoint', status: 'pass', detail: `Saved ${formatAge(stat.mtimeMs)} ago` };
}

function checkCliJon(): HealthCheck {
  const cliPath = '/home/ubuntu/.npm-global/bin/claude';
  if (!existsSync(cliPath)) {
    return { name: 'CLI Jon', status: 'warn', detail: 'Not installed', fix: 'npm install -g @anthropic-ai/claude-code' };
  }

  try {
    const version = execSync(`${cliPath} --version 2>/dev/null`, { encoding: 'utf-8' }).trim();
    return { name: 'CLI Jon', status: 'pass', detail: `${version} ✅` };
  } catch {
    return { name: 'CLI Jon', status: 'warn', detail: 'Installed but not responding' };
  }
}

function checkNodeVersion(): HealthCheck {
  const major = parseInt(process.version.slice(1).split('.')[0]);
  if (major < 18) {
    return { name: 'Node.js', status: 'fail', detail: `${process.version} — Need 18+`, fix: 'nvm install 20' };
  }
  return { name: 'Node.js', status: 'pass', detail: process.version };
}

function checkThunderCommo(): HealthCheck {
  let port: number | null = null;
  try {
    const cfg = ensureConfig();
    if (!cfg.channels.thundercommo.enabled) {
      return { name: 'ThunderCommo', status: 'pass', detail: 'disabled in config' };
    }
    port = cfg.channels.thundercommo.port ?? 8765;
  } catch (err) {
    return { name: 'ThunderCommo', status: 'warn', detail: `config error: ${(err as Error).message}` };
  }

  const open = portOpen(port);
  if (!open) {
    return {
      name: 'ThunderCommo',
      status: existsSync(PID_FILE) ? 'fail' : 'warn',
      detail: `port ${port} not listening`,
      fix: 'thundergate start'
    };
  }
  return { name: 'ThunderCommo', status: 'pass', detail: `listening on ${port}` };
}

function checkGhost(): HealthCheck {
  let cfg;
  try {
    cfg = ensureConfig();
  } catch (err) {
    return { name: 'Ghost mode', status: 'warn', detail: `config error: ${(err as Error).message}` };
  }
  if (!cfg.ghost.enabled) {
    return { name: 'Ghost mode', status: 'pass', detail: 'stopped (ghost.enabled=false)' };
  }
  const evaluator = new GhostEvaluator(cfg);
  const scores = evaluator.loadScores();
  const days = scores?.consecutive_clean_days ?? 0;
  const detail = `running, ${days} clean days${days >= 7 ? ' — CUTOVER READY' : ''}`;
  // Truthful: ghost log missing while enabled = warn, not pass.
  if (!existsSync(cfg.ghost.log_file)) {
    return { name: 'Ghost mode', status: 'warn', detail: `${detail} (no log yet)` };
  }
  return { name: 'Ghost mode', status: days >= 7 ? 'pass' : 'pass', detail };
}

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

// ── Helpers ────────────────────────────────────────────────────────────────

function formatAge(timestamp: number): string {
  const ms = Date.now() - timestamp;
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);

  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function getUptime(): string {
  const seconds = os.uptime();
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function generateRecommendations(checks: HealthCheck[]): string[] {
  const recs: string[] = [];

  const failed = checks.filter(c => c.status === 'fail');
  const warned = checks.filter(c => c.status === 'warn');

  if (failed.length === 0 && warned.length === 0) {
    return ['All systems nominal — Doctor green'];
  }

  for (const check of [...failed, ...warned]) {
    if (check.fix) recs.push(check.fix);
  }

  return recs;
}
