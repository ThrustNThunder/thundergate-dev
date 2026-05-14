/**
 * ChannelTypeRegistry — pattern-based mapping from raw channel/session
 * keys to typed `ChannelType` values.
 *
 * Why this exists: bridges and adapters identify themselves with strings
 * like `thundercommo:tnt`, `slack:C0123`, `browser:peer-7`, or `cli`. The
 * runtime, posture machine, and frame manager all want a single typed
 * value (`ChannelType.THUNDERCOMMO`) to branch on. This registry is the
 * one place that knows the regex shape of each surface.
 */
import { ChannelType } from './types.js';
const DEFAULT_MATCHERS = [
    {
        type: ChannelType.THUNDERCOMMO,
        match: /^(thundercommo|tc[-:]|tnt\b|relay\b)/i,
        label: 'ThunderCommo (relay / iOS)'
    },
    {
        type: ChannelType.THUNDERBROWSER,
        match: /^(browser|thunderbrowser|tb[-:])/i,
        label: 'ThunderBrowser (extension)'
    },
    {
        type: ChannelType.SLACK,
        match: /^(slack[-:]|slack$|C[0-9A-Z]{8,}$)/,
        label: 'Slack'
    },
    {
        type: ChannelType.WHATSAPP,
        match: /^(whatsapp[-:]|whatsapp$|wa[-:])/i,
        label: 'WhatsApp'
    },
    {
        type: ChannelType.CLI,
        match: /^(cli[-:]?|tui\b|local\b)/i,
        label: 'CLI / TUI'
    }
];
export class ChannelTypeRegistry {
    matchers;
    constructor(matchers = DEFAULT_MATCHERS) {
        // Copy so callers can't mutate our internal list, and so register()
        // can unshift without touching the shared module-level default.
        this.matchers = [...matchers];
    }
    classify(rawKey) {
        if (!rawKey)
            return ChannelType.UNKNOWN;
        const key = String(rawKey).trim();
        if (!key)
            return ChannelType.UNKNOWN;
        for (const m of this.matchers) {
            if (m.match.test(key))
                return m.type;
        }
        return ChannelType.UNKNOWN;
    }
    register(matcher) {
        // Unshift so a later, more-specific matcher (e.g. plugin override)
        // wins over earlier defaults without removing them.
        this.matchers.unshift(matcher);
    }
    list() {
        return this.matchers;
    }
}
export const defaultChannelTypeRegistry = new ChannelTypeRegistry();
