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

/**
 * A vault unlock request that has been emitted to a channel and is
 * waiting for the user's response. `mode` decides how the next inbound
 * is interpreted:
 *   - 'password'  : the entire message body is fed to VaultService.unlock
 *                   as the password.
 *   - 'biometric' : the message body must match an approval keyword
 *                   ('approve' | 'yes' | 'approved') — placeholder for
 *                   the LocalAuthentication signal Mack will wire on iOS.
 */
export interface PendingVaultRequest {
  request_id: string;
  channel: string;
  field_label: string;
  purpose: string;
  agent_id: string;
  user: string;
  mode: 'password' | 'biometric';
  ttl_ms: number;
  requested_at: number;
  expires_at: number;
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
  browserPageTitle: string = '';
  browserPortalState: string | null = null;
  browserLastActionAt: number | null = null;

  /**
   * Vault unlock requests currently awaiting a response, keyed by the
   * channel id that issued the prompt. Inbound traffic on the same
   * channel within the pending TTL is interpreted as the unlock answer
   * (password text on CLI/direct channels, 'approve' / 'yes' on
   * ThunderCommo as the biometric-stub placeholder). VaultProtocol
   * owns the lifecycle — runtime only reads.
   */
  pendingVaultRequests: Map<string, PendingVaultRequest> = new Map();

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
