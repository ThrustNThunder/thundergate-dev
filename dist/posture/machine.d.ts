/**
 * PostureStateMachine — reads WorldState, outputs how Jon should answer.
 *
 * Per the awareness analysis (§5, §7.6), Michael's state should change
 * Jon's posture *before* he composes a turn. The rule set:
 *
 *   1. Manual override (sticky) wins everything except urgent.
 *   2. Urgent tag → terse + urgent_only, never quiet.
 *   3. Quiet hours (23:00–08:00 ET) → quiet + minimal.
 *   4. Active device = phone → terse, normal.
 *   5. Inter-arrival < 30s (flurry) → terse, normal (batch if possible).
 *   6. Inter-arrival > 4h (gap) → full + deep, rebuild context.
 *   7. Tone trend = short → terse. Tone trend = long → full.
 *   8. Channel-type preference (phone-class → terse, browser → medium, etc.).
 *   9. Default → full, surface, normal.
 *
 * Each rule that fires contributes a one-line reason; the full reason
 * list lands in `PostureDecision.reasons` and is written to the
 * provenance ledger every time the decision changes.
 */
import { ChannelType } from '../channels/types.js';
import type { ActiveDevice, ToneTrend, WorldState } from '../world/state.js';
import type { ProvenanceLedger } from '../provenance/ledger.js';
export type PostureResponseShape = 'terse' | 'full' | 'minimal';
export type PostureDefaultMode = 'surface' | 'deep';
export type PostureNotificationPolicy = 'quiet' | 'normal' | 'urgent_only';
/**
 * Sticky manual override. `quiet` collapses to minimal+quiet, `full`
 * forces full responses regardless of other rules (except urgent), and
 * `normal` clears any prior override. `null` means no override active.
 */
export type PostureManualOverride = 'quiet' | 'full' | 'normal' | null;
export interface PostureDecision {
    response_shape: PostureResponseShape;
    default_mode: PostureDefaultMode;
    notification_policy: PostureNotificationPolicy;
    /** Ordered list of rule names that contributed (most-significant first). */
    reasons: string[];
    /** Override that was in effect when this decision was computed. */
    override: PostureManualOverride;
    /** Channel type the active surface was classified as. */
    channelType: ChannelType;
    /** Wall-clock ms when this decision was computed. */
    computedAt: number;
}
export interface PostureWorldInputs {
    /** Wall-clock ms. Injectable so tests can pin time without faking Date. */
    now: number;
    /** Timezone-aware hour for quiet-hours detection. Defaults to America/New_York if omitted. */
    localHour?: number;
    /** Detected active device class. */
    activeDevice?: ActiveDevice;
    /** Channel type the current turn is on. */
    activeChannel?: ChannelType | null;
    /** Milliseconds since the previous inbound, or null if first turn. */
    interArrivalMs?: number | null;
    /** Tone-trend bucket from recent inbound text-length stats. */
    toneTrend?: ToneTrend;
    /** Caller has marked this turn urgent (explicit /urgent, hot keyword, etc.). */
    urgentTag?: boolean;
}
/**
 * Sticky-override detector result. The runtime checks each inbound text
 * with `detectOverride()` and either applies the new override (and
 * clears it when Michael says "jon normal") or leaves the current value
 * alone.
 */
export type PostureOverrideTrigger = 'quiet' | 'full' | 'normal' | null;
export declare class PostureStateMachine {
    private provenance;
    private override;
    private overrideSetAt;
    private last;
    constructor(provenance?: ProvenanceLedger);
    /**
     * Returns the override implied by an inbound text, or null if none.
     * Recognizes case-insensitive variations of:
     *   - "jon go quiet" / "jon quiet mode" → 'quiet'
     *   - "jon full mode" / "jon go full"   → 'full'
     *   - "jon normal" / "jon clear posture"→ 'normal' (clears override)
     */
    detectOverride(text: string | undefined | null): PostureOverrideTrigger;
    /** Apply a manual override. `'normal'` clears any prior override. */
    setOverride(override: PostureManualOverride, actor?: string): PostureManualOverride;
    /** Returns the current override (or null). */
    getOverride(): PostureManualOverride;
    /** Returns the most recent decision (or null if never computed). */
    current(): PostureDecision | null;
    /**
     * Compute a posture decision from the supplied inputs. Pure: same
     * inputs → same outputs. Updates `last` and writes a provenance row
     * when the new decision changes any field vs. `last`.
     */
    compute(inputs: PostureWorldInputs): PostureDecision;
    /**
     * Convenience wrapper: copy posture-input fields off the supplied
     * WorldState and call `compute()`. Stamps the resulting decision
     * onto `world.posture` so consumers don't have to re-read.
     */
    computeFromWorld(world: WorldState, opts?: {
        now?: number;
        urgentTag?: boolean;
        localHour?: number;
    }): PostureDecision;
}
/**
 * Pure helper: returns the hour-of-day in America/New_York for the
 * given ms timestamp. Exported so tests can pin it without an Intl mock.
 */
export declare function easternHour(nowMs: number): number;
/**
 * Pure helper: classify a single inbound text by length into a
 * tone-trend bucket. The runtime maintains a rolling window — this is
 * the per-message classifier.
 */
export declare function classifyToneOfMessage(text: string): 'short' | 'long' | 'medium';
/**
 * Pure helper: collapse a window of recent classifications into a
 * `ToneTrend`. Window order doesn't matter; only the proportions do.
 */
export declare function rollupToneWindow(window: Array<'short' | 'long' | 'medium'>): ToneTrend;
