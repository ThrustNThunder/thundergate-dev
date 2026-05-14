/**
 * ThunderGate Doctor Mode
 * 
 * Always running health monitoring.
 * Pre-crash detection. Auto-recovery. Checkpoint rollback.
 * 
 * 7 days of Doctor green = cutover ready.
 */

import { SessionDB } from '../session/database.js';
import { Config } from '../config/loader.js';
import * as os from 'os';

interface HealthStatus {
  timestamp: Date;
  status: 'healthy' | 'warning' | 'critical' | 'crashed';
  cpu: number;
  memoryMb: number;
  contextTokens: number;
  anomalies: string[];
  uptime: number;
}

export class Doctor {
  private runtime: any;  // ThunderGateRuntime
  private config: Config;
  private db: SessionDB;
  private intervalId: NodeJS.Timeout | null = null;
  private startTime: Date;
  private consecutiveHealthy: number = 0;
  private lastStatus: HealthStatus | null = null;

  // Pattern detection
  private recentCpuReadings: number[] = [];
  private recentMemoryReadings: number[] = [];

  constructor(runtime: any) {
    this.runtime = runtime;
    this.config = runtime.config;
    this.db = runtime.db;
    this.startTime = new Date();
  }

  /**
   * Start health monitoring
   */
  startMonitoring(): void {
    if (this.intervalId) return;

    this.intervalId = setInterval(() => {
      this.checkHealth();
    }, this.config.doctor.intervalMs);

    console.log(`  Doctor monitoring started (interval: ${this.config.doctor.intervalMs}ms)`);
  }

  /**
   * Stop health monitoring
   */
  stopMonitoring(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Perform health check
   */
  private async checkHealth(): Promise<void> {
    const status = await this.collectMetrics();
    
    // Store in database
    this.db.logHealth({
      status: status.status,
      cpuPercent: status.cpu,
      memoryMb: status.memoryMb,
      contextTokens: status.contextTokens,
      anomaly: status.anomalies.length > 0 ? status.anomalies.join('; ') : undefined
    });

    // Track consecutive healthy checks
    if (status.status === 'healthy') {
      this.consecutiveHealthy++;
    } else {
      this.consecutiveHealthy = 0;
    }

    // Handle anomalies
    if (status.anomalies.length > 0) {
      await this.handleAnomalies(status);
    }

    this.lastStatus = status;
  }

  /**
   * Collect system metrics
   */
  private async collectMetrics(): Promise<HealthStatus> {
    const anomalies: string[] = [];
    
    // CPU usage
    const cpus = os.cpus();
    const cpuUsage = cpus.reduce((acc, cpu) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      const idle = cpu.times.idle;
      return acc + ((total - idle) / total) * 100;
    }, 0) / cpus.length;

    // Memory usage
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMemMb = (totalMem - freeMem) / (1024 * 1024);

    // Context tokens (from runtime state)
    const runtimeState = this.runtime.getState();
    const contextTokens = runtimeState.contextTokens || 0;

    // Track readings for pattern detection
    this.recentCpuReadings.push(cpuUsage);
    this.recentMemoryReadings.push(usedMemMb);
    
    // Keep last 10 readings
    if (this.recentCpuReadings.length > 10) this.recentCpuReadings.shift();
    if (this.recentMemoryReadings.length > 10) this.recentMemoryReadings.shift();

    // Check thresholds
    const thresholds = this.config.doctor.alertThresholds;

    if (cpuUsage > thresholds.cpuPercent) {
      anomalies.push(`CPU high: ${cpuUsage.toFixed(1)}%`);
    }

    if (usedMemMb > thresholds.memoryMb) {
      anomalies.push(`Memory high: ${usedMemMb.toFixed(0)}MB`);
    }

    if (contextTokens > thresholds.contextTokens) {
      anomalies.push(`Context tokens high: ${contextTokens}`);
    }

    // Pattern detection (like 2026.4.26 incident)
    const crashPattern = this.detectCrashPattern();
    if (crashPattern) {
      anomalies.push(crashPattern);
    }

    // Determine overall status
    let status: HealthStatus['status'] = 'healthy';
    if (anomalies.length > 0) {
      status = anomalies.some(a => a.includes('CRITICAL')) ? 'critical' : 'warning';
    }

    return {
      timestamp: new Date(),
      status,
      cpu: cpuUsage,
      memoryMb: usedMemMb,
      contextTokens,
      anomalies,
      uptime: Date.now() - this.startTime.getTime()
    };
  }

  /**
   * Detect crash patterns before they happen
   */
  private detectCrashPattern(): string | null {
    // Pattern: CPU and memory both climbing rapidly
    if (this.recentCpuReadings.length >= 5 && this.recentMemoryReadings.length >= 5) {
      const cpuTrend = this.calculateTrend(this.recentCpuReadings);
      const memTrend = this.calculateTrend(this.recentMemoryReadings);

      // Both climbing rapidly = potential runaway
      if (cpuTrend > 5 && memTrend > 50) {
        return 'CRITICAL: Runaway pattern detected (CPU and memory climbing rapidly)';
      }

      // CPU stuck high = potential infinite loop
      const avgCpu = this.recentCpuReadings.reduce((a, b) => a + b, 0) / this.recentCpuReadings.length;
      if (avgCpu > 90 && cpuTrend < 1) {
        return 'CRITICAL: CPU stuck high (potential infinite loop)';
      }
    }

    return null;
  }

