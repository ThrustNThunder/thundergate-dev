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
export var ChannelType;
(function (ChannelType) {
    ChannelType["SLACK"] = "SLACK";
    ChannelType["THUNDERCOMMO"] = "THUNDERCOMMO";
    ChannelType["THUNDERBROWSER"] = "THUNDERBROWSER";
    ChannelType["CLI"] = "CLI";
    ChannelType["WHATSAPP"] = "WHATSAPP";
    ChannelType["UNKNOWN"] = "UNKNOWN";
})(ChannelType || (ChannelType = {}));
const PREFERENCES = {
    [ChannelType.SLACK]: { defaultShape: 'full', phoneClass: false },
    [ChannelType.THUNDERCOMMO]: { defaultShape: 'terse', phoneClass: true },
    [ChannelType.THUNDERBROWSER]: { defaultShape: 'medium', phoneClass: false },
    [ChannelType.CLI]: { defaultShape: 'terse', phoneClass: false },
    [ChannelType.WHATSAPP]: { defaultShape: 'terse', phoneClass: true },
    [ChannelType.UNKNOWN]: { defaultShape: 'full', phoneClass: false }
};
export function preferenceFor(t) {
    return PREFERENCES[t] ?? PREFERENCES[ChannelType.UNKNOWN];
}
