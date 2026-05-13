/**
 * LocalInferenceProvider — health-checks a local Ollama-style endpoint.
 *
 * Design point from Michael: when a 70B / local inference endpoint is
 * reachable, the runtime should swap to a more aggressive processing
 * algorithm — longer context, deeper RAG, background pre-processing,
 * no cost-conservation. When it's NOT reachable, we stay on the current
 * cloud-optimized path.
 *
 * This module is the liveness probe. It does NOT route LLM calls (that
 * comes later, once ThunderMind exists and we know its exact API surface
 * — the OpenAI-compatible `/v1/models` and `/v1/chat/completions` is the
 * assumption, since Ollama exposes both). For now we ping `/v1/models`
 * because it's the cheapest signal that "something OpenAI-compatible is
 * listening and willing to talk".
 *
 * Reachability transitions write rows to the provenance ledger so the
 * gateway has an auditable record of when local inference came/went —
 * critical because the *next* generation of features (mode-flip logic,
 * background pre-processing) all depend on this signal being correct.
 */

import { Config } from '../config/loader.js';
import { WorldState, ProcessingMode } from '../world/state.js';
import { ProvenanceLedger } from '../provenance/ledger.js';

export interface LocalInferenceHealth {
  reachable: boolean;
  endpoint: string;
  lastCheckedAt: number | null;
  lastReachableAt: number | null;
  lastError: string | null;
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
      lastError: null
    };
    this.world.localInference.endpoint = config.localInference.endpoint;
  }

  /**
   * Begin periodic health checks. Safe to call multiple times — repeat
   * calls are no-ops. First check runs immediately so the WorldState
   * snapshot is populated before the first message arrives.
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
    this.intervalId = setInterval(
      () => { void this.checkOnce(); },
      Math.max(1000, this.config.localInference.healthCheckIntervalMs)
    );
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Latest health snapshot. Doctor reads this when rendering the local
   * inference row.
   */
  getHealth(): LocalInferenceHealth {
    return { ...this.health };
  }

  /**
   * One probe. Public so the standalone Doctor command can trigger an
   * on-demand check without waiting for the next interval — and so tests
   * don't have to spin the timer to assert behavior.
   */
  async checkOnce(): Promise<boolean> {
    const now = Date.now();
    this.health.lastCheckedAt = now;

    let reachable = false;
    let errorMessage: string | null = null;

    try {
      const url = `${this.health.endpoint.replace(/\/$/, '')}/v1/models`;
      // 2s timeout is deliberately tight: a slow probe blocks the message
      // path indirectly by serializing on the next mode-decision.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
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

    const wasReachable = this.health.reachable;
    this.health.reachable = reachable;
    this.health.lastError = reachable ? null : errorMessage;
    if (reachable) this.health.lastReachableAt = now;

    // Mirror onto WorldState — runtime / Doctor read from there.
    this.world.localInference.reachable = reachable;
    this.world.localInference.lastCheckedAt = now;
    this.world.localInference.lastError = reachable ? null : errorMessage;
    if (reachable) this.world.localInference.lastReachableAt = now;

    // Mode transition: only write provenance + flip mode on EDGE, not
    // every successful poll. Otherwise the ledger fills up with noise.
    if (reachable !== wasReachable) {
      if (reachable) {
        this.world.processingMode = ProcessingMode.LOCAL_INFERENCE;
        this.ledger.append({
          actor: 'local-inference',
          action: 'liveness_ok',
          target: 'local-inference-provider',
          reason: `endpoint ${this.health.endpoint} responded healthy`,
          data: { endpoint: this.health.endpoint }
        });
        this.ledger.append({
          actor: 'local-inference',
          action: 'mode_change',
          target: 'processingMode',
          reason: 'local inference became reachable',
          data: { from: ProcessingMode.CLOUD, to: ProcessingMode.LOCAL_INFERENCE }
        });
      } else {
        this.world.processingMode = ProcessingMode.CLOUD;
        this.ledger.append({
          actor: 'local-inference',
          action: 'liveness_lost',
          target: 'local-inference-provider',
          reason: errorMessage ?? 'unknown',
          data: { endpoint: this.health.endpoint, error: errorMessage }
        });
        this.ledger.append({
          actor: 'local-inference',
          action: 'mode_change',
          target: 'processingMode',
          reason: 'falling back to cloud — local inference unreachable',
          data: { from: ProcessingMode.LOCAL_INFERENCE, to: ProcessingMode.CLOUD }
        });
      }
    } else if (this.health.lastCheckedAt === now && !reachable && wasReachable === false && this.health.lastReachableAt === null) {
      // First-ever probe, miss. Record once — useful for the "ThunderMind
      // isn't built yet" baseline so an operator can grep `disabled` /
      // `first_check_missed` and explain the empty state.
      this.ledger.append({
        actor: 'local-inference',
        action: 'first_check_missed',
        target: 'local-inference-provider',
        reason: errorMessage ?? 'unknown',
        data: { endpoint: this.health.endpoint, error: errorMessage }
      });
    }

    return reachable;
  }
}
