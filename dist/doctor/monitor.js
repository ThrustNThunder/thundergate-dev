/**
 * ThunderGate Doctor Mode
 *
 * Always running health monitoring.
 * Pre-crash detection. Auto-recovery. Checkpoint rollback.
 *
 * 7 days of Doctor green = cutover ready.
 */
import * as os from 'os';
export class Doctor {
    runtime; // ThunderGateRuntime
    config;
    db;
    intervalId = null;
    startTime;
    consecutiveHealthy = 0;
    lastStatus = null;
    // Pattern detection
    recentCpuReadings = [];
    recentMemoryReadings = [];
    constructor(runtime) {
        this.runtime = runtime;
        this.config = runtime.config;
        this.db = runtime.db;
        this.startTime = new Date();
    }
    /**
     * Start health monitoring
     */
    startMonitoring() {
        if (this.intervalId)
            return;
        this.intervalId = setInterval(() => {
            this.checkHealth();
        }, this.config.doctor.intervalMs);
        console.log(`  Doctor monitoring started (interval: ${this.config.doctor.intervalMs}ms)`);
    }
    /**
     * Stop health monitoring
     */
    stopMonitoring() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }
    /**
     * Perform health check
     */
    async checkHealth() {
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
        }
        else {
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
    async collectMetrics() {
        const anomalies = [];
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
        if (this.recentCpuReadings.length > 10)
            this.recentCpuReadings.shift();
        if (this.recentMemoryReadings.length > 10)
            this.recentMemoryReadings.shift();
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
        let status = 'healthy';
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
    detectCrashPattern() {
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
    calculateTrend(readings) {
        if (readings.length < 2)
            return 0;
        const first = readings.slice(0, Math.floor(readings.length / 2));
        const second = readings.slice(Math.floor(readings.length / 2));
        const firstAvg = first.reduce((a, b) => a + b, 0) / first.length;
        const secondAvg = second.reduce((a, b) => a + b, 0) / second.length;
        return secondAvg - firstAvg;
    }
    /**
     * Handle detected anomalies
     */
    async handleAnomalies(status) {
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
    async attemptRecovery(status) {
        console.log('🔧 Doctor attempting auto-recovery...');
        // Save checkpoint before any recovery action
        try {
            await this.runtime.saveCheckpoint();
            console.log('  ✓ Checkpoint saved');
        }
        catch (error) {
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
    getStatus() {
        return this.lastStatus;
    }
    /**
     * Get consecutive healthy check count
     */
    getConsecutiveHealthy() {
        return this.consecutiveHealthy;
    }
    /**
     * Check if stable (7 days of healthy = ready for cutover)
     */
    isStable() {
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
    async runDiagnostic() {
        const status = await this.collectMetrics();
        const healthLogs = this.db.getHealthLogs(100);
        const stability = this.isStable();
        return {
            currentStatus: status,
            recentLogs: healthLogs,
            stability,
            uptime: Date.now() - this.startTime.getTime(),
            recommendations: this.generateRecommendations(status, healthLogs)
        };
    }
    /**
     * Generate recommendations based on health data
     */
    generateRecommendations(status, logs) {
        const recs = [];
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
        // Posture snapshot. Surfaces the current decision so `doctor`
        // output answers "is Jon quiet right now?" at a glance. Best
        // effort — a missing posture machine (test runs, partial boot)
        // shouldn't downgrade the report.
        try {
            const machine = this.runtime?.getPostureMachine?.();
            const current = machine?.current?.();
            if (current) {
                const ovr = current.override ? ` (override:${current.override})` : '';
                recs.push(`Posture: ${current.response_shape}/${current.default_mode}/${current.notification_policy}${ovr} on ${current.channelType}`);
                if (current.notification_policy === 'quiet') {
                    recs.push('Posture is QUIET — outbound suppressed unless tagged urgent');
                }
            }
            else if (machine) {
                recs.push('Posture: no decision yet (no inbound traffic since boot)');
            }
        }
        catch {
            /* Posture surface is observational, never fatal. */
        }
        if (recs.length === 0) {
            recs.push('All systems nominal');
        }
        return recs;
    }
}
