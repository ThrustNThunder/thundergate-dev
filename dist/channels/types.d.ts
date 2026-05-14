/**
 * Channel types — first-class identity for the surface a turn rides on.
 *
 * Per Michael's brief: "Seamless. Quick. Native. Same code type. No
 * translation layer." Every inbound message gets a `channelType` tag so
 * the runtime, posture state machine, and frame manager can reason about
 * the surface without scattered string-sniffing.
 *
 * Keep this enum closed: adding a new surface means adding a value here
 * and a mapping entry in `registry.ts`. No "OTHER" escape hatch — if a
 * channel doesn't fit, that's a brief, not a runtime branch.
 */
export declare enum ChannelType {
    SLACK = "SLACK",
    THUNDERCOMMO = "THUNDERCOMMO",
    THUNDERBROWSER = "THUNDERBROWSER",
    CLI = "CLI",
    WHATSAPP = "WHATSAPP",
    UNKNOWN = "UNKNOWN"
}
/**
 * Surface-shape hint each channel type prefers by default. The posture
 * state machine reads this when nothing else (override, quiet hours,
 * flurry, tone trend) has spoken first.
 */
export interface ChannelPreference {
    /** Reply shape this surface tends to want when posture is otherwise neutral. */
    defaultShape: 'terse' | 'medium' | 'full';
    /** Is this surface phone-class (limited keyboard, glance-read)? */
    phoneClass: boolean;
}
export declare function preferenceFor(t: ChannelType): ChannelPreference;
