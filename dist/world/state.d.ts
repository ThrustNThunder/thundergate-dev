/**
 * WorldState — shared situational substrate.
 *
 * Per the awareness analysis (§1, §7.1), ThunderGate needs an in-memory
 * snapshot of facts that should change Jon's posture *before* he opens
 * his mouth. This is the stub the analysis called for: a single object
 * read by `processMessage` before composing a turn, and by Doctor when
 * deciding what to surface.
 *
 * Today this tracks:
 *   - `processingMode` + `localInference` liveness (cloud/local fork)
 *   - `activeChannel`, `activeDevice` (which surface Michael is on)
 *   - `interArrivalMs` (gap or flurry classification input)
 *   - `toneTrend` (recent inbound length pattern)
 *   - `lastInboundAt` (timestamp the posture machine uses to compute
 *     inter-arrival on the next turn)
 *
 * Posture decisions themselves live in `posture/machine.ts` and are
 * stamped here as `posture` on every recompute so consumers (CLI, Doctor,
 * Ghost snapshot) can read the latest decision without re-running the
 * rules.
 */
import { ChannelType } from '../channels/types.js';
import type { PostureDecision } from '../posture/machine.js';
export declare enum ProcessingMode {
    /** Cloud-routed (Anthropic / OpenAI). Cost-aware, conservative context. */
    CLOUD = "CLOUD",
    /** Local 70B / ThunderMind reachable. Unlock longer context, deeper RAG, background pre-processing. */
    LOCAL_INFERENCE = "LOCAL_INFERENCE"
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
/** Device-class hint. Drives terse-on-phone behavior in the posture state machine. */
export type ActiveDevice = 'phone' | 'laptop' | 'cli' | 'unknown';
/** Tone-trend bucket over the recent inbound window. */
export type ToneTrend = 'short' | 'long' | 'mixed';
export declare class WorldState {
    /** Current processing mode. */
    processingMode: ProcessingMode;
    /** Liveness of the local inference provider. */
    localInference: LocalInferenceLiveness;
    /** Which surface Michael is currently talking on. `null` until the first classified inbound lands. */
    activeChannel: ChannelType | null;
    /** Which device-class that surface implies. */
    activeDevice: ActiveDevice;
    /** Milliseconds since the previous inbound on any channel. */
    interArrivalMs: number | null;
    /** Wall-clock of the most recent inbound. */
    lastInboundAt: number | null;
    /** Rolling tone-trend bucket. Defaults to `mixed`. */
    toneTrend: ToneTrend;
    /** Latest posture decision the state machine produced. */
    posture: PostureDecision | null;
    /** Convenience: returns the mode the runtime should branch on. */
    effectiveMode(): ProcessingMode;
}
