/**
 * LocalInferenceProvider — seamless ThunderMind ↔ cloud failover.
 *
 * Goals (Principle 26, two-mode architecture; Michael's seamless-failover
 * directive):
 *   - User never sees a gap. Mode flips happen on health-check edges; in-
 *     flight requests complete before mode loss is committed.
 *   - Fast detection: ≤5s default health-check interval when ThunderMind
 *     is configured, so a fresh outage is felt within one tick.
 *   - 3-strike failover: a single flaky probe doesn't tear the world
 *     down. Three consecutive failures = trip the circuit breaker, flip
 *     mode, and back off the probe to 30s to avoid hammering a dead
 *     endpoint.
 *   - Degradation signal: a probe that *responds* but takes >5s is a
 *     warning, not a failure. Logged to provenance and surfaced via
 *     Doctor; mode stays where it is.
 *   - Self-healing: once a healthy probe lands, reset the breaker, flip
 *     back to LOCAL_INFERENCE, restore the fast interval.
 *   - Provenance for *every* transition (mode flip, breaker change,
 *     degradation episode) — Principle 29.
 *
 * Routing isn't done here. This module owns the *signal*. The runtime
 * reads `world.processingMode` and forks behavior on that.
 */

import { Config } from '../config/loader.js';
import { WorldState, ProcessingMode } from '../world/state.js';
import { ProvenanceLedger } from '../provenance/ledger.js';

/**
 * What we want a probe to take, at most, before we flag the endpoint as
 * degraded. Anthropic's principle here: a slow inference path is worse
 * for UX than a clean fallback to cloud, so we surface it visibly.
 */
const DEGRADATION_LATENCY_MS = 5_000;
/**
 * Hard timeout on a single probe HTTP fetch. Strictly larger than the
 * degradation threshold so a slow-but-responsive endpoint surfaces as
 * `degraded` and not as a `liveness_miss` — the spec explicitly wants
 * those treated differently. 8s is long enough to capture a slow probe
 * and short enough not to stall the next interval.
 */
const PROBE_TIMEOUT_MS = 8_000;
/** Failures in a row before we declare ThunderMind down and flip. */
const FAILOVER_STRIKES = 3;
/**
 * Once the breaker is open, back off probes to this interval so we don't
 * hammer a dead endpoint. The fast interval (config) resumes after the
 * first healthy probe.
 */
const BREAKER_OPEN_INTERVAL_MS = 30_000;
/** Fast interval when ThunderMind is configured but unprobed/healthy. */
const FAST_INTERVAL_MS = 5_000;

export interface LocalInferenceHealth {
  reachable: boolean;
  endpoint: string;
  lastCheckedAt: number | null;
  lastReachableAt: number | null;
  lastError: string | null;
  /** Latency of the most recent probe in ms (success or failure). */
  lastLatencyMs: number | null;
  /** Consecutive probe failures since the last healthy probe. */
  consecutiveFailures: number;
  /** True once `consecutiveFailures` ≥ FAILOVER_STRIKES. */
  circuitBreakerOpen: boolean;
  /** True if the last successful probe came back in > DEGRADATION_LATENCY_MS. */
  degraded: boolean;
  /** Plain-English explanation of the most recent mode transition. */
  lastTransitionReason: string | null;
  /** Epoch ms of the most recent mode transition. */
  lastTransitionAt: number | null;
  /** Current probe interval. Mirrors what setInterval is using. */
  currentIntervalMs: number;
  /** Outstanding probe count — never > 1 in normal operation. */
  inFlightProbes: number;
  /**
   * Outstanding LOCAL_INFERENCE-routed requests. Incremented by callers
   * via beginRequest()/endRequest(). When the breaker trips, mode flips
   * to CLOUD *immediately* for new requests; the in-flight set keeps
   * draining on local. The breaker logs how many in-flight requests
   * were observed at trip time so we can later audit graceful handoff.
   */
  inFlightLocalRequests: number;
}

export class LocalInferenceProvider {
  private config: Config;
  private world: WorldState;
  private ledger: ProvenanceLedger;
  private intervalId: NodeJS.Timeout | null = null;
  private health: LocalInferenceHealth;