  /**
   * Calculate trend (positive = increasing)
   */
  private calculateTrend(readings: number[]): number {
    if (readings.length < 2) return 0;
    
    const first = readings.slice(0, Math.floor(readings.length / 2));
    const second = readings.slice(Math.floor(readings.length / 2));
    
    const firstAvg = first.reduce((a, b) => a + b, 0) / first.length;
    const secondAvg = second.reduce((a, b) => a + b, 0) / second.length;
    
    return secondAvg - firstAvg;
  }

  /**
   * Handle detected anomalies
   */
  private async handleAnomalies(status: HealthStatus): Promise<void> {
    console.warn(`⚠️ Doctor detected anomalies:`, status.anomalies);

    // Log to database
    this.db.logHealth({
      status: status.status,
      cpuPercent: status.cpu,
      memoryMb: status.memoryMb,
      contextTokens: status.contextTokens,
      anomaly: status.anomalies.join('; '),
      actionTaken: this.config.doctor.autoRecover ? 'auto-recovery attempted' : 'alert only'
    });

    // Auto-recover if enabled
    if (this.config.doctor.autoRecover && status.status === 'critical') {
      await this.attemptRecovery(status);
    }

    // TODO: Alert Michael via ThunderCommo
  }

  /**
   * Attempt automatic recovery
   */
  private async attemptRecovery(status: HealthStatus): Promise<void> {
    console.log('🔧 Doctor attempting auto-recovery...');

    // Save checkpoint before any recovery action
    try {
      await this.runtime.saveCheckpoint();
      console.log('  ✓ Checkpoint saved');
    } catch (error) {
      console.error('  ✗ Checkpoint save failed:', error);
    }

    // Context too large → force compaction
    if (status.anomalies.some(a => a.includes('Context tokens'))) {
      console.log('  → Triggering forced compaction');
      // TODO: Implement forced compaction
    }

    // Memory pressure → clear caches
    if (status.anomalies.some(a => a.includes('Memory high'))) {
      console.log('  → Clearing non-essential caches');
      // TODO: Implement cache clearing
    }

    // Runaway pattern → controlled restart
    if (status.anomalies.some(a => a.includes('Runaway pattern'))) {
      console.log('  → Initiating controlled restart');
      // TODO: Implement controlled restart with checkpoint recovery
    }
  }

  /**
   * Get current health status
   */
  getStatus(): HealthStatus | null {
    return this.lastStatus;
  }

  /**
   * Get consecutive healthy check count
   */
  getConsecutiveHealthy(): number {
    return this.consecutiveHealthy;
  }

  /**
   * Check if stable (7 days of healthy = ready for cutover)
   */
  isStable(): { stable: boolean; healthyDays: number } {
    // Assuming checks every 30 seconds, 7 days = 20160 checks
    const checksPerDay = (24 * 60 * 60 * 1000) / this.config.doctor.intervalMs;
    const healthyDays = this.consecutiveHealthy / checksPerDay;
    
    return {
      stable: healthyDays >= 7,
      healthyDays
    };
  }

  /**
   * Run full diagnostic (thundergate doctor command)
   */
  async runDiagnostic(): Promise<DiagnosticReport> {
    const status = await this.collectMetrics();
    const healthLogs = this.db.getHealthLogs(100);
    const stability = this.isStable();

    return {
      currentStatus: status,
      recentLogs: healthLogs,
      stability,
      uptime: Date.now() - this.startTime.getTime(),
      recommendations: this.generateRecommendations(status, healthLogs),
      browser: this.browserSnapshot()
    };
  }

  /**
   * Pull the BrowserBridge surface for the doctor report. Read-only —
   * we never block the diagnostic on bridge availability and degrade to
   * `listening: false / connected: false` if the runtime hasn't wired
   * the bridge yet (or it failed to bind).
   */
  private browserSnapshot(): BrowserDiagnostic {
    const bridge: any = typeof this.runtime?.getBrowser === 'function' ? this.runtime.getBrowser() : null;
    const world: any = typeof this.runtime?.getWorldState === 'function' ? this.runtime.getWorldState() : null;
    const stats = bridge?.getStats?.() ?? null;
    return {
      listening: stats?.listening === true,
      connected: stats?.connected === true,
      port: stats?.port ?? null,
      currentUrl: world?.browserCurrentUrl ?? '',
      portalState: world?.browserPortalState ?? null,
      lastActionAt: world?.browserLastActionAt ?? null,
      pendingCommands: stats?.pending ?? 0
    };
  }

  /**
   * Generate recommendations based on health data
   */
  private generateRecommendations(status: HealthStatus, logs: any[]): string[] {
    const recs: string[] = [];

    if (status.cpu > 70) {
      recs.push('Consider reducing model complexity or enabling supersaver mode');
    }

    if (status.memoryMb > 1000) {
      recs.push('Memory usage elevated — review cache settings');
    }

    if (status.contextTokens > 500000) {
      recs.push('Context approaching limit — compaction recommended');
    }

    const recentAnomalies = logs.filter(l => l.anomaly).length;
    if (recentAnomalies > 5) {
      recs.push(`${recentAnomalies} anomalies in recent history — review logs`);
    }

    if (recs.length === 0) {
      recs.push('All systems nominal');
    }

    return recs;
  }
}

// Types
interface DiagnosticReport {
  currentStatus: HealthStatus;
  recentLogs: any[];
  stability: { stable: boolean; healthyDays: number };
  uptime: number;
  recommendations: string[];
  browser: BrowserDiagnostic;
}

interface BrowserDiagnostic {
  listening: boolean;
  connected: boolean;
  port: number | null;
  currentUrl: string;
  portalState: string | null;
  lastActionAt: number | null;
  pendingCommands: number;
}
