/**
 * PostureStateMachine — reads WorldState, outputs how Jon should answer.
 *
 * Per the awareness analysis (§5, §7.6), Michael's state should change
 * Jon's posture *before* he composes a turn. Rule order is significant —
 * see the d.ts header for the full list. Each rule that fires appends a
 * one-line reason so the provenance ledger can answer "why is Jon
 * terse right now?" without grepping logs.
 */
import { ChannelType, preferenceFor } from '../channels/types.js';
// Quiet-hours window, local-time. Inclusive lower bound, exclusive upper.
//   23:00 ≤ hour <  8:00 (next day) → quiet.
const QUIET_HOUR_START = 23;
const QUIET_HOUR_END = 8;
// Inter-arrival thresholds (ms).
const FLURRY_MAX_MS = 30 * 1000;
const GAP_MIN_MS = 4 * 60 * 60 * 1000;
// Message-length buckets for tone classification (characters).
const SHORT_MAX_CHARS = 80;
const LONG_MIN_CHARS = 280;
export function easternHour(nowMs) {
    // Intl gives us TZ-aware hour without pulling in a date library. We ask
    // for a 24-hour formatter pinned to America/New_York so DST is handled.
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        hour12: false
    });
    const parts = fmt.formatToParts(new Date(nowMs));
    const h = parts.find((p) => p.type === 'hour');
    const n = h ? Number(h.value) : NaN;
    // Intl can produce "24" for midnight in some locales — normalize that
    // back to 0 so the quiet-hours math is uniform.
    return Number.isFinite(n) ? (n === 24 ? 0 : n) : new Date(nowMs).getUTCHours();
}
export function classifyToneOfMessage(text) {
    const trimmed = (text ?? '').trim();
    if (trimmed.length <= SHORT_MAX_CHARS)
        return 'short';
    if (trimmed.length >= LONG_MIN_CHARS)
        return 'long';
    return 'medium';
}
export function rollupToneWindow(window) {
    if (window.length === 0)
        return 'mixed';
    let s = 0;
    let l = 0;
    for (const c of window) {
        if (c === 'short')
            s++;
        else if (c === 'long')
            l++;
    }
    // ≥60% of the window in one bucket counts as a trend; otherwise mixed.
    const threshold = Math.max(1, Math.ceil(window.length * 0.6));
    if (s >= threshold)
        return 'short';
    if (l >= threshold)
        return 'long';
    return 'mixed';
}
const OVERRIDE_PATTERNS = [
    { trigger: 'quiet', re: /\bjon[\s,]+(go\s+)?quiet(\s+mode)?\b/i },
    { trigger: 'full', re: /\bjon[\s,]+(go\s+)?full(\s+mode)?\b/i },
    { trigger: 'normal', re: /\bjon[\s,]+(normal|clear\s+posture|posture\s+clear)\b/i }
];
export class PostureStateMachine {
    provenance;
    override = null;
    overrideSetAt = null;
    last = null;
    constructor(provenance) {
        this.provenance = provenance;
    }
    detectOverride(text) {
        if (!text)
            return null;
        for (const p of OVERRIDE_PATTERNS) {
            if (p.re.test(text))
                return p.trigger;
        }
        return null;
    }
    setOverride(override, actor = 'michael') {
        const prev = this.override;
        // 'normal' is the sentinel that clears the override. Storing it as
        // null keeps the rule branches in compute() simple (one nullish
        // check instead of three string compares).
        const next = override === 'normal' ? null : override;
        if (prev === next)
            return prev;
        this.override = next;
        this.overrideSetAt = next === null ? null : Date.now();
        if (this.provenance) {
            this.provenance.append({
                actor,
                action: next === null ? 'posture_override_cleared' : 'posture_override_set',
                target: 'posture',
                reason: next === null
                    ? 'manual override cleared via jon normal'
                    : `manual override set to ${next}`,
                data: { previous: prev, next }
            });
        }
        return next;
    }
    getOverride() {
        return this.override;
    }
    current() {
        return this.last;
    }
    compute(inputs) {
        const reasons = [];
        const now = inputs.now;
        const localHour = inputs.localHour ?? easternHour(now);
        const inQuietHours = localHour >= QUIET_HOUR_START || localHour < QUIET_HOUR_END;
        const channel = inputs.activeChannel ?? ChannelType.UNKNOWN;
        const pref = preferenceFor(channel);
        // Start from per-channel defaults so a quiet path with no other
        // signal still lands on a sensible shape for the surface.
        let response_shape = pref.defaultShape === 'medium'
            ? 'full'
            : pref.defaultShape;
        let default_mode = 'surface';
        let notification_policy = 'normal';
        // Track which rule "owns" each field — later high-priority rules
        // overwrite earlier ones, and we record what changed in `reasons`.
        const apply = (label, patch) => {
            reasons.push(label);
            if (patch.response_shape !== undefined)
                response_shape = patch.response_shape;
            if (patch.default_mode !== undefined)
                default_mode = patch.default_mode;
            if (patch.notification_policy !== undefined)
                notification_policy = patch.notification_policy;
        };
        // Rule 8 (lowest non-default priority): channel-type preference.
        // Already baked into the initial response_shape above; record it
        // so reasons[] tells the full story even on the boring path.
        apply(`channel:${channel.toLowerCase()}_default(${pref.defaultShape})`, {});
        // Rule 7: tone-trend mirroring.
        if (inputs.toneTrend === 'short') {
            apply('tone_trend:short→terse', { response_shape: 'terse' });
        }
        else if (inputs.toneTrend === 'long') {
            apply('tone_trend:long→full', { response_shape: 'full' });
        }
        // Rule 6: gap → rebuild context.
        if (inputs.interArrivalMs !== undefined && inputs.interArrivalMs !== null && inputs.interArrivalMs > GAP_MIN_MS) {
            apply(`inter_arrival:>${(GAP_MIN_MS / 3600000).toFixed(0)}h→full+deep`, {
                response_shape: 'full',
                default_mode: 'deep'
            });
        }
        // Rule 5: flurry → terse, batch if possible.
        if (inputs.interArrivalMs !== undefined && inputs.interArrivalMs !== null && inputs.interArrivalMs >= 0 && inputs.interArrivalMs < FLURRY_MAX_MS) {
            apply(`inter_arrival:<${FLURRY_MAX_MS / 1000}s_flurry→terse`, { response_shape: 'terse' });
        }
        // Rule 4: phone surface → terse.
        if (inputs.activeDevice === 'phone' || pref.phoneClass) {
            apply('active_device:phone→terse', { response_shape: 'terse' });
        }
        // Rule 3: quiet hours.
        if (inQuietHours) {
            apply(`quiet_hours(${QUIET_HOUR_START}:00-${QUIET_HOUR_END}:00 ET)→minimal+quiet`, {
                response_shape: 'minimal',
                notification_policy: 'quiet'
            });
        }
        // Rule 2: urgent tag — overrides quiet hours' notification_policy
        // and forces terse-but-allowed. Keeps response shape readable on
        // glance: terse is the right call on alert.
        if (inputs.urgentTag) {
            apply('urgent_tag→terse+urgent_only', {
                response_shape: 'terse',
                notification_policy: 'urgent_only'
            });
        }
        // Rule 1: manual override wins almost everything.
        if (this.override === 'quiet') {
            apply('override:quiet→minimal+quiet', {
                response_shape: 'minimal',
                notification_policy: inputs.urgentTag ? 'urgent_only' : 'quiet'
            });
        }
        else if (this.override === 'full') {
            apply('override:full→full', { response_shape: 'full' });
        }
        const decision = {
            response_shape,
            default_mode,
            notification_policy,
            reasons,
            override: this.override,
            channelType: channel,
            computedAt: now
        };
        // Provenance: only write when the decision changed (or first
        // compute). Posture is recomputed every inbound — silent
        // unchanged turns shouldn't bloat the ledger.
        if (this.provenance && this.didChange(this.last, decision)) {
            this.provenance.append({
                timestamp: now,
                actor: 'posture',
                action: 'posture_recomputed',
                target: 'posture',
                reason: reasons[reasons.length - 1] ?? 'default',
                data: {
                    response_shape,
                    default_mode,
                    notification_policy,
                    override: this.override,
                    channelType: channel,
                    reasons
                }
            });
        }
        this.last = decision;
        return decision;
    }
    computeFromWorld(world, opts) {
        const now = opts?.now ?? Date.now();
        const decision = this.compute({
            now,
            localHour: opts?.localHour,
            activeDevice: world.activeDevice,
            activeChannel: world.activeChannel,
            interArrivalMs: world.interArrivalMs,
            toneTrend: world.toneTrend,
            urgentTag: opts?.urgentTag
        });
        // Stamp the decision onto WorldState so CLI / Doctor / Ghost
        // snapshot can read the latest without re-running the rules.
        world.posture = decision;
        return decision;
    }
    didChange(prev, next) {
        if (!prev)
            return true;
        return (prev.response_shape !== next.response_shape ||
            prev.default_mode !== next.default_mode ||
            prev.notification_policy !== next.notification_policy ||
            prev.override !== next.override ||
            prev.channelType !== next.channelType);
    }
}