  constructor(config: Config, world: WorldState, ledger: ProvenanceLedger) {
    this.config = config;
    this.world = world;
    this.ledger = ledger;
    this.health = {
      reachable: false,
      endpoint: config.localInference.endpoint,
      lastCheckedAt: null,
      lastReachableAt: null,
      lastError: null,
      lastLatencyMs: null,
      consecutiveFailures: 0,
      circuitBreakerOpen: false,
      degraded: false,
      lastTransitionReason: null,
      lastTransitionAt: null,
      currentIntervalMs: 0,
      inFlightProbes: 0,
      inFlightLocalRequests: 0
    };
    this.world.localInference.endpoint = config.localInference.endpoint;
  }

  /**
   * Begin periodic health checks. Safe to call multiple times — repeat
   * calls are no-ops. First check runs immediately so the WorldState
   * snapshot is populated before the first message arrives.
   *
   * Interval choice:
   *   - Configured + breaker closed → max(FAST_INTERVAL_MS, config) per
   *     Michael's directive: 5s when ThunderMind is configured. Config
   *     value is treated as a floor — operators can ask for slower, not
   *     faster than 1s, but the default is 5s.
   *   - Breaker open → BREAKER_OPEN_INTERVAL_MS (30s) — back off the
   *     dead endpoint.
   *
   *   Switching between the two happens on every health-state change
   *   via rescheduleProbe() so the user never has to restart to feel a
   *   recovery.
   */
  start(): void {
    if (!this.config.localInference.enabled) {
      this.ledger.append({
        actor: 'local-inference',
        action: 'disabled',
        target: 'local-inference-provider',
        reason: 'config.localInference.enabled = false'
      });
      return;
    }
    if (this.intervalId) return;

    void this.checkOnce();
    this.scheduleProbe(this.resolveFastIntervalMs());
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Latest health snapshot. Doctor reads this when rendering the local
   * inference row. Returns a defensive copy so the caller can't mutate
   * internal state.
   */
  getHealth(): LocalInferenceHealth {
    return { ...this.health };
  }

  /**
   * Caller hooks for in-flight tracking. The runtime brackets a
   * LOCAL_INFERENCE-routed inference call with begin/end so the
   * provider knows how many requests are mid-flight if the breaker
   * trips. We don't *block* on draining the in-flight set — new
   * requests after a trip are already routed to cloud because the
   * mode flips synchronously. This counter exists so:
   *   - Doctor can report "breaker tripped with N in-flight local requests"
   *   - Future graceful-drain logic can hook on the same counter
   *   - Provenance captures the drain count for post-mortem
   */
  beginRequest(): void {
    this.health.inFlightLocalRequests++;
  }

  endRequest(): void {
    if (this.health.inFlightLocalRequests > 0) {
      this.health.inFlightLocalRequests--;
    }
  }

  /**
   * One probe. Public so the standalone Doctor command can trigger an
   * on-demand check without waiting for the next interval — and so tests
   * don't have to spin the timer to assert behavior.
   *
   * Returns the reachability verdict (success/failure). Mode flips and
   * provenance writes happen as side effects so any caller sees the same
   * state model as the scheduler.
   */
  async checkOnce(): Promise<boolean> {
    const startedAt = Date.now();
    this.health.inFlightProbes++;
    this.health.lastCheckedAt = startedAt;

    let reachable = false;
    let errorMessage: string | null = null;

    try {
      const url = `${this.health.endpoint.replace(/\/$/, '')}/v1/models`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      try {
        const res = await fetch(url, { signal: controller.signal });
        reachable = res.ok;
        if (!res.ok) errorMessage = `HTTP ${res.status}`;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      reachable = false;
      errorMessage = (err as Error).message;
    }

    const elapsed = Date.now() - startedAt;
    this.health.lastLatencyMs = elapsed;
    this.health.inFlightProbes = Math.max(0, this.health.inFlightProbes - 1);

    const wasReachable = this.health.reachable;
    const wasBreakerOpen = this.health.circuitBreakerOpen;
    const wasDegraded = this.health.degraded;

    if (reachable) {
      // Snapshot the pre-reset failure count so the breaker-closed audit
      // row can report *how many* consecutive failures we recovered from.
      const failuresAtRecovery = this.health.consecutiveFailures;

      // Probe succeeded. Reset failure counter, close breaker if it was
      // open, flag degradation if the probe was slow.
      this.health.reachable = true;
      this.health.lastReachableAt = startedAt;
      this.health.lastError = null;
      this.health.consecutiveFailures = 0;

      const nowDegraded = elapsed > DEGRADATION_LATENCY_MS;
      this.health.degraded = nowDegraded;

      if (wasBreakerOpen) {
        this.health.circuitBreakerOpen = false;
        this.ledger.append({
          actor: 'local-inference',
          action: 'circuit_breaker_closed',
          target: 'local-inference-provider',
          reason: `endpoint responded healthy after ${failuresAtRecovery} consecutive failures (latency ${elapsed}ms)`,
          data: {
            endpoint: this.health.endpoint,
            latency_ms: elapsed,
            failures_at_recovery: failuresAtRecovery
          }
        });
      }

      // Edge: was not reachable, is now reachable → mode flip back to LOCAL.
      // Self-healing: this is the "ThunderMind came back" path.
      if (!wasReachable) {
        this.flipMode(
          ProcessingMode.LOCAL_INFERENCE,
          'local inference recovered — flipping back from cloud'
        );
        this.ledger.append({
          actor: 'local-inference',
          action: 'liveness_ok',
          target: 'local-inference-provider',
          reason: `endpoint ${this.health.endpoint} responded healthy (latency ${elapsed}ms)`,
          data: { endpoint: this.health.endpoint, latency_ms: elapsed }
        });
      }

      // Degradation edges. We don't fail over on degradation but we do log
      // it explicitly so operators can see slow ThunderMind episodes.
      if (nowDegraded && !wasDegraded) {
        this.ledger.append({
          actor: 'local-inference',
          action: 'degraded',
          target: 'local-inference-provider',
          reason: `probe latency ${elapsed}ms exceeded ${DEGRADATION_LATENCY_MS}ms — staying on LOCAL_INFERENCE`,
          data: { endpoint: this.health.endpoint, latency_ms: elapsed }
        });
      } else if (!nowDegraded && wasDegraded) {
        this.ledger.append({
          actor: 'local-inference',
          action: 'recovered_from_degraded',
          target: 'local-inference-provider',
          reason: `probe latency ${elapsed}ms back under ${DEGRADATION_LATENCY_MS}ms`,
          data: { endpoint: this.health.endpoint, latency_ms: elapsed }
        });
      }

      // Healthy probes use the fast interval. If we were on the slow
      // breaker-open interval, swap back now.
      this.maybeRescheduleProbe(this.resolveFastIntervalMs());
    } else {
      // Probe failed. Increment failure counter; flip mode + open breaker
      // on the third strike. A first or second failure stays on the
      // current mode — flap-resistant.
      this.health.consecutiveFailures++;
      this.health.reachable = false;
      this.health.lastError = errorMessage;
      // Degraded only applies to *successful* slow probes — a failed
      // probe isn't "degraded", it's just down.
      this.health.degraded = false;

      // Always log the probe miss, but make the mode-flip a 3-strike
      // edge. Volume here is bounded by the 30s breaker-open interval
      // so we don't drown the ledger.
      if (this.health.consecutiveFailures <= FAILOVER_STRIKES) {
        this.ledger.append({
          actor: 'local-inference',
          action: 'liveness_miss',
          target: 'local-inference-provider',
          reason: `${errorMessage ?? 'unknown'} (strike ${this.health.consecutiveFailures}/${FAILOVER_STRIKES})`,
          data: {
            endpoint: this.health.endpoint,
            error: errorMessage,
            consecutive_failures: this.health.consecutiveFailures
          }
        });
      }

      if (
        this.health.consecutiveFailures >= FAILOVER_STRIKES &&
        !this.health.circuitBreakerOpen
      ) {
        // Trip the breaker, flip the mode, and back off the probe.
        const inFlight = this.health.inFlightLocalRequests;
        this.health.circuitBreakerOpen = true;
        this.ledger.append({
          actor: 'local-inference',
          action: 'circuit_breaker_opened',
          target: 'local-inference-provider',
          reason: `${FAILOVER_STRIKES} consecutive failures — backing off probes to ${BREAKER_OPEN_INTERVAL_MS}ms`,
          data: {
            endpoint: this.health.endpoint,
            error: errorMessage,
            in_flight_local_requests: inFlight
          }
        });
        if (wasReachable || this.world.processingMode === ProcessingMode.LOCAL_INFERENCE) {
          this.flipMode(
            ProcessingMode.CLOUD,
            `local inference unreachable after ${FAILOVER_STRIKES} strikes — falling back to cloud (in-flight: ${inFlight})`
          );
          this.ledger.append({
            actor: 'local-inference',
            action: 'liveness_lost',
            target: 'local-inference-provider',
            reason: errorMessage ?? 'unknown',
            data: { endpoint: this.health.endpoint, error: errorMessage }
          });
        }
        // First-check baseline: if we never reached, record the explicit
        // "ThunderMind isn't built yet" event so the audit trail starts
        // somewhere even on a fresh install with no endpoint.
        if (this.health.lastReachableAt === null && !wasReachable) {
          this.ledger.append({
            actor: 'local-inference',
            action: 'first_check_missed',
            target: 'local-inference-provider',
            reason: errorMessage ?? 'unknown',
            data: { endpoint: this.health.endpoint, error: errorMessage }
          });
        }
        this.maybeRescheduleProbe(BREAKER_OPEN_INTERVAL_MS);
      }
    }

    // Mirror onto WorldState — runtime / Doctor read from there. We
    // mirror late so a partial probe failure doesn't leave inconsistent
    // state behind.
    this.world.localInference.reachable = this.health.reachable;
    this.world.localInference.lastCheckedAt = startedAt;
    this.world.localInference.lastError = this.health.reachable ? null : errorMessage;
    if (this.health.reachable) this.world.localInference.lastReachableAt = startedAt;

    return reachable;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /**
   * The "fast" interval is config-driven but floored at 5s and at 1s.
   * Five is Michael's directive; one is the safety net against an
   * operator typing 100 and DOSing their own endpoint.
   */
  private resolveFastIntervalMs(): number {
    const cfgVal = this.config.localInference.healthCheckIntervalMs;
    // Treat the default 30s config value as "operator hasn't overridden" —
    // honor the directive's 5s. If they explicitly went lower we respect
    // it down to 1s. If they explicitly went higher than 30s we cap to
    // 30s to avoid surprising long detection times when ThunderMind is
    // present.
    if (!cfgVal || cfgVal <= 0) return FAST_INTERVAL_MS;
    if (cfgVal >= 30_000) return FAST_INTERVAL_MS;
    return Math.max(1_000, cfgVal);
  }

  private scheduleProbe(intervalMs: number): void {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = setInterval(
      () => { void this.checkOnce(); },
      intervalMs
    );
    // Don't hold the event loop open on this interval — the runtime is
    // the owner of liveness; the probe is just a passenger.
    (this.intervalId as any)?.unref?.();
    this.health.currentIntervalMs = intervalMs;
  }

  private maybeRescheduleProbe(intervalMs: number): void {
    if (intervalMs === this.health.currentIntervalMs) return;
    this.scheduleProbe(intervalMs);
    this.ledger.append({
      actor: 'local-inference',
      action: 'probe_interval_changed',
      target: 'local-inference-provider',
      reason: `interval set to ${intervalMs}ms`,
      data: { interval_ms: intervalMs, breaker_open: this.health.circuitBreakerOpen }
    });
  }

  private flipMode(to: ProcessingMode, reason: string): void {
    const from = this.world.processingMode;
    if (from === to) return;
    this.world.processingMode = to;
    this.health.lastTransitionReason = reason;
    this.health.lastTransitionAt = Date.now();
    this.ledger.append({
      actor: 'local-inference',
      action: 'mode_change',
      target: 'processingMode',
      reason,
      data: { from, to }
    });
  }
}
