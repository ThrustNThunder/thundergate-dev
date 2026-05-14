/**
 * WorldState — shared situational substrate.
 *
 * Per the awareness analysis (§1, §7.1), ThunderGate needs an in-memory
 * snapshot of facts that should change Jon's posture *before* he opens
 * his mouth. This is the stub the analysis called for: a single object
 * read by `processMessage` before composing a turn, and by Doctor when
 * deciding what to surface.
 *
 * Today this only tracks `processingMode` and the liveness of the local
 * inference provider — that's the minimum the dual-mode brief asked for.
 * Future fields (active device, network class, tone trend, peer liveness,
 * etc.) hang off this same object so consumers don't have to learn a new
 * substrate when each signal lands.
 */

export enum ProcessingMode {
  /** Cloud-routed (Anthropic / OpenAI). Cost-aware, conservative context. */
  CLOUD = 'CLOUD',
  /** Local 70B / ThunderMind reachable. Unlock longer context, deeper RAG, background pre-processing. */
  LOCAL_INFERENCE = 'LOCAL_INFERENCE'
}

export interface LocalInferenceLiveness {
  /** True if the last health check reached the endpoint AND it responded healthy. */
  reachable: boolean;
  /** Epoch ms of the most recent health check (success or failure). */
  lastCheckedAt: number | null;
  /** Epoch ms of the most recent successful health check. */
  lastReachableAt: number | null;
  /** Last error string, when the most recent check failed. */
  lastError: string | null;
  /** Endpoint URL the provider is configured to hit. */
  endpoint: string | null;
}

export class WorldState {
  /**
   * Current processing mode. Mutated by the runtime when the local
   * inference provider flips reachable/unreachable. Anything that wants
   * to fork behavior on local-vs-cloud reads this — not the provider
   * directly — so future overrides (manual pin, posture state machine)
   * land in one place.
   */
  processingMode: ProcessingMode = ProcessingMode.CLOUD;

  /**
   * Liveness of the local inference provider. Mirrors what the provider
   * itself reports, but lives on WorldState so consumers don't have to
   * thread the provider reference through every call site.
   */
  localInference: LocalInferenceLiveness = {
    reachable: false,
    lastCheckedAt: null,
    lastReachableAt: null,
    lastError: null,
    endpoint: null
  };

  /**
   * BrowserBridge liveness — mirrors what `src/browser/bridge.ts` knows
   * about the connected ThunderBrowser extension. Consumers (Doctor,
   * CLI, runtime planning) read these fields rather than reaching into
   * the bridge itself, so a non-running bridge degrades to "no browser
   * connected" without anyone needing a reference.
   */
  browserConnected: boolean = false;
  browserCurrentUrl: string = '';
  browserPortalState: string | null = null;
  browserLastActionAt: number | null = null;

  /**
   * Convenience: returns the mode the runtime should branch on. Kept as a
   * method (not just a field) so future logic — manual override pins,
   * cost-budget kill-switch, etc. — can hook in without every caller
   * changing.
   */
  effectiveMode(): ProcessingMode {
    return this.processingMode;
  }
}
